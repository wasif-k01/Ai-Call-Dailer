import { Router } from "express";
import { query } from "../../db/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { ensureDefaultAgent } from "../ai/agents.js";

/** Agent list for the dialer. Full create/edit/duplicate/delete management is Phase 5. */
const router = Router();

router.get("/", requireAuth, requirePermission("calls:view"), async (req, res) => {
  await ensureDefaultAgent(req.user!.orgId);
  const { rows } = await query(
    `SELECT id, name, description, voice, language, greeting_message, max_call_duration_sec, is_active
       FROM ai_agents WHERE org_id = $1 ORDER BY is_active DESC, name`,
    [req.user!.orgId],
  );
  res.json({ agents: rows });
});

export default router;
