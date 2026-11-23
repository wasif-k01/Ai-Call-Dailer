import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";

const router = Router();

/** Rename the workspace / company (owner only). */
router.put("/organization", requireAuth, requirePermission("*"), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2, "At least 2 characters.").max(100) }).parse(req.body);
  await query("UPDATE organizations SET name = $2 WHERE id = $1", [req.user!.orgId, name]);
  await audit(req, "organization.renamed", { metadata: { name } });
  res.json({ ok: true, name });
});

export default router;
