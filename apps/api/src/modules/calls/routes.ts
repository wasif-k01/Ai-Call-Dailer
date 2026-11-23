import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { assertPublicUrl, publicUrl } from "../voice/twiml-app.js";
import { assertCountryAllowed, assertNotOnDnc, normalizeNumber, resolveCallerId } from "./destination.js";
import { conferenceName, getCallView, hangUpLegs, logCallEvent, setCallMetadata, TERMINAL } from "./service.js";
import { explainCallError } from "./twilio-errors.js";
import { getAgent } from "../ai/agents.js";
import { getIntegration } from "../integrations/store.js";

const router = Router();
router.use(requireAuth);

const callLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  keyGenerator: (req) => req.user!.id,
  message: { error: { code: "rate_limited", message: "Too many calls in a short time. Wait a minute and try again." } },
});

const HumanCallSchema = z.object({
  to: z.string().trim().min(3).max(40),
  defaultCountry: z.string().length(2).optional(),
  fromNumberId: z.uuid().optional(),
  idempotencyKey: z.string().min(8).max(100),
});

/**
 * Step 1 of a browser call: validate everything and create the call record.
 * The browser then connects with the returned callId; Twilio's webhook uses it exactly once.
 */
router.post("/human", requirePermission("calls:make"), callLimiter, async (req, res) => {
  const body = HumanCallSchema.parse(req.body);
  const orgId = req.user!.orgId;

  const existing = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, body.idempotencyKey]);
  if (existing.rows[0]) return res.json({ call: await getCallView(orgId, existing.rows[0].id), duplicate: true });

  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  assertPublicUrl();

  const dest = normalizeNumber(body.to, body.defaultCountry);
  await assertNotOnDnc(orgId, dest.e164);
  const from = await resolveCallerId(orgId, body.fromNumberId);
  if (from.e164 === dest.e164) throw badRequest("You can't call the same number you're calling from.");
  try {
    await assertCountryAllowed(orgId, creds, dest.countryIso);
  } catch (err: any) {
    if (err?.status === 400) throw err;
    throw badRequest(explainCallError(err).message);
  }

  const active = await query(
    `SELECT 1 FROM calls WHERE org_id = $1 AND user_id = $2 AND mode = 'human'
        AND status IN ('initiated','queued','ringing','in_progress') AND started_at > now() - interval '4 hours'`,
    [orgId, req.user!.id],
  );
  if (active.rowCount) throw conflict("You already have a call in progress. Hang up first.");

  const { rows } = await query(
    `INSERT INTO calls (org_id, user_id, mode, from_number, to_number, to_country_iso, status, idempotency_key, metadata)
     VALUES ($1,$2,'human',$3,$4,$5,'initiated',$6,$7)
     ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`,
    [orgId, req.user!.id, from.e164, dest.e164, dest.countryIso, body.idempotencyKey, { fromNumberId: from.id }],
  );
  if (!rows[0]) {
    const again = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, body.idempotencyKey]);
    return res.json({ call: await getCallView(orgId, again.rows[0].id), duplicate: true });
  }
  await logCallEvent(orgId, rows[0].id, "call.prepared", { to: dest.e164, from: from.e164 });
  await audit(req, "call.human.started", { entityType: "call", entityId: rows[0].id, metadata: { country: dest.countryIso } });
  res.status(201).json({ call: await getCallView(orgId, rows[0].id) });
});

const AiCallSchema = z.object({
  to: z.string().trim().min(3).max(40),
  defaultCountry: z.string().length(2).optional(),
  fromNumberId: z.uuid().optional(),
  agentId: z.uuid(),
  instructions: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

/**
 * AI-to-Human: the server places the call through Twilio's REST API. When the person answers,
 * Twilio fetches /webhooks/twilio/voice/ai, which connects the call audio to the AI bridge.
 */
router.post("/ai", requirePermission("calls:make"), callLimiter, async (req, res) => {
  const body = AiCallSchema.parse(req.body);
  const orgId = req.user!.orgId;

  const existing = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, body.idempotencyKey]);
  if (existing.rows[0]) return res.json({ call: await getCallView(orgId, existing.rows[0].id), duplicate: true });

  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  const openai = await getIntegration(orgId, "openai");
  if (openai?.status !== "connected") throw badRequest("Connect and test OpenAI first (Integrations & API Settings).");
  assertPublicUrl();

  const agent = await getAgent(orgId, body.agentId);
  if (!agent) throw badRequest("That AI agent doesn't exist.");
  if (!agent.is_active) throw badRequest("That AI agent is switched off. Activate it in AI Agents first.");

  const dest = normalizeNumber(body.to, body.defaultCountry);
  await assertNotOnDnc(orgId, dest.e164);
  const from = await resolveCallerId(orgId, body.fromNumberId);
  if (from.e164 === dest.e164) throw badRequest("You can't call the same number you're calling from.");
  try {
    await assertCountryAllowed(orgId, creds, dest.countryIso);
  } catch (err: any) {
    if (err?.status === 400) throw err;
    throw badRequest(explainCallError(err).message);
  }

  // Safety cap on simultaneous AI calls for the whole organisation.
  const cap = await query(
    `SELECT s.max_concurrent_ai_calls AS cap,
            (SELECT count(*)::int FROM calls WHERE org_id = $1 AND mode = 'ai'
               AND status IN ('initiated','queued','ringing','in_progress') AND started_at > now() - interval '2 hours') AS active
       FROM org_settings s WHERE s.org_id = $1`,
    [orgId],
  );
  if (cap.rows[0] && cap.rows[0].active >= cap.rows[0].cap)
    throw conflict(`You already have ${cap.rows[0].active} AI call(s) running (limit ${cap.rows[0].cap}). Wait for one to finish.`);

  const { rows } = await query(
    `INSERT INTO calls (org_id, user_id, mode, from_number, to_number, to_country_iso, status, ai_agent_id, idempotency_key, metadata)
     VALUES ($1,$2,'ai',$3,$4,$5,'initiated',$6,$7,$8)
     ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`,
    [orgId, req.user!.id, from.e164, dest.e164, dest.countryIso, agent.id, body.idempotencyKey,
     { fromNumberId: from.id, extraInstructions: body.instructions ?? null }],
  );
  if (!rows[0]) {
    const again = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, body.idempotencyKey]);
    return res.json({ call: await getCallView(orgId, again.rows[0].id), duplicate: true });
  }
  const callId = rows[0].id as string;
  try {
    const call = await twilioClient(creds).calls.create({
      to: dest.e164,
      from: from.e164,
      url: publicUrl(`/webhooks/twilio/voice/ai?callId=${callId}`),
      method: "POST",
      statusCallback: publicUrl(`/webhooks/twilio/status?callId=${callId}`),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 30,
      timeLimit: agent.max_call_duration_sec + 30, // hard backstop; the bridge ends the call at the agent's limit
    });
    await query("UPDATE calls SET provider_call_sid = $2, status = 'queued', updated_at = now() WHERE id = $1", [callId, call.sid]);
  } catch (err) {
    const e = explainCallError(err);
    await query("UPDATE calls SET status = 'failed', error_code = $2, error_message = $3, ended_at = now(), duration_sec = 0 WHERE id = $1", [callId, e.code, e.message]);
    throw badRequest(e.message);
  }
  await logCallEvent(orgId, callId, "call.prepared", { to: dest.e164, from: from.e164, agentId: agent.id });
  await audit(req, "call.ai.started", { entityType: "call", entityId: callId, metadata: { country: dest.countryIso, agentId: agent.id } });
  res.status(201).json({ call: await getCallView(orgId, callId) });
});

/** Live transcript so far (for the call screen). */
router.get("/:id/transcript", requirePermission("calls:view"), async (req, res) => {
  const call = await getCallView(req.user!.orgId, String(req.params.id));
  if (!call) throw notFound("Call not found.");
  const { rows } = await query("SELECT speaker, text, created_at FROM call_transcripts WHERE call_id = $1 AND org_id = $2 ORDER BY id", [call.id, req.user!.orgId]);
  res.json({ segments: rows });
});

async function loadOwnCall(orgId: string, callId: string) {
  const { rows } = await query("SELECT id, status, mode, provider_call_sid, metadata FROM calls WHERE id = $1 AND org_id = $2", [callId, orgId]);
  if (!rows[0]) throw notFound("Call not found.");
  return rows[0];
}

router.get("/:id", requirePermission("calls:view"), async (req, res) => {
  const call = await getCallView(req.user!.orgId, String(req.params.id));
  if (!call) throw notFound("Call not found.");
  res.json({ call });
});

router.post("/:id/hangup", requirePermission("calls:make"), async (req, res) => {
  const call = await loadOwnCall(req.user!.orgId, String(req.params.id));
  if (!TERMINAL.includes(call.status)) await hangUpLegs(req.user!.orgId, call.id);
  await audit(req, "call.hangup", { entityType: "call", entityId: call.id });
  res.json({ ok: true });
});

router.post("/:id/hold", requirePermission("calls:make"), async (req, res) => {
  const { hold } = z.object({ hold: z.boolean() }).parse(req.body);
  const orgId = req.user!.orgId;
  const call = await loadOwnCall(orgId, String(req.params.id));
  if (call.mode !== "human") throw badRequest("Hold is only available on human calls.");
  if (call.status !== "in_progress" || !call.provider_call_sid) throw badRequest("You can only hold a call after it's answered.");
  const creds = (await twilioCredsFor(orgId))!;
  try {
    await twilioClient(creds)
      .conferences(conferenceName(call.id))
      .participants(call.provider_call_sid)
      .update(hold ? { hold: true, holdUrl: publicUrl(`/webhooks/twilio/hold?callId=${call.id}`), holdMethod: "POST" } : { hold: false });
  } catch (err: any) {
    throw badRequest(err?.status === 404 ? "The call has already ended." : explainCallError(err).message);
  }
  await setCallMetadata(orgId, call.id, { onHold: hold });
  await logCallEvent(orgId, call.id, hold ? "call.hold" : "call.unhold", {});
  res.json({ ok: true, onHold: hold });
});

/**
 * Keypad tones. Twilio doesn't document DTMF passing through conferences, so the tones are
 * played straight onto the recipient's line: the leg briefly plays the digits, then rejoins
 * the same conference. Batched by the browser to keep interruptions short.
 */
router.post("/:id/dtmf", requirePermission("calls:make"), async (req, res) => {
  const { digits } = z.object({ digits: z.string().regex(/^[0-9*#w]{1,32}$/, "Only 0-9, * and # are allowed.") }).parse(req.body);
  const orgId = req.user!.orgId;
  const call = await loadOwnCall(orgId, String(req.params.id));
  if (call.status !== "in_progress" || !call.provider_call_sid) throw badRequest("The keypad works once the call is answered.");
  if (call.metadata?.onHold) throw badRequest("Take the call off hold before using the keypad.");
  const creds = (await twilioCredsFor(orgId))!;
  const twiml = `<Response><Play digits="${digits}"/><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false">${conferenceName(call.id)}</Conference></Dial></Response>`;
  try {
    await twilioClient(creds).calls(call.provider_call_sid).update({ twiml });
  } catch (err) {
    throw badRequest(explainCallError(err).message);
  }
  await logCallEvent(orgId, call.id, "call.dtmf", { count: digits.replace(/w/g, "").length });
  res.json({ ok: true });
});

export default router;
