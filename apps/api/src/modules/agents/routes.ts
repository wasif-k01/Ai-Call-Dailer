import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { buildInstructions, ensureDefaultAgent, getAgent, LANGUAGES } from "../ai/agents.js";
import { VOICES } from "../integrations/providers/openai.js";

const router = Router();
router.use(requireAuth);

export const STYLES = ["friendly", "professional", "formal", "casual", "empathetic", "energetic"] as const;

const COLUMNS = `id, name, description, system_instructions, voice, language, speaking_speed::float AS speaking_speed,
  conversation_style, greeting_message, max_call_duration_sec, conversation_rules, call_ending_instructions,
  is_active, created_at, updated_at,
  (SELECT count(*)::int FROM calls c WHERE c.ai_agent_id = ai_agents.id) AS call_count`;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const AgentSchema = z.object({
  name: z.string().trim().min(2, "Give the agent a name (at least 2 characters).").max(80),
  description: optionalText(300),
  systemInstructions: z.string().trim().min(20, "Describe what the agent should do (at least 20 characters).").max(8000),
  voice: z.enum(VOICES),
  language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
  speakingSpeed: z.number().min(0.25).max(1.5),
  conversationStyle: z.enum(STYLES),
  greetingMessage: z.string().trim().min(5, "Write a greeting (at least 5 characters).").max(500),
  maxCallDurationSec: z.number().int().min(30, "At least 30 seconds.").max(3600, "OpenAI sessions last at most 60 minutes."),
  conversationRules: optionalText(4000),
  callEndingInstructions: optionalText(2000),
  isActive: z.boolean().default(true),
});

function toRow(b: z.infer<typeof AgentSchema>) {
  return [
    b.name, b.description, b.systemInstructions, b.voice, b.language, b.speakingSpeed, b.conversationStyle,
    b.greetingMessage, b.maxCallDurationSec, b.conversationRules, b.callEndingInstructions, b.isActive,
  ];
}

async function assertNameFree(orgId: string, name: string, exceptId?: string) {
  const { rowCount } = await query(
    "SELECT 1 FROM ai_agents WHERE org_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)",
    [orgId, name, exceptId ?? null],
  );
  if (rowCount) throw conflict(`You already have an agent called "${name}". Choose a different name.`);
}

async function loadAgentRow(orgId: string, id: string) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM ai_agents WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!rows[0]) throw notFound("Agent not found.");
  return rows[0];
}

router.get("/options", requirePermission("calls:view"), (_req, res) => {
  res.json({ voices: VOICES, languages: LANGUAGES, styles: STYLES });
});

router.get("/", requirePermission("calls:view"), async (req, res) => {
  await ensureDefaultAgent(req.user!.orgId);
  const { rows } = await query(`SELECT ${COLUMNS} FROM ai_agents WHERE org_id = $1 ORDER BY is_active DESC, name`, [req.user!.orgId]);
  res.json({ agents: rows });
});

router.get("/:id", requirePermission("calls:view"), async (req, res) => {
  res.json({ agent: await loadAgentRow(req.user!.orgId, String(req.params.id)) });
});

/** Exactly what the AI is told on a call: the agent's settings plus the rules that are always added. */
router.get("/:id/instructions-preview", requirePermission("calls:view"), async (req, res) => {
  const agent = await getAgent(req.user!.orgId, String(req.params.id));
  if (!agent) throw notFound("Agent not found.");
  res.json({ instructions: buildInstructions(agent) });
});

router.post("/", requirePermission("agents:manage"), async (req, res) => {
  const body = AgentSchema.parse(req.body);
  await assertNameFree(req.user!.orgId, body.name);
  const { rows } = await query(
    `INSERT INTO ai_agents (name, description, system_instructions, voice, language, speaking_speed, conversation_style,
        greeting_message, max_call_duration_sec, conversation_rules, call_ending_instructions, is_active, org_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [...toRow(body), req.user!.orgId, req.user!.id],
  );
  await audit(req, "agent.created", { entityType: "agent", entityId: rows[0].id, metadata: { name: body.name } });
  res.status(201).json({ agent: await loadAgentRow(req.user!.orgId, rows[0].id) });
});

router.put("/:id", requirePermission("agents:manage"), async (req, res) => {
  const id = String(req.params.id);
  await loadAgentRow(req.user!.orgId, id);
  const body = AgentSchema.parse(req.body);
  await assertNameFree(req.user!.orgId, body.name, id);
  await query(
    `UPDATE ai_agents SET name=$1, description=$2, system_instructions=$3, voice=$4, language=$5, speaking_speed=$6,
        conversation_style=$7, greeting_message=$8, max_call_duration_sec=$9, conversation_rules=$10,
        call_ending_instructions=$11, is_active=$12, updated_at = now()
      WHERE id = $13 AND org_id = $14`,
    [...toRow(body), id, req.user!.orgId],
  );
  await audit(req, "agent.updated", { entityType: "agent", entityId: id });
  res.json({ agent: await loadAgentRow(req.user!.orgId, id) });
});

router.post("/:id/duplicate", requirePermission("agents:manage"), async (req, res) => {
  const src = await loadAgentRow(req.user!.orgId, String(req.params.id));
  let name = `${src.name} (copy)`.slice(0, 80);
  for (let n = 2; (await query("SELECT 1 FROM ai_agents WHERE org_id = $1 AND lower(name) = lower($2)", [req.user!.orgId, name])).rowCount; n++)
    name = `${src.name} (copy ${n})`.slice(0, 80);
  const { rows } = await query(
    `INSERT INTO ai_agents (org_id, created_by, name, description, system_instructions, voice, language, speaking_speed,
        conversation_style, greeting_message, max_call_duration_sec, conversation_rules, call_ending_instructions, is_active)
     SELECT org_id, $3, $4, description, system_instructions, voice, language, speaking_speed, conversation_style,
            greeting_message, max_call_duration_sec, conversation_rules, call_ending_instructions, false
       FROM ai_agents WHERE id = $1 AND org_id = $2 RETURNING id`,
    [src.id, req.user!.orgId, req.user!.id, name],
  );
  await audit(req, "agent.duplicated", { entityType: "agent", entityId: rows[0].id, metadata: { from: src.id } });
  res.status(201).json({ agent: await loadAgentRow(req.user!.orgId, rows[0].id) });
});

for (const action of ["activate", "deactivate"] as const) {
  router.post(`/:id/${action}`, requirePermission("agents:manage"), async (req, res) => {
    const id = String(req.params.id);
    await loadAgentRow(req.user!.orgId, id);
    const active = action === "activate";
    await query("UPDATE ai_agents SET is_active = $3, updated_at = now() WHERE id = $1 AND org_id = $2", [id, req.user!.orgId, active]);
    await audit(req, `agent.${action}d`, { entityType: "agent", entityId: id });
    res.json({ agent: await loadAgentRow(req.user!.orgId, id) });
  });
}

router.delete("/:id", requirePermission("agents:manage"), async (req, res) => {
  const id = String(req.params.id);
  const agent = await loadAgentRow(req.user!.orgId, id);
  const busy = await query(
    `SELECT
       (SELECT count(*)::int FROM campaigns WHERE ai_agent_id = $1 AND status IN ('running','paused')) AS campaigns,
       (SELECT count(*)::int FROM calls WHERE ai_agent_id = $1 AND status IN ('initiated','queued','ringing','in_progress')) AS live`,
    [id],
  );
  if (busy.rows[0].live) throw badRequest("This agent is on a call right now. Try again when the call has ended.");
  if (busy.rows[0].campaigns) throw badRequest("A running or paused campaign uses this agent. Stop that campaign first, or deactivate the agent instead.");
  // Past calls keep their history; their agent link is cleared (ON DELETE SET NULL).
  await query("DELETE FROM ai_agents WHERE id = $1 AND org_id = $2", [id, req.user!.orgId]);
  await audit(req, "agent.deleted", { entityType: "agent", entityId: id, metadata: { name: agent.name } });
  res.json({ ok: true });
});

export default router;
