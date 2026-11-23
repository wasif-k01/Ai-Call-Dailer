import { Router } from "express";
import { query } from "../../db/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

const router = Router();

router.get("/stats", requireAuth, requirePermission("calls:view"), async (req, res) => {
  const orgId = req.user!.orgId;
  const [totals, ai, recent, setup] = await Promise.all([
    query(
      `SELECT
         count(*)::int                                                         AS total_calls,
         count(*) FILTER (WHERE status = 'completed')::int                     AS successful_calls,
         count(*) FILTER (WHERE status IN ('failed','busy','no_answer','canceled'))::int AS failed_calls,
         count(*) FILTER (WHERE mode = 'human')::int                           AS human_calls,
         count(*) FILTER (WHERE mode = 'ai')::int                              AS ai_calls,
         count(*) FILTER (WHERE status IN ('initiated','queued','ringing','in_progress'))::int AS active_calls,
         coalesce(sum(duration_sec), 0)::int                                   AS total_duration_sec,
         coalesce(sum(coalesce(actual_cost_usd, estimated_cost_usd)), 0)::float AS estimated_cost_usd
       FROM calls WHERE org_id = $1`,
      [orgId],
    ),
    query(
      `SELECT coalesce(sum(duration_sec), 0)::int AS ai_seconds
         FROM calls WHERE org_id = $1 AND mode = 'ai'`,
      [orgId],
    ),
    query(
      `SELECT c.id, c.mode, c.status, c.to_number, c.from_number, c.started_at, c.duration_sec, a.name AS agent_name
         FROM calls c LEFT JOIN ai_agents a ON a.id = c.ai_agent_id
        WHERE c.org_id = $1 ORDER BY c.started_at DESC LIMIT 10`,
      [orgId],
    ),
    query(
      `SELECT provider, status FROM integrations WHERE org_id = $1`,
      [orgId],
    ),
  ]);
  res.json({
    stats: { ...totals.rows[0], ai_usage_seconds: ai.rows[0].ai_seconds },
    recentActivity: recent.rows,
    integrations: setup.rows,
  });
});

export default router;
