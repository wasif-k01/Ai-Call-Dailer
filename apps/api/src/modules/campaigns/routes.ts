import { Router } from "express";
import { z } from "zod";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { query, withTransaction } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { getAgent } from "../ai/agents.js";
import { getIntegration, markSetupStep, twilioCredsFor } from "../integrations/store.js";
import { assertPublicUrl } from "../voice/twiml-app.js";
import { getMaintenanceQueue } from "../../queues/index.js";
import { campaignLog, campaignStats } from "./engine.js";
import { cleanNumberInput } from "../calls/destination.js";

const router = Router();
router.use(requireAuth);

export const MAX_CONTACTS = 5000;

const RowSchema = z.object({ phone: z.string().max(60), name: z.string().max(120).optional().nullable(), extra: z.record(z.string(), z.string()).optional() });
const ValidateSchema = z.object({ rows: z.array(RowSchema).min(1).max(MAX_CONTACTS), defaultCountry: z.string().length(2) });

type RowResult = { index: number; input: string; name: string | null; e164: string | null; country: string | null; status: "valid" | "invalid" | "duplicate" | "dnc"; reason?: string; extra?: Record<string, string> };

/** Validates, normalises to E.164, de-duplicates and checks the Do Not Call list. */
async function validateRows(orgId: string, rows: z.infer<typeof RowSchema>[], defaultCountry: string): Promise<RowResult[]> {
  const seen = new Set<string>();
  const out: RowResult[] = rows.map((r, index) => {
    const input = r.phone.trim();
    const name = r.name?.trim() || null;
    const clean = cleanNumberInput(input);
    const p = parsePhoneNumberFromString(clean, clean.startsWith("+") ? undefined : (defaultCountry as CountryCode));
    if (!input) return { index, input, name, e164: null, country: null, status: "invalid", reason: "Empty" };
    if (!p || !p.isValid()) return { index, input, name, e164: null, country: null, status: "invalid", reason: "Not a valid phone number" };
    if (seen.has(p.number)) return { index, input, name, e164: p.number, country: p.country ?? null, status: "duplicate", reason: "Appears earlier in the list" };
    seen.add(p.number);
    return { index, input, name, e164: p.number, country: p.country ?? null, status: "valid", extra: r.extra };
  });
  const valid = out.filter((r) => r.status === "valid").map((r) => r.e164!);
  if (valid.length) {
    const dnc = await query("SELECT phone_e164 FROM do_not_call_list WHERE org_id = $1 AND phone_e164 = ANY($2)", [orgId, valid]);
    const blocked = new Set(dnc.rows.map((r) => r.phone_e164));
    for (const r of out) if (r.status === "valid" && blocked.has(r.e164)) Object.assign(r, { status: "dnc", reason: "On your Do Not Call list" });
  }
  return out;
}

router.post("/validate", requirePermission("campaigns:manage"), async (req, res) => {
  const body = ValidateSchema.parse(req.body);
  const results = await validateRows(req.user!.orgId, body.rows, body.defaultCountry.toUpperCase());
  const count = (s: RowResult["status"]) => results.filter((r) => r.status === s).length;
  res.json({ results, summary: { total: results.length, valid: count("valid"), invalid: count("invalid"), duplicate: count("duplicate"), dnc: count("dnc") } });
});

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const CampaignSchema = z.object({
  name: z.string().trim().min(2).max(100),
  agentId: z.uuid(),
  fromNumberId: z.uuid().optional(),
  instructions: z.string().trim().max(2000).optional(),
  callingHoursStart: time,
  callingHoursEnd: time,
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone"),
  maxConcurrent: z.number().int().min(1).max(10),
  maxRetries: z.number().int().min(0).max(5),
  retryDelayMin: z.number().int().min(5).max(1440),
  defaultCountry: z.string().length(2),
  rows: z.array(RowSchema).min(1).max(MAX_CONTACTS),
});

const CAMPAIGN_COLS = `c.id, c.name, c.status, c.ai_agent_id, a.name AS agent_name, c.from_number_id, p.e164 AS from_number, c.instructions,
  to_char(c.calling_hours_start, 'HH24:MI') AS calling_hours_start, to_char(c.calling_hours_end, 'HH24:MI') AS calling_hours_end,
  c.timezone, c.max_concurrent, c.max_retries, c.retry_delay_min, c.default_country, c.consent_confirmed, c.consent_confirmed_at,
  c.started_at, c.completed_at, c.stopped_at, c.created_at`;
const CAMPAIGN_FROM = `campaigns c LEFT JOIN ai_agents a ON a.id = c.ai_agent_id LEFT JOIN phone_numbers p ON p.id = c.from_number_id`;

async function loadCampaign(orgId: string, id: string) {
  const { rows } = await query(`SELECT ${CAMPAIGN_COLS} FROM ${CAMPAIGN_FROM} WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]);
  if (!rows[0]) throw notFound("Campaign not found.");
  return rows[0];
}

router.get("/", requirePermission("calls:view"), async (req, res) => {
  const { rows } = await query(`SELECT ${CAMPAIGN_COLS} FROM ${CAMPAIGN_FROM} WHERE c.org_id = $1 ORDER BY c.created_at DESC LIMIT 200`, [req.user!.orgId]);
  const withStats = await Promise.all(rows.map(async (c) => ({ ...c, stats: await campaignStats(c.id) })));
  res.json({ campaigns: withStats });
});

router.post("/", requirePermission("campaigns:manage"), async (req, res) => {
  const body = CampaignSchema.parse(req.body);
  const orgId = req.user!.orgId;
  const agent = await getAgent(orgId, body.agentId);
  if (!agent) throw badRequest("Choose an AI agent.");
  if (body.fromNumberId) {
    const n = await query("SELECT 1 FROM phone_numbers WHERE id = $1 AND org_id = $2 AND status = 'active'", [body.fromNumberId, orgId]);
    if (!n.rowCount) throw badRequest("That caller ID isn't available.");
  }
  // Re-validate on the server; never trust the browser's preview.
  const results = await validateRows(orgId, body.rows, body.defaultCountry.toUpperCase());
  const valid = results.filter((r) => r.status === "valid");
  if (!valid.length) throw badRequest("There are no valid numbers to call in this list.");

  const id = await withTransaction(async (cx) => {
    const { rows } = await cx.query(
      `INSERT INTO campaigns (org_id, name, ai_agent_id, from_number_id, instructions, calling_hours_start, calling_hours_end, timezone,
                              max_concurrent, max_retries, retry_delay_min, default_country, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [orgId, body.name, agent.id, body.fromNumberId ?? null, body.instructions || null, body.callingHoursStart, body.callingHoursEnd,
       body.timezone, body.maxConcurrent, body.maxRetries, body.retryDelayMin, body.defaultCountry.toUpperCase(), req.user!.id],
    );
    const campaignId = rows[0].id;
    // Contacts are saved to the address book as well (consent status unknown until confirmed).
    for (let i = 0; i < valid.length; i += 500) {
      const chunk = valid.slice(i, i + 500);
      const contacts = await cx.query(
        `INSERT INTO contacts (org_id, first_name, phone_e164)
         SELECT $1, n, p FROM unnest($2::text[], $3::text[]) AS t(n, p)
         ON CONFLICT (org_id, phone_e164) DO UPDATE SET first_name = coalesce(contacts.first_name, EXCLUDED.first_name)
         RETURNING id, phone_e164`,
        [orgId, chunk.map((r) => r.name), chunk.map((r) => r.e164)],
      );
      const idByPhone = new Map(contacts.rows.map((r) => [r.phone_e164, r.id]));
      await cx.query(
        `INSERT INTO campaign_contacts (org_id, campaign_id, contact_id, phone_e164, display_name, extra)
         SELECT $1, $2, c, p, n, e FROM unnest($3::uuid[], $4::text[], $5::text[], $6::jsonb[]) AS t(c, p, n, e)`,
        [orgId, campaignId, chunk.map((r) => idByPhone.get(r.e164!)), chunk.map((r) => r.e164), chunk.map((r) => r.name), chunk.map((r) => JSON.stringify(r.extra ?? {}))],
      );
    }
    return campaignId;
  });
  const skipped = results.length - valid.length;
  await campaignLog(orgId, id, "info", `Campaign created with ${valid.length} contact(s)${skipped ? `; ${skipped} row(s) skipped (invalid, duplicate or Do Not Call)` : ""}.`);
  await audit(req, "campaign.created", { entityType: "campaign", entityId: id, metadata: { contacts: valid.length, skipped } });
  res.status(201).json({ campaign: await loadCampaign(orgId, id), added: valid.length, skipped });
});

router.get("/:id", requirePermission("calls:view"), async (req, res) => {
  const c = await loadCampaign(req.user!.orgId, String(req.params.id));
  res.json({ campaign: c, stats: await campaignStats(c.id) });
});

const ListQuery = z.object({
  status: z.enum(["all", "pending", "queued", "calling", "answered", "completed", "no_answer", "busy", "failed", "opted_out"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

router.get("/:id/contacts", requirePermission("calls:view"), async (req, res) => {
  const c = await loadCampaign(req.user!.orgId, String(req.params.id));
  const q = ListQuery.parse(req.query);
  const where = q.status === "all" ? "" : "AND cc.status = $2";
  const params: unknown[] = [c.id];
  if (q.status !== "all") params.push(q.status);
  const total = await query(`SELECT count(*)::int n FROM campaign_contacts cc WHERE cc.campaign_id = $1 ${where}`, params);
  const { rows } = await query(
    `SELECT cc.id, cc.phone_e164, cc.display_name, cc.status, cc.attempts, cc.final, cc.last_attempt_at, cc.next_attempt_at, cc.last_error,
            cc.last_call_id, k.duration_sec
       FROM campaign_contacts cc LEFT JOIN calls k ON k.id = cc.last_call_id
      WHERE cc.campaign_id = $1 ${where}
      ORDER BY cc.updated_at DESC, cc.created_at
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    params,
  );
  res.json({ contacts: rows, total: total.rows[0].n, page: q.page, pageSize: q.pageSize });
});

router.get("/:id/logs", requirePermission("calls:view"), async (req, res) => {
  const c = await loadCampaign(req.user!.orgId, String(req.params.id));
  const { rows } = await query("SELECT level, message, created_at FROM campaign_logs WHERE campaign_id = $1 ORDER BY id DESC LIMIT 100", [c.id]);
  res.json({ logs: rows });
});

/** Remove a contact from a draft or paused campaign before it's called. */
router.delete("/:id/contacts/:contactId", requirePermission("campaigns:manage"), async (req, res) => {
  const c = await loadCampaign(req.user!.orgId, String(req.params.id));
  const { rowCount } = await query(
    "DELETE FROM campaign_contacts WHERE id = $1 AND campaign_id = $2 AND status = 'pending' AND attempts = 0",
    [String(req.params.contactId), c.id],
  );
  if (!rowCount) throw badRequest("Only contacts that haven't been called yet can be removed.");
  res.json({ ok: true });
});

/**
 * Start requires an explicit consent confirmation: the user confirms they have permission
 * (and any legal authorisation) to place automated calls to every number in the list.
 */
const StartSchema = z.object({
  consentConfirmed: z.literal(true, { error: "You must confirm you have consent to call these people." }),
  confirmContactCount: z.number().int(),
});

router.post("/:id/start", requirePermission("campaigns:manage"), async (req, res) => {
  const orgId = req.user!.orgId;
  const c = await loadCampaign(orgId, String(req.params.id));
  const body = StartSchema.parse(req.body);
  if (c.status !== "draft") throw badRequest(`This campaign is ${c.status}; only a draft can be started.`);
  const stats = await campaignStats(c.id);
  // Guard against starting the wrong list: the user must confirm the exact number of contacts.
  if (body.confirmContactCount !== stats.total) throw badRequest(`Type the number of contacts (${stats.total}) to confirm.`);
  if (!(await twilioCredsFor(orgId))) throw badRequest("Connect Twilio first.");
  if ((await getIntegration(orgId, "openai"))?.status !== "connected") throw badRequest("Connect and test OpenAI first.");
  assertPublicUrl();
  const agent = c.ai_agent_id ? await getAgent(orgId, c.ai_agent_id) : null;
  if (!agent?.is_active) throw badRequest("The campaign's AI agent is missing or switched off.");
  await query(
    `UPDATE campaigns SET status = 'running', consent_confirmed = true, consent_confirmed_by = $2, consent_confirmed_at = now(),
            started_at = now(), updated_at = now() WHERE id = $1`,
    [c.id, req.user!.id],
  );
  await markSetupStep(orgId, "bulk_enabled", { firstCampaign: c.id });
  await campaignLog(orgId, c.id, "info", `Started by ${req.user!.fullName}. Consent to call ${stats.total} contact(s) confirmed.`);
  await audit(req, "campaign.started", { entityType: "campaign", entityId: c.id, metadata: { contacts: stats.total } });
  await getMaintenanceQueue().add("campaign-tick", {}, { removeOnComplete: true, removeOnFail: 100 }).catch(() => {}); // start promptly
  res.json({ campaign: await loadCampaign(orgId, c.id) });
});

const TRANSITIONS = {
  pause: { from: ["running"], to: "paused", verb: "Paused" },
  resume: { from: ["paused"], to: "running", verb: "Resumed" },
  stop: { from: ["running", "paused"], to: "stopped", verb: "Stopped" },
} as const;

for (const [action, t] of Object.entries(TRANSITIONS)) {
  router.post(`/:id/${action}`, requirePermission("campaigns:manage"), async (req, res) => {
    const orgId = req.user!.orgId;
    const c = await loadCampaign(orgId, String(req.params.id));
    const { rowCount } = await query(
      `UPDATE campaigns SET status = $2, updated_at = now(), stopped_at = CASE WHEN $2 = 'stopped' THEN now() ELSE stopped_at END
        WHERE id = $1 AND status = ANY($3)`,
      [c.id, t.to, t.from],
    );
    if (!rowCount) throw conflict(`Can't ${action} a campaign that is ${c.status}.`);
    if (action === "stop")
      await query("UPDATE campaign_contacts SET status = 'pending', updated_at = now() WHERE campaign_id = $1 AND status = 'queued'", [c.id]);
    await campaignLog(orgId, c.id, "info", `${t.verb} by ${req.user!.fullName}.${action !== "resume" ? " Calls already in progress finish normally; no new calls start." : ""}`);
    await audit(req, `campaign.${action}`, { entityType: "campaign", entityId: c.id });
    if (action === "resume") await getMaintenanceQueue().add("campaign-tick", {}, { removeOnComplete: true, removeOnFail: 100 }).catch(() => {});
    res.json({ campaign: await loadCampaign(orgId, c.id) });
  });
}

router.delete("/:id", requirePermission("campaigns:manage"), async (req, res) => {
  const c = await loadCampaign(req.user!.orgId, String(req.params.id));
  if (c.status !== "draft") throw badRequest("Only draft campaigns can be deleted. Stop it instead; its call history is kept.");
  await query("DELETE FROM campaigns WHERE id = $1", [c.id]);
  await audit(req, "campaign.deleted", { entityType: "campaign", entityId: c.id });
  res.json({ ok: true });
});

export default router;
