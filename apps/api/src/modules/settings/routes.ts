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

const OrgSettingsSchema = z.object({
  recordingEnabled: z.boolean(),
  maxConcurrentAiCalls: z.number().int().min(1).max(20),
});

router.get("/calling", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT recording_enabled, max_concurrent_ai_calls, transcription_enabled FROM org_settings WHERE org_id = $1",
    [req.user!.orgId],
  );
  res.json({ settings: rows[0] });
});

router.put("/calling", requireAuth, requirePermission("*"), async (req, res) => {
  const b = OrgSettingsSchema.parse(req.body);
  await query(
    "UPDATE org_settings SET recording_enabled = $2, max_concurrent_ai_calls = $3, updated_at = now() WHERE org_id = $1",
    [req.user!.orgId, b.recordingEnabled, b.maxConcurrentAiCalls],
  );
  await audit(req, "settings.calling_updated", { metadata: b });
  res.json({ ok: true });
});

export default router;
