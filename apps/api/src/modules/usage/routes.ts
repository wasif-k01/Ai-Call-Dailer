import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { computeCallCost, spendStatus } from "./costs.js";
import { DEFAULT_PRICES, PRICE_SOURCE, pricesFor } from "./pricing.js";

const router = Router();
router.use(requireAuth);

const Month = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .default(() => new Date().toISOString().slice(0, 7)),
});
const range = (month: string) => {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
};

router.get("/summary", requirePermission("usage:view"), async (req, res) => {
  const { month } = Month.parse(req.query);
  const { start, end } = range(month);
  const orgId = req.user!.orgId;
  const p = [orgId, start, end];
  const W = "org_id = $1 AND started_at >= $2 AND started_at < $3";
  const [totals, byMode, byCountry, byDay, tokens, campaigns, billed] = await Promise.all([
    query(
      `SELECT count(*)::int AS calls,
              coalesce(sum(duration_sec), 0)::int AS seconds,
              coalesce(sum(telephony_cost_usd), 0)::float AS telephony_usd,
              coalesce(sum(ai_cost_usd), 0)::float AS ai_usd,
              coalesce(sum(estimated_cost_usd), 0)::float AS total_usd,
              count(*) FILTER (WHERE cost_status = 'pending' AND status IN ('completed','busy','no_answer','failed','canceled'))::int AS pending_costs,
              count(*) FILTER (WHERE cost_status IN ('partial','unavailable'))::int AS incomplete_costs
         FROM calls WHERE ${W}`,
      p,
    ),
    query(
      `SELECT mode, count(*)::int AS calls, coalesce(sum(duration_sec), 0)::int AS seconds,
              coalesce(sum(estimated_cost_usd), 0)::float AS total_usd
         FROM calls WHERE ${W} GROUP BY mode`,
      p,
    ),
    query(
      `SELECT coalesce(to_country_iso, '??') AS country, count(*)::int AS calls, coalesce(sum(duration_sec), 0)::int AS seconds,
              coalesce(sum(telephony_cost_usd), 0)::float AS telephony_usd
         FROM calls WHERE ${W} GROUP BY 1 ORDER BY telephony_usd DESC, calls DESC`,
      p,
    ),
    query(
      `SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS calls,
              coalesce(sum(estimated_cost_usd), 0)::float AS total_usd
         FROM calls WHERE ${W} GROUP BY 1 ORDER BY 1`,
      p,
    ),
    query(
      `SELECT unit, sum(quantity)::float AS quantity, coalesce(sum(estimated_cost_usd), 0)::float AS usd
         FROM usage_records WHERE org_id = $1 AND recorded_at >= $2 AND recorded_at < $3 AND provider = 'openai' GROUP BY unit ORDER BY unit`,
      p,
    ),
    query(
      `SELECT cp.id, cp.name, count(c.id)::int AS calls, coalesce(sum(c.duration_sec), 0)::int AS seconds,
              coalesce(sum(c.estimated_cost_usd), 0)::float AS total_usd
         FROM calls c JOIN campaigns cp ON cp.id = c.campaign_id
        WHERE c.org_id = $1 AND c.started_at >= $2 AND c.started_at < $3 GROUP BY cp.id, cp.name ORDER BY total_usd DESC`,
      p,
    ),
    query(
      `SELECT category, amount_usd::float, fetched_at FROM billing_records WHERE org_id = $1 AND provider = 'twilio' AND period_start = $2 ORDER BY amount_usd DESC`,
      [orgId, start],
    ),
  ]);
  res.json({
    month,
    totals: totals.rows[0],
    byMode: byMode.rows,
    byCountry: byCountry.rows,
    byDay: byDay.rows,
    tokens: tokens.rows,
    campaigns: campaigns.rows,
    twilioBilled: billed.rows,
    spend: await spendStatus(orgId),
  });
});

/**
 * Pulls Twilio's own usage records for the month. These are account-wide: they include every
 * app that uses the same Twilio account, so they can be higher than this platform's calls.
 */
router.post("/reconcile", requirePermission("usage:view"), async (req, res) => {
  const { month } = Month.parse(req.query);
  const { start, end } = range(month);
  const orgId = req.user!.orgId;
  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Connect Twilio first.");
  const last = new Date(end.getTime() - 86_400_000);
  let records;
  try {
    records = await twilioClient(creds).usage.records.list({ startDate: start, endDate: last, limit: 1000 });
  } catch (err: any) {
    throw badRequest(`Twilio didn't return usage records: ${err?.message ?? "unknown error"}`);
  }
  const relevant = records.filter((r) => Number(r.price) > 0 && (r.priceUnit ?? "usd").toLowerCase() === "usd");
  for (const r of relevant) {
    await query(
      `INSERT INTO billing_records (org_id, provider, period_start, period_end, category, amount_usd, raw)
       VALUES ($1,'twilio',$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, provider, period_start, period_end, category) DO UPDATE SET amount_usd = EXCLUDED.amount_usd, raw = EXCLUDED.raw, fetched_at = now()`,
      [orgId, start, last, r.category, Number(r.price), { description: r.description, usage: r.usage, usageUnit: r.usageUnit, count: r.count }],
    );
  }
  res.json({ ok: true, categories: relevant.length });
});

/** Fills in costs for finished calls that don't have one yet (e.g. made before cost tracking existed). */
router.post("/recalculate", requirePermission("*"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, coalesce(ended_at, started_at) < now() - interval '7 days' AS give_up FROM calls
      WHERE org_id = $1 AND status IN ('completed','busy','no_answer','failed','canceled')
      ORDER BY started_at DESC LIMIT 200`,
    [req.user!.orgId],
  );
  let priced = 0;
  let waiting = 0;
  for (const r of rows) {
    // Re-run even "final" calls so new price overrides apply to their OpenAI estimate.
    await query("UPDATE calls SET cost_status = 'pending' WHERE id = $1 AND cost_status = 'final'", [r.id]);
    if ((await computeCallCost(r.id, { lastAttempt: r.give_up })) === "done") priced++;
    else waiting++;
  }
  await audit(req, "usage.recalculated", { metadata: { calls: rows.length } });
  res.json({ ok: true, calls: rows.length, priced, waitingForTwilio: waiting });
});

router.get("/pricing", requirePermission("usage:view"), async (req, res) => {
  res.json({ prices: await pricesFor(req.user!.orgId), source: PRICE_SOURCE, unit: "USD per 1M tokens" });
});

router.put("/pricing", requirePermission("*"), async (req, res) => {
  const { overrides } = z
    .object({ overrides: z.record(z.string().refine((k) => k in DEFAULT_PRICES, "Unknown price"), z.number().min(0).max(10_000).nullable()) })
    .parse(req.body);
  for (const [key, usd] of Object.entries(overrides)) {
    if (usd === null) await query("DELETE FROM pricing_overrides WHERE org_id = $1 AND key = $2", [req.user!.orgId, key]);
    else
      await query(
        `INSERT INTO pricing_overrides (org_id, key, usd_per_unit, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, key) DO UPDATE SET usd_per_unit = EXCLUDED.usd_per_unit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.user!.orgId, key, usd, req.user!.id],
      );
  }
  await audit(req, "usage.pricing_updated", { metadata: overrides });
  res.json({ prices: await pricesFor(req.user!.orgId) });
});

router.put("/limits", requirePermission("*"), async (req, res) => {
  const b = z
    .object({
      monthlyLimitUsd: z.number().min(1).max(1_000_000).nullable(),
      alertThresholdPct: z.number().int().min(10).max(100),
      action: z.enum(["alert", "block"]),
    })
    .parse(req.body);
  await query(
    `UPDATE org_settings SET monthly_spend_limit_usd = $2, spend_alert_threshold_pct = $3, spend_limit_action = $4, updated_at = now() WHERE org_id = $1`,
    [req.user!.orgId, b.monthlyLimitUsd, b.alertThresholdPct, b.action],
  );
  await audit(req, "usage.limits_updated", { metadata: b });
  res.json({ spend: await spendStatus(req.user!.orgId) });
});

export default router;
