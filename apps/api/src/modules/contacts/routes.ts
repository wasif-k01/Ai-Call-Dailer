import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

/** Minimal contact search for the dialer. Full contact management arrives in Phase 6. */
const router = Router();

router.get("/search", requireAuth, requirePermission("calls:view"), async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(60).default("") }).parse(req.query);
  if (q.length < 2) return res.json({ contacts: [] });
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const { rows } = await query(
    `SELECT id, first_name, last_name, phone_e164, company FROM contacts
      WHERE org_id = $1 AND (first_name ILIKE $2 OR last_name ILIKE $2 OR company ILIKE $2 OR phone_e164 LIKE $3)
      ORDER BY first_name NULLS LAST LIMIT 8`,
    [req.user!.orgId, like, `%${q.replace(/\D/g, "") || "~"}%`],
  );
  res.json({ contacts: rows });
});

export default router;
