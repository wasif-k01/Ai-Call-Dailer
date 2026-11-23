import { Router, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";

/** Call history, live calls, call detail, recordings and transcripts (read side). */
export const historyRouter = Router();
export const recordingsRouter = Router();
export const transcriptsRouter = Router();
for (const r of [historyRouter, recordingsRouter, transcriptsRouter]) r.use(requireAuth);

const ACTIVE = ["initiated", "queued", "ringing", "in_progress"];

const Filters = z.object({
  q: z.string().trim().max(60).default(""),
  mode: z.enum(["all", "human", "ai"]).default("all"),
  status: z.enum(["all", "completed", "busy", "no_answer", "failed", "canceled", "in_progress", "ringing", "queued", "initiated"]).default("all"),
  agentId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

function buildWhere(orgId: string, f: z.infer<typeof Filters>) {
  const params: unknown[] = [orgId];
  const where = ["c.org_id = $1"];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.includes("$") ? sql : sql.replace("?", `$${params.length}`));
  };
  if (f.q) add("(c.to_number LIKE ? OR c.from_number LIKE ?)".replaceAll("?", `$${params.length + 1}`), `%${f.q.replace(/[^\d+]/g, "") || "~"}%`);
  if (f.mode !== "all") add("c.mode = ?", f.mode);
  if (f.status !== "all") add("c.status = ?", f.status);
  if (f.agentId) add("c.ai_agent_id = ?", f.agentId);
  if (f.campaignId) add("c.campaign_id = ?", f.campaignId);
  if (f.from) add("c.started_at >= ?::date", f.from);
  if (f.to) add("c.started_at < (?::date + 1)", f.to);
  return { where: where.join(" AND "), params };
}

const LIST_COLS = `c.id, c.mode, c.status, c.direction, c.from_number, c.to_number, c.to_country_iso, c.started_at, c.answered_at, c.ended_at,
  c.duration_sec, c.error_code, c.error_message, c.estimated_cost_usd::float, c.actual_cost_usd::float, c.ai_cost_usd::float, c.cost_status, c.recording_enabled,
  a.name AS agent_name, cp.name AS campaign_name, u.full_name AS user_name,
  (SELECT count(*)::int FROM call_recordings r WHERE r.call_id = c.id AND r.status = 'completed') AS recording_count,
  (SELECT count(*)::int FROM call_transcripts t WHERE t.call_id = c.id) AS transcript_count`;
const LIST_FROM = `calls c LEFT JOIN ai_agents a ON a.id = c.ai_agent_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN users u ON u.id = c.user_id`;

historyRouter.get("/", requirePermission("calls:view"), async (req, res) => {
  const f = Filters.parse(req.query);
  const { where, params } = buildWhere(req.user!.orgId, f);
  const total = await query(`SELECT count(*)::int n FROM calls c WHERE ${where}`, params);
  const { rows } = await query(
    `SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE ${where} ORDER BY c.started_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    params,
  );
  res.json({ calls: rows, total: total.rows[0].n, page: f.page, pageSize: f.pageSize });
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection (except phone numbers below)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

historyRouter.get("/export.csv", requirePermission("calls:view"), async (req, res) => {
  const f = Filters.parse({ ...req.query, page: 1, pageSize: 100 });
  const { where, params } = buildWhere(req.user!.orgId, f);
  const { rows } = await query(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE ${where} ORDER BY c.started_at DESC LIMIT 10000`, params);
  const header = ["Call ID", "Started", "Ended", "Mode", "Status", "From", "To", "Country", "Duration (s)", "AI Agent", "Campaign", "User", "Recorded", "Error", "Estimated cost (USD)"];
  const lines = rows.map((r) =>
    [r.id, r.started_at, r.ended_at, r.mode, r.status, r.from_number, r.to_number, r.to_country_iso, r.duration_sec, r.agent_name, r.campaign_name, r.user_name, r.recording_count ? "yes" : "no", r.error_message, r.estimated_cost_usd]
      .map((v, i) => (i === 5 || i === 6 ? (v ? `"${v}"` : "") : csvCell(v)))
      .join(","),
  );
  await audit(req, "calls.exported", { metadata: { rows: rows.length } });
  res
    .type("text/csv; charset=utf-8")
    .attachment(`call-history-${new Date().toISOString().slice(0, 10)}.csv`)
    .send("﻿" + [header.join(","), ...lines].join("\r\n"));
});

historyRouter.get("/live", requirePermission("calls:view"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${LIST_COLS}, (c.metadata->>'onHold')::boolean AS on_hold, (c.metadata->>'agentMuted')::boolean AS agent_muted
       FROM ${LIST_FROM}
      WHERE c.org_id = $1 AND c.status = ANY($2) AND c.started_at > now() - interval '4 hours'
      ORDER BY c.started_at DESC`,
    [req.user!.orgId, ACTIVE],
  );
  res.json({ calls: rows });
});

historyRouter.get("/:id/detail", requirePermission("calls:view"), async (req, res) => {
  const orgId = req.user!.orgId;
  const { rows } = await query(`SELECT ${LIST_COLS}, c.metadata->'aiUsage' AS ai_usage FROM ${LIST_FROM} WHERE c.id = $1 AND c.org_id = $2`, [String(req.params.id), orgId]);
  const call = rows[0];
  if (!call) throw notFound("Call not found.");
  const [events, transcript, recordings] = await Promise.all([
    query("SELECT event_type, payload, created_at FROM call_events WHERE call_id = $1 ORDER BY id", [call.id]),
    query("SELECT speaker, text, created_at FROM call_transcripts WHERE call_id = $1 ORDER BY id", [call.id]),
    query("SELECT id, duration_sec, channels, source, created_at FROM call_recordings WHERE call_id = $1 AND status = 'completed' ORDER BY created_at", [call.id]),
  ]);
  res.json({ call, events: events.rows, transcript: transcript.rows, recordings: recordings.rows });
});

// ───────────── Recordings ─────────────
recordingsRouter.get("/", requirePermission("calls:view"), async (req, res) => {
  const { page } = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const total = await query("SELECT count(*)::int n FROM call_recordings WHERE org_id = $1 AND status = 'completed'", [req.user!.orgId]);
  const { rows } = await query(
    `SELECT r.id, r.duration_sec, r.created_at, r.channels, c.id AS call_id, c.mode, c.to_number, c.from_number, c.started_at, a.name AS agent_name
       FROM call_recordings r JOIN calls c ON c.id = r.call_id LEFT JOIN ai_agents a ON a.id = c.ai_agent_id
      WHERE r.org_id = $1 AND r.status = 'completed'
      ORDER BY r.created_at DESC LIMIT 25 OFFSET ${(page - 1) * 25}`,
    [req.user!.orgId],
  );
  res.json({ recordings: rows, total: total.rows[0].n, page });
});

/**
 * Streams the audio from Twilio through the API after a permission check, so recordings never
 * have a public URL. Range requests are forwarded so the player can seek.
 */
recordingsRouter.get("/:id/audio", requirePermission("calls:view"), async (req, res: Response) => {
  const orgId = req.user!.orgId;
  const { rows } = await query("SELECT provider_recording_sid FROM call_recordings WHERE id = $1 AND org_id = $2 AND status = 'completed'", [String(req.params.id), orgId]);
  if (!rows[0]) throw notFound("Recording not found.");
  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Twilio isn't connected.");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Recordings/${rows[0].provider_recording_sid}.mp3`;
  const upstream = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  });
  if (!upstream.ok || !upstream.body) throw badRequest(upstream.status === 404 ? "This recording no longer exists in Twilio." : "Couldn't load the recording from Twilio.");
  res.status(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (req.query.download) res.attachment(`recording-${req.params.id}.mp3`);
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
});

recordingsRouter.delete("/:id", requirePermission("campaigns:manage"), async (req, res) => {
  const orgId = req.user!.orgId;
  const { rows } = await query("SELECT provider_recording_sid, call_id FROM call_recordings WHERE id = $1 AND org_id = $2", [String(req.params.id), orgId]);
  if (!rows[0]) throw notFound("Recording not found.");
  const creds = await twilioCredsFor(orgId);
  if (creds) {
    try {
      await twilioClient(creds).recordings(rows[0].provider_recording_sid).remove();
    } catch (err: any) {
      if (err?.status !== 404) throw badRequest("Twilio couldn't delete the recording. Try again.");
    }
  }
  await query("DELETE FROM call_recordings WHERE id = $1", [String(req.params.id)]);
  await audit(req, "recording.deleted", { entityType: "call", entityId: rows[0].call_id });
  res.json({ ok: true });
});

// ───────────── Transcripts ─────────────
transcriptsRouter.get("/", requirePermission("calls:view"), async (req, res) => {
  const { q, page } = z.object({ q: z.string().trim().max(100).default(""), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const params: unknown[] = [req.user!.orgId];
  let match = "";
  if (q) {
    params.push(q);
    match = `AND EXISTS (SELECT 1 FROM call_transcripts t2 WHERE t2.call_id = c.id AND to_tsvector('simple', t2.text) @@ plainto_tsquery('simple', $2))`;
  }
  const { rows } = await query(
    `SELECT c.id, c.mode, c.to_number, c.started_at, c.duration_sec, c.status, a.name AS agent_name,
            (SELECT count(*)::int FROM call_transcripts t WHERE t.call_id = c.id) AS segments,
            ${q ? `(SELECT string_agg(t3.text, ' … ') FROM (SELECT text FROM call_transcripts t4 WHERE t4.call_id = c.id AND to_tsvector('simple', t4.text) @@ plainto_tsquery('simple', $2) LIMIT 2) t3)` : `(SELECT text FROM call_transcripts t5 WHERE t5.call_id = c.id ORDER BY id LIMIT 1)`} AS snippet
       FROM calls c LEFT JOIN ai_agents a ON a.id = c.ai_agent_id
      WHERE c.org_id = $1 AND EXISTS (SELECT 1 FROM call_transcripts t WHERE t.call_id = c.id) ${match}
      ORDER BY c.started_at DESC LIMIT 25 OFFSET ${(page - 1) * 25}`,
    params,
  );
  res.json({ calls: rows, page });
});

transcriptsRouter.get("/:callId.txt", requirePermission("calls:view"), async (req, res) => {
  const orgId = req.user!.orgId;
  const { rows: c } = await query("SELECT to_number, started_at FROM calls WHERE id = $1 AND org_id = $2", [String(req.params.callId), orgId]);
  if (!c[0]) throw notFound("Call not found.");
  const { rows } = await query("SELECT speaker, text, created_at FROM call_transcripts WHERE call_id = $1 ORDER BY id", [String(req.params.callId)]);
  const who = (s: string) => (s === "ai" ? "AI" : s === "caller" ? "Caller" : s);
  const body = [`Call to ${c[0].to_number} on ${new Date(c[0].started_at).toISOString()}`, "", ...rows.map((r) => `[${new Date(r.created_at).toISOString().slice(11, 19)}] ${who(r.speaker)}: ${r.text}`)].join("\n");
  res.type("text/plain; charset=utf-8").attachment(`transcript-${req.params.callId}.txt`).send(body);
});
