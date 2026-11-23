import { query, withTransaction } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { publishEvent } from "../../realtime/events.js";
import { CapacityError, placeAiCall } from "../calls/ai-call.js";
import { spendBlocked } from "../usage/costs.js";

/**
 * Campaign engine. Runs inside the worker:
 *   tick (every few seconds)  → picks the next contacts for each running campaign, within its
 *                               calling hours and concurrency limit, and enqueues a dial job each
 *   dial job                  → places one AI call through the same checks as manual AI calls
 *   call status webhook       → updateContactFromCall() moves the contact to its outcome / retry
 */

export type ContactStatus = "pending" | "queued" | "calling" | "answered" | "completed" | "no_answer" | "busy" | "failed" | "opted_out";
const ACTIVE: ContactStatus[] = ["queued", "calling", "answered"];
const RETRYABLE: ContactStatus[] = ["no_answer", "busy", "failed"];

/** "HH:MM" now in the campaign's timezone, compared with its calling window (supports windows past midnight). */
export function withinCallingHours(now: Date, timezone: string, start: string, end: string) {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const cur = hm.replace(/^24/, "00");
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

export async function campaignLog(orgId: string, campaignId: string, level: "info" | "warn" | "error", message: string, data: Record<string, unknown> = {}) {
  await query("INSERT INTO campaign_logs (org_id, campaign_id, level, message, data) VALUES ($1,$2,$3,$4,$5)", [orgId, campaignId, level, message, data]);
}

export async function campaignStats(campaignId: string) {
  const { rows } = await query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE attempts > 0)::int AS attempted,
       count(*) FILTER (WHERE status IN ('answered','completed') OR (status = 'opted_out' AND attempts > 0))::int AS answered,
       count(*) FILTER (WHERE status = 'completed')::int AS successful,
       count(*) FILTER (WHERE status IN ('failed','busy','no_answer') AND final)::int AS failed,
       count(*) FILTER (WHERE status = 'opted_out')::int AS opted_out,
       count(*) FILTER (WHERE status = 'pending' OR (status IN ('failed','busy','no_answer') AND NOT final))::int AS remaining,
       count(*) FILTER (WHERE status IN ('queued','calling','answered'))::int AS in_progress,
       (SELECT coalesce(round(avg(duration_sec) FILTER (WHERE duration_sec > 0)), 0)::int FROM calls WHERE campaign_id = $1) AS avg_duration_sec,
       (SELECT sum(coalesce(actual_cost_usd, estimated_cost_usd))::float FROM calls WHERE campaign_id = $1) AS total_cost_usd
     FROM campaign_contacts WHERE campaign_id = $1`,
    [campaignId],
  );
  const byStatus = await query("SELECT status, count(*)::int AS n FROM campaign_contacts WHERE campaign_id = $1 GROUP BY status", [campaignId]);
  return { ...rows[0], by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])) };
}

async function publishProgress(orgId: string, campaignId: string) {
  const { rows } = await query("SELECT status FROM campaigns WHERE id = $1", [campaignId]);
  await publishEvent({ orgId, type: "campaign.progress", data: { campaignId, status: rows[0]?.status, stats: await campaignStats(campaignId) } }).catch(() => {});
}

export type Enqueue = (campaignContactId: string, attempt: number) => Promise<void>;

/** One scheduling pass over every running campaign. Safe to run concurrently (row locks + SKIP LOCKED). */
export async function runCampaignTick(enqueue: Enqueue, now = new Date()) {
  const { rows: campaigns } = await query("SELECT id, org_id FROM campaigns WHERE status = 'running'");
  for (const c of campaigns) {
    try {
      await tickCampaign(c.id, c.org_id, enqueue, now);
    } catch (err) {
      logger.error({ err, campaignId: c.id }, "campaign tick failed");
    }
  }
}

async function tickCampaign(campaignId: string, orgId: string, enqueue: Enqueue, now: Date) {
  const blocked = await spendBlocked(orgId);
  if (blocked) {
    const { rowCount } = await query("UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'running'", [campaignId]);
    if (rowCount) {
      await campaignLog(orgId, campaignId, "warn", `Paused automatically: this month's spending limit ($${blocked.limit_usd}) has been reached.`);
      await publishProgress(orgId, campaignId);
    }
    return;
  }
  // Safety net: contacts still "calling" whose call already finished (e.g. a missed webhook).
  const stale = await query(
    `SELECT cc.last_call_id FROM campaign_contacts cc JOIN calls k ON k.id = cc.last_call_id
      WHERE cc.campaign_id = $1 AND cc.status IN ('calling','answered')
        AND k.status IN ('completed','busy','no_answer','failed','canceled')`,
    [campaignId],
  );
  for (const r of stale.rows) await updateContactFromCall(r.last_call_id);

  const picked = await withTransaction(async (cx) => {
    const { rows } = await cx.query(
      `SELECT * FROM campaigns WHERE id = $1 AND status = 'running' FOR UPDATE SKIP LOCKED`,
      [campaignId],
    );
    const camp = rows[0];
    if (!camp) return [];

    // Contacts stuck in "queued" (worker crashed before dialling) go back to the queue.
    await cx.query(
      `UPDATE campaign_contacts SET status = 'pending', updated_at = now()
        WHERE campaign_id = $1 AND status = 'queued' AND updated_at < now() - interval '3 minutes'`,
      [campaignId],
    );

    const counts = await cx.query(
      `SELECT
         count(*) FILTER (WHERE status = ANY($2))::int AS active,
         count(*) FILTER (WHERE NOT final AND (status = 'pending' OR status = ANY($3) OR status = ANY($2)))::int AS open
       FROM campaign_contacts WHERE campaign_id = $1`,
      [campaignId, ACTIVE, RETRYABLE],
    );
    const { active, open } = counts.rows[0];
    if (open === 0) {
      await cx.query("UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1", [campaignId]);
      return "completed" as const; // logged after the transaction (the log row references this locked campaign)
    }
    if (!withinCallingHours(now, camp.timezone, camp.calling_hours_start, camp.calling_hours_end)) return [];

    const slots = camp.max_concurrent - active;
    if (slots <= 0) return [];
    const next = await cx.query(
      `UPDATE campaign_contacts SET status = 'queued', updated_at = now()
        WHERE id IN (
          SELECT id FROM campaign_contacts
           WHERE campaign_id = $1 AND NOT final
             AND (status = 'pending' OR (status = ANY($3) AND next_attempt_at <= now()))
           ORDER BY attempts, created_at
           LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, attempts`,
      [campaignId, slots, RETRYABLE],
    );
    return next.rows as { id: string; attempts: number }[];
  });

  if (picked === "completed") {
    await campaignLog(orgId, campaignId, "info", "Campaign completed: every contact has been handled.");
    return publishProgress(orgId, campaignId);
  }
  for (const p of picked) await enqueue(p.id, p.attempts + 1);
  if (picked.length) await publishProgress(orgId, campaignId);
}

/** Dial job: places the call for one campaign contact. */
export async function dialCampaignContact(campaignContactId: string) {
  const { rows } = await query(
    `SELECT cc.*, c.status AS campaign_status, c.ai_agent_id, c.from_number_id, c.instructions, c.created_by,
            c.max_retries, c.retry_delay_min, c.default_country
       FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.id = $1`,
    [campaignContactId],
  );
  const cc = rows[0];
  if (!cc || cc.status !== "queued") return { skipped: "not queued" };
  if (cc.campaign_status !== "running") {
    await query("UPDATE campaign_contacts SET status = 'pending', updated_at = now() WHERE id = $1", [cc.id]);
    return { skipped: "campaign not running" };
  }
  const attempt = cc.attempts + 1;
  const personal = cc.display_name ? `The person you are calling is called ${cc.display_name}.` : "";
  try {
    const { call } = await placeAiCall({
      orgId: cc.org_id,
      userId: cc.created_by,
      to: cc.phone_e164,
      defaultCountry: cc.default_country,
      fromNumberId: cc.from_number_id ?? undefined,
      agentId: cc.ai_agent_id,
      instructions: [cc.instructions, personal].filter(Boolean).join("\n") || undefined,
      idempotencyKey: `campaign-${cc.id}-${attempt}`,
      campaignId: cc.campaign_id,
      campaignContactId: cc.id,
    });
    await query(
      `UPDATE campaign_contacts SET status = 'calling', attempts = $2, last_attempt_at = now(), last_call_id = $3, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [cc.id, attempt, call.id],
    );
    return { callId: call.id };
  } catch (err: any) {
    if (err instanceof CapacityError) {
      // Not this contact's fault: put it back without using up an attempt.
      await query("UPDATE campaign_contacts SET status = 'pending', updated_at = now() WHERE id = $1", [cc.id]);
      return { skipped: "capacity" };
    }
    const message = err?.message ?? "Call could not be placed";
    const onDnc = /Do Not Call/.test(message);
    // Validation-type problems (bad number, blocked country, DNC) won't fix themselves: don't retry.
    const permanent = onDnc || err?.status === 400;
    const final = permanent || attempt > cc.max_retries;
    await query(
      `UPDATE campaign_contacts SET status = $2, attempts = $3, last_attempt_at = now(), last_error = $4, final = $5,
              next_attempt_at = CASE WHEN $5 THEN NULL ELSE now() + make_interval(mins => $6) END, updated_at = now()
        WHERE id = $1`,
      [cc.id, onDnc ? "opted_out" : "failed", attempt, message, final, cc.retry_delay_min],
    );
    await campaignLog(cc.org_id, cc.campaign_id, onDnc ? "info" : "warn", `Couldn't call ${cc.phone_e164}: ${message}`, { campaignContactId: cc.id });
    await publishProgress(cc.org_id, cc.campaign_id);
    return { error: message };
  }
}

/** Called whenever a campaign call changes status (from the Twilio status webhook path). */
export async function updateContactFromCall(callId: string) {
  const { rows } = await query(
    `SELECT c.status, c.campaign_contact_id, c.org_id, c.campaign_id, c.metadata, cc.attempts, cc.status AS cc_status,
            cp.max_retries, cp.retry_delay_min
       FROM calls c
       JOIN campaign_contacts cc ON cc.id = c.campaign_contact_id
       JOIN campaigns cp ON cp.id = cc.campaign_id
      WHERE c.id = $1`,
    [callId],
  );
  const r = rows[0];
  if (!r) return;
  let next: ContactStatus | null = null;
  if (r.status === "in_progress") next = "answered";
  else if (r.metadata?.optedOut) next = "opted_out";
  else if (r.status === "completed") next = "completed"; // Twilio only reports "completed" for answered calls
  else if (r.status === "busy") next = "busy";
  else if (r.status === "no_answer") next = "no_answer";
  else if (r.status === "failed" || r.status === "canceled") next = "failed";
  if (!next || next === r.cc_status) return;

  const terminal = !["answered"].includes(next);
  const final = next === "completed" || next === "opted_out" || (terminal && r.attempts > r.max_retries);
  await query(
    `UPDATE campaign_contacts SET status = $2, final = $3,
            next_attempt_at = CASE WHEN $3 OR $2 IN ('answered') THEN NULL ELSE now() + make_interval(mins => $4) END,
            updated_at = now()
      WHERE id = $1 AND last_call_id = $5`,
    [r.campaign_contact_id, next, final, r.retry_delay_min, callId],
  );
  await publishProgress(r.org_id, r.campaign_id);
}

/** A number joined the Do Not Call list: make sure no campaign calls it again. */
export async function applyDncToCampaigns(orgId: string, phoneE164: string) {
  await query(
    `UPDATE campaign_contacts SET status = 'opted_out', final = true, next_attempt_at = NULL, updated_at = now()
      WHERE org_id = $1 AND phone_e164 = $2 AND (NOT final OR status <> 'opted_out')
        AND status NOT IN ('calling','answered')`,
    [orgId, phoneE164],
  );
}
