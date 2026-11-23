import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { publishEvent } from "../../realtime/events.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { updateContactFromCall } from "../campaigns/engine.js";

export type CallStatus = "initiated" | "queued" | "ringing" | "in_progress" | "completed" | "busy" | "no_answer" | "failed" | "canceled";
export const TERMINAL: CallStatus[] = ["completed", "busy", "no_answer", "failed", "canceled"];
const RANK: Record<CallStatus, number> = { initiated: 0, queued: 1, ringing: 2, in_progress: 3, completed: 4, busy: 4, no_answer: 4, failed: 4, canceled: 4 };

/** Twilio CallStatus → our status. */
export function mapTwilioStatus(s: string): CallStatus | null {
  const m: Record<string, CallStatus> = {
    queued: "queued", initiated: "queued", ringing: "ringing", "in-progress": "in_progress", answered: "in_progress",
    completed: "completed", busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "canceled",
  };
  return m[s] ?? null;
}

export const conferenceName = (callId: string) => `acp-${callId}`;

const CALL_VIEW = `c.id, c.mode, c.status, c.from_number, c.to_number, c.to_country_iso, c.started_at, c.answered_at, c.ended_at,
  c.duration_sec, c.error_code, c.error_message, c.user_id, c.ai_agent_id, (c.metadata->>'onHold')::boolean AS on_hold`;

export async function getCallView(orgId: string, callId: string) {
  const { rows } = await query(`SELECT ${CALL_VIEW} FROM calls c WHERE c.id = $1 AND c.org_id = $2`, [callId, orgId]);
  return rows[0] ?? null;
}

async function emit(orgId: string, callId: string) {
  const call = await getCallView(orgId, callId);
  if (call) await publishEvent({ orgId, type: "call.updated", data: call }).catch((err) => logger.warn({ err }, "publish failed"));
}

export async function logCallEvent(orgId: string, callId: string, type: string, payload: Record<string, unknown>) {
  await query("INSERT INTO call_events (org_id, call_id, event_type, payload) VALUES ($1,$2,$3,$4)", [orgId, callId, type, payload]);
}

/**
 * Moves a call forward through its lifecycle. Out-of-order or duplicate webhooks
 * (Twilio retries, events racing) can never move a call backwards or reopen a finished call.
 */
export async function transitionCall(
  orgId: string,
  callId: string,
  next: CallStatus,
  extra: { durationSec?: number; errorCode?: string; errorMessage?: string; metadata?: Record<string, unknown> } = {},
): Promise<boolean> {
  const { rows } = await query("SELECT status FROM calls WHERE id = $1 AND org_id = $2", [callId, orgId]);
  const current = rows[0]?.status as CallStatus | undefined;
  if (!current || TERMINAL.includes(current) || RANK[next] < RANK[current] || (RANK[next] === RANK[current] && next === current)) {
    if (extra.metadata && current) await query("UPDATE calls SET metadata = metadata || $2 WHERE id = $1", [callId, extra.metadata]);
    return false;
  }
  await query(
    `UPDATE calls SET status = $3,
        answered_at = CASE WHEN $3 = 'in_progress' AND answered_at IS NULL THEN now() ELSE answered_at END,
        ended_at = CASE WHEN $4 THEN now() ELSE ended_at END,
        duration_sec = CASE WHEN $4 THEN coalesce($5, CASE WHEN answered_at IS NOT NULL THEN extract(epoch FROM now() - answered_at)::int ELSE 0 END) ELSE duration_sec END,
        error_code = coalesce($6, error_code), error_message = coalesce($7, error_message),
        metadata = metadata || $8, updated_at = now()
      WHERE id = $1 AND org_id = $2`,
    [callId, orgId, next, TERMINAL.includes(next), extra.durationSec ?? null, extra.errorCode ?? null, extra.errorMessage ?? null, extra.metadata ?? {}],
  );
  await emit(orgId, callId);
  await updateContactFromCall(callId).catch((err) => logger.warn({ err, callId }, "campaign contact update failed"));
  return true;
}

export async function setCallMetadata(orgId: string, callId: string, patch: Record<string, unknown>) {
  await query("UPDATE calls SET metadata = metadata || $3, updated_at = now() WHERE id = $1 AND org_id = $2", [callId, orgId, patch]);
  await emit(orgId, callId);
}

/** Ends every Twilio leg of a call that is still up. Safe to call more than once. */
export async function hangUpLegs(orgId: string, callId: string) {
  const { rows } = await query("SELECT provider_call_sid, status, metadata FROM calls WHERE id = $1 AND org_id = $2", [callId, orgId]);
  const call = rows[0];
  const creds = await twilioCredsFor(orgId);
  if (!call || !creds) return;
  const client = twilioClient(creds);
  const legs = [call.provider_call_sid, call.metadata?.browserCallSid].filter(Boolean) as string[];
  await Promise.all(
    legs.map((sid) =>
      client
        .calls(sid)
        .update({ status: call.status === "ringing" || call.status === "queued" ? "canceled" : "completed" })
        .catch(() => client.calls(sid).update({ status: "completed" }).catch(() => {})),
    ),
  );
}
