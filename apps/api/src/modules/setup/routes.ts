import { Router } from "express";
import { query } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";

const router = Router();

/** The 8 setup-wizard steps. A step is only "verified" when the system has actually checked it. */
const STEPS = [
  { key: "openai", title: "Connect OpenAI", phase: 2 },
  { key: "twilio", title: "Connect Twilio", phase: 2 },
  { key: "phone_number", title: "Verify Twilio phone number", phase: 2 },
  { key: "geo_permissions", title: "Check international calling permissions", phase: 2 },
  { key: "openai_voice", title: "Configure OpenAI voice", phase: 2 },
  { key: "test_human_call", title: "Test human-to-human calling", phase: 3 },
  { key: "test_ai_call", title: "Test AI-to-human calling", phase: 4 },
  { key: "bulk_enabled", title: "Enable bulk calling", phase: 6 },
] as const;

const BUILT_PHASE = 2;

router.get("/", requireAuth, async (req, res) => {
  const orgId = req.user!.orgId;
  const [integ, number, steps, calls] = await Promise.all([
    query("SELECT provider, status FROM integrations WHERE org_id = $1", [orgId]),
    query(
      `SELECT e164 FROM phone_numbers WHERE org_id = $1 AND is_default AND status = 'active'
         AND number_type IN ('provider_owned','verified_caller_id') AND (capabilities->>'voice')::boolean`,
      [orgId],
    ),
    query("SELECT step, verified_at, details FROM setup_progress WHERE org_id = $1", [orgId]),
    query(
      `SELECT bool_or(mode = 'human') AS human, bool_or(mode = 'ai') AS ai
         FROM calls WHERE org_id = $1 AND status = 'completed' AND coalesce(duration_sec, 0) > 0`,
      [orgId],
    ),
  ]);
  const connected = (p: string) => integ.rows.some((r) => r.provider === p && r.status === "connected");
  const recorded = new Map(steps.rows.map((r) => [r.step, r]));

  const verified: Record<string, boolean> = {
    openai: connected("openai"),
    twilio: connected("twilio"),
    phone_number: connected("twilio") && number.rowCount! > 0,
    geo_permissions: connected("twilio") && recorded.has("geo_permissions"),
    openai_voice: connected("openai") && recorded.has("openai_voice"),
    test_human_call: !!calls.rows[0]?.human,
    test_ai_call: !!calls.rows[0]?.ai,
    bulk_enabled: recorded.has("bulk_enabled"),
  };

  const result = STEPS.map((s) => ({
    ...s,
    status: verified[s.key] ? "verified" : s.phase > BUILT_PHASE ? "not_available_yet" : "pending",
    details: recorded.get(s.key)?.details ?? (s.key === "phone_number" && number.rows[0] ? { defaultNumber: number.rows[0].e164 } : null),
  }));
  const done = result.filter((s) => s.status === "verified").length;
  res.json({ steps: result, completed: done, total: STEPS.length, percent: Math.round((done / STEPS.length) * 100) });
});

export default router;
