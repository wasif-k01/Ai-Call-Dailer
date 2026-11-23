import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { publishEvent } from "../../realtime/events.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { estimateAiCost, pricesFor } from "./pricing.js";

const TERMINAL = ["completed", "busy", "no_answer", "failed", "canceled"];

/** Twilio reports a call's price a little after it ends (as a negative string, e.g. "-0.01300"). */
async function twilioLegPrice(creds: NonNullable<Awaited<ReturnType<typeof twilioCredsFor>>>, sid: string) {
  const c = await twilioClient(creds).calls(sid).fetch();
  if (c.price === null || c.price === undefined || c.price === "") return null;
  if (c.priceUnit && c.priceUnit.toUpperCase() !== "USD") return null;
  return Math.abs(Number(c.price));
}

/**
 * Works out a finished call's cost:
 *   telephony = actual price billed by Twilio for every leg (browser + phone for human calls)
 *   AI        = estimated from OpenAI token usage × list prices
 * Returns "retry" while Twilio hasn't priced the call yet.
 */
export async function computeCallCost(callId: string, { lastAttempt = false } = {}): Promise<"done" | "retry"> {
  const { rows } = await query("SELECT * FROM calls WHERE id = $1", [callId]);
  const call = rows[0];
  if (!call || !TERMINAL.includes(call.status) || call.cost_status === "final") return "done";
  const creds = await twilioCredsFor(call.org_id);

  const legs = [call.provider_call_sid, call.metadata?.browserCallSid].filter(Boolean) as string[];
  let telephony: number | null = null;
  let missing = false;
  if (creds) {
    for (const sid of legs) {
      try {
        const price = await twilioLegPrice(creds, sid);
        if (price === null) missing = true;
        else telephony = (telephony ?? 0) + price;
      } catch (err) {
        logger.warn({ err: (err as Error).message, callId }, "couldn't fetch Twilio call price");
        missing = true;
      }
    }
  } else missing = legs.length > 0;
  let ai: number | null = null;
  if (call.mode === "ai" && call.metadata?.aiUsage) {
    const prices = await pricesFor(call.org_id);
    ai = estimateAiCost(prices, call.metadata.aiModel ?? "gpt-realtime-2.1", call.metadata.aiUsage, call.metadata.transcribeModel ?? env.OPENAI_TRANSCRIBE_MODEL);
    // per-unit estimates on the usage rows too
    for (const [unit, qty] of Object.entries(call.metadata.aiUsage as Record<string, number>)) {
      const key = unit.startsWith("transcribe_") ? `${call.metadata.transcribeModel ?? env.OPENAI_TRANSCRIBE_MODEL}:${unit}` : `${call.metadata.aiModel ?? "gpt-realtime-2.1"}:${unit}`;
      const price = prices[key]?.usd;
      if (price !== undefined)
        await query("UPDATE usage_records SET estimated_cost_usd = $3 WHERE call_id = $1 AND unit = $2", [callId, unit, (qty * price) / 1_000_000]);
    }
  }

  if (missing && !lastAttempt) {
    // Twilio hasn't priced the call yet (this can take hours). Keep the AI estimate, try again later.
    await query(
      "UPDATE calls SET ai_cost_usd = $2, estimated_cost_usd = $3, cost_status = 'pending', updated_at = now() WHERE id = $1",
      [callId, ai, ai],
    );
    return "retry";
  }

  const status = missing ? (telephony !== null ? "partial" : "unavailable") : "final";
  const total = (telephony ?? 0) + (ai ?? 0);
  await query(
    `UPDATE calls SET telephony_cost_usd = $2, ai_cost_usd = $3, actual_cost_usd = $2, estimated_cost_usd = $4, cost_status = $5, updated_at = now()
      WHERE id = $1`,
    [callId, telephony, ai, telephony === null && ai === null ? null : total, status],
  );
  if (telephony !== null && !missing) {
    await query(
      `INSERT INTO usage_records (org_id, call_id, campaign_id, provider, category, quantity, unit, estimated_cost_usd, source)
       SELECT org_id, id, campaign_id, 'twilio', 'telephony', coalesce(duration_sec, 0), 'seconds', $2, 'provider' FROM calls WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM usage_records WHERE call_id = $1 AND provider = 'twilio')`,
      [callId, telephony],
    );
  }
  await checkSpendAlerts(call.org_id);
  return "done";
}

/**
 * Periodic sweep: re-checks finished calls that Twilio hadn't priced yet. A call is only
 * given up on ("unavailable") after 7 days.
 */
export async function sweepPendingCosts(limit = 200) {
  const { rows } = await query(
    `SELECT id, ended_at < now() - interval '7 days' AS give_up FROM calls
      WHERE cost_status <> 'final' AND status IN ('completed','busy','no_answer','failed','canceled')
        AND coalesce(ended_at, started_at) < now() - interval '2 minutes'
        AND coalesce(ended_at, started_at) > now() - interval '8 days'
      ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  let priced = 0;
  for (const r of rows) {
    try {
      if ((await computeCallCost(r.id, { lastAttempt: r.give_up })) === "done") priced++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, callId: r.id }, "cost sweep failed for call");
    }
  }
  return { checked: rows.length, priced };
}

export async function monthToDateSpend(orgId: string) {
  const { rows } = await query(
    `SELECT coalesce(sum(estimated_cost_usd), 0)::float AS spent FROM calls
      WHERE org_id = $1 AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [orgId],
  );
  return rows[0].spent as number;
}

export async function spendStatus(orgId: string) {
  const { rows } = await query(
    "SELECT monthly_spend_limit_usd::float AS limit_usd, spend_alert_threshold_pct AS threshold_pct, spend_limit_action AS action FROM org_settings WHERE org_id = $1",
    [orgId],
  );
  const s = rows[0] ?? { limit_usd: null, threshold_pct: 80, action: "alert" };
  const spent = await monthToDateSpend(orgId);
  const pct = s.limit_usd ? Math.round((spent / s.limit_usd) * 100) : null;
  return { ...s, spent, pct, overThreshold: pct !== null && pct >= s.threshold_pct, overLimit: pct !== null && pct >= 100 };
}

/** True when the owner chose to block new AI/bulk calls once the monthly limit is reached. */
export async function spendBlocked(orgId: string) {
  const s = await spendStatus(orgId);
  return s.action === "block" && s.overLimit ? s : null;
}

async function checkSpendAlerts(orgId: string) {
  const s = await spendStatus(orgId);
  for (const level of ["threshold", "limit"] as const) {
    if ((level === "threshold" && !s.overThreshold) || (level === "limit" && !s.overLimit)) continue;
    const { rowCount } = await query(
      `INSERT INTO spend_alerts (org_id, month, level, spent_usd) VALUES ($1, date_trunc('month', now())::date, $2, $3) ON CONFLICT DO NOTHING`,
      [orgId, level, s.spent],
    );
    if (rowCount) {
      await query("INSERT INTO audit_logs (org_id, action, metadata) VALUES ($1, $2, $3)", [orgId, `spend.alert.${level}`, { spent: s.spent, limit: s.limit_usd }]);
      await publishEvent({ orgId, type: "spend.alert", data: { level, spent: s.spent, limit: s.limit_usd, pct: s.pct } }).catch(() => {});
    }
  }
}
