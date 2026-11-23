import { query } from "../../db/pool.js";
import { AppError, badRequest } from "../../lib/errors.js";
import { getAgent } from "../ai/agents.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { getIntegration, twilioCredsFor } from "../integrations/store.js";
import { assertPublicUrl, publicUrl } from "../voice/twiml-app.js";
import { assertCountryAllowed, assertNotOnDnc, normalizeNumber, resolveCallerId } from "./destination.js";
import { getCallView, logCallEvent } from "./service.js";
import { explainCallError } from "./twilio-errors.js";
import { spendBlocked } from "../usage/costs.js";

export interface PlaceAiCallInput {
  orgId: string;
  userId: string | null;
  to: string;
  defaultCountry?: string;
  fromNumberId?: string;
  agentId: string;
  instructions?: string;
  idempotencyKey: string;
  campaignId?: string;
  campaignContactId?: string;
}

/** Thrown when the org-wide AI concurrency cap is reached; campaigns treat it as "try again shortly". */
export class CapacityError extends AppError {
  constructor(message: string) {
    super(409, "capacity", message);
  }
}

/**
 * Places one AI call. Used by the AI Calling screen and by bulk campaigns, so both go
 * through exactly the same checks: OpenAI/Twilio connected, active agent, valid number,
 * Do Not Call list, caller ID, Geo Permissions, org-wide concurrency cap, idempotency.
 */
export async function placeAiCall(input: PlaceAiCallInput) {
  const { orgId } = input;
  const existing = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, input.idempotencyKey]);
  if (existing.rows[0]) return { call: await getCallView(orgId, existing.rows[0].id), duplicate: true };

  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  const openai = await getIntegration(orgId, "openai");
  if (openai?.status !== "connected") throw badRequest("Connect and test OpenAI first (Integrations & API Settings).");
  assertPublicUrl();

  const blocked = await spendBlocked(orgId);
  if (blocked)
    throw badRequest(`This month's spending limit ($${blocked.limit_usd}) has been reached, so new AI calls are blocked. The owner can raise the limit on the Usage & Costs page.`);

  const agent = await getAgent(orgId, input.agentId);
  if (!agent) throw badRequest("That AI agent doesn't exist.");
  if (!agent.is_active) throw badRequest("That AI agent is switched off. Activate it in AI Agents first.");

  const dest = normalizeNumber(input.to, input.defaultCountry);
  await assertNotOnDnc(orgId, dest.e164);
  const from = await resolveCallerId(orgId, input.fromNumberId);
  if (from.e164 === dest.e164) throw badRequest("You can't call the same number you're calling from.");
  try {
    await assertCountryAllowed(orgId, creds, dest.countryIso);
  } catch (err: any) {
    if (err?.status === 400) throw err;
    throw badRequest(explainCallError(err).message);
  }

  const cap = await query(
    `SELECT s.max_concurrent_ai_calls AS cap,
            (SELECT count(*)::int FROM calls WHERE org_id = $1 AND mode = 'ai'
               AND status IN ('initiated','queued','ringing','in_progress') AND started_at > now() - interval '2 hours') AS active
       FROM org_settings s WHERE s.org_id = $1`,
    [orgId],
  );
  if (cap.rows[0] && cap.rows[0].active >= cap.rows[0].cap)
    throw new CapacityError(`You already have ${cap.rows[0].active} AI call(s) running (limit ${cap.rows[0].cap}). Wait for one to finish.`);

  const { rows } = await query(
    `INSERT INTO calls (org_id, user_id, mode, from_number, to_number, to_country_iso, status, ai_agent_id, idempotency_key,
                        campaign_id, campaign_contact_id, metadata, recording_enabled)
     VALUES ($1,$2,'ai',$3,$4,$5,'initiated',$6,$7,$8,$9,$10,
             coalesce((SELECT recording_enabled FROM org_settings WHERE org_id = $1), false))
     ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`,
    [orgId, input.userId, from.e164, dest.e164, dest.countryIso, agent.id, input.idempotencyKey,
     input.campaignId ?? null, input.campaignContactId ?? null,
     { fromNumberId: from.id, extraInstructions: input.instructions ?? null }],
  );
  if (!rows[0]) {
    const again = await query(`SELECT id FROM calls WHERE org_id = $1 AND idempotency_key = $2`, [orgId, input.idempotencyKey]);
    return { call: await getCallView(orgId, again.rows[0].id), duplicate: true };
  }
  const callId = rows[0].id as string;
  const recording = (await query("SELECT recording_enabled FROM calls WHERE id = $1", [callId])).rows[0].recording_enabled as boolean;
  let twilioCall: { sid: string };
  try {
    twilioCall = await twilioClient(creds).calls.create({
      to: dest.e164,
      from: from.e164,
      url: publicUrl(`/webhooks/twilio/voice/ai?callId=${callId}`),
      method: "POST",
      statusCallback: publicUrl(`/webhooks/twilio/status?callId=${callId}`),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 30,
      timeLimit: agent.max_call_duration_sec + 30, // hard backstop; the bridge ends the call at the agent's limit
      ...(recording
        ? {
            record: true,
            recordingChannels: "dual", // caller and AI on separate channels
            recordingStatusCallback: publicUrl(`/webhooks/twilio/recording?callId=${callId}`),
            recordingStatusCallbackMethod: "POST",
            recordingStatusCallbackEvent: ["completed"],
          }
        : {}),
    });
  } catch (err) {
    const e = explainCallError(err);
    await query(
      "UPDATE calls SET status = 'failed', error_code = $2, error_message = $3, ended_at = now(), duration_sec = 0 WHERE id = $1",
      [callId, e.code, e.message],
    );
    throw Object.assign(badRequest(e.message), { callId });
  }
  // Outside the try: a database problem here must not be reported as a Twilio failure (the call is already placed).
  await query("UPDATE calls SET provider_call_sid = $2, status = 'queued', updated_at = now() WHERE id = $1", [callId, twilioCall.sid]);
  await logCallEvent(orgId, callId, "call.prepared", { to: dest.e164, from: from.e164, agentId: agent.id, campaignId: input.campaignId ?? null });
  return { call: await getCallView(orgId, callId), duplicate: false };
}

