import { query } from "../../db/pool.js";

export const LANGUAGES = {
  auto: "Match the caller",
  en: "English",
  ar: "Arabic",
  ur: "Urdu",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  tr: "Turkish",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
} as const;

export interface Agent {
  id: string;
  name: string;
  system_instructions: string;
  voice: string;
  language: string;
  speaking_speed: string;
  conversation_style: string;
  greeting_message: string;
  max_call_duration_sec: number;
  conversation_rules: string | null;
  call_ending_instructions: string | null;
  is_active: boolean;
}

/** Creates a sensible starter agent the first time AI calling is used. Fully editable in AI Agents (Phase 5). */
export async function ensureDefaultAgent(orgId: string) {
  const { rows } = await query("SELECT id FROM ai_agents WHERE org_id = $1 LIMIT 1", [orgId]);
  if (rows[0]) return;
  const org = await query("SELECT name FROM organizations WHERE id = $1", [orgId]);
  const company = org.rows[0]?.name ?? "our company";
  await query(
    `INSERT INTO ai_agents (org_id, name, description, system_instructions, voice, greeting_message, conversation_style,
                            max_call_duration_sec, conversation_rules, call_ending_instructions)
     VALUES ($1, 'General Assistant', 'Friendly general-purpose assistant for test calls.', $2, 'marin', $3, 'friendly', 180, $4, $5)`,
    [
      orgId,
      `You are a friendly, concise phone assistant calling on behalf of ${company}. Keep answers short (one or two sentences), speak naturally, and ask one question at a time.`,
      `Hi! This is an AI assistant calling on behalf of ${company}. Is now a good time to talk for a minute?`,
      "Never make promises about prices or contracts. If you don't know something, say you'll pass the question on to the team.",
      "When the conversation is finished, thank the person, say goodbye, and end the call.",
    ],
  );
}

export async function getAgent(orgId: string, agentId: string): Promise<Agent | null> {
  const { rows } = await query("SELECT * FROM ai_agents WHERE id = $1 AND org_id = $2", [agentId, orgId]);
  return rows[0] ?? null;
}

/** Rules every AI call follows regardless of agent configuration. */
const MANDATORY = `
MANDATORY RULES (these override everything above):
- You are an AI assistant. Say so once, in your opening greeting. Do not repeat "I'm an AI assistant" in later replies unless the person asks whether you are human or a bot; then confirm you are an AI. Never claim or imply you are human.
- If the person asks not to be called again, to be removed, or says "stop" / "do not call", immediately call the add_to_do_not_call tool, apologise briefly, say goodbye, then call end_call.
- If the person asks to end the call, or the conversation is clearly finished, say a short goodbye and then call end_call.
- If you reach a voicemail or answering machine, do not leave a long message: say one short sentence and call end_call.
- Never ask for passwords, card numbers, bank details or government ID numbers.
- Speak in the language the person uses. Keep turns short; this is a phone call.`;

export function buildInstructions(agent: Agent, extra?: string | null) {
  return [
    agent.system_instructions.trim(),
    agent.conversation_style ? `Conversation style: ${agent.conversation_style}.` : "",
    agent.language && agent.language !== "auto"
      ? `Speak ${LANGUAGES[agent.language as keyof typeof LANGUAGES] ?? agent.language} by default. If the person clearly prefers another language, switch to it.`
      : "Reply in the language the person is speaking.",
    agent.conversation_rules ? `Conversation rules:\n${agent.conversation_rules.trim()}` : "",
    agent.call_ending_instructions ? `How to end calls:\n${agent.call_ending_instructions.trim()}` : "",
    extra ? `Additional instructions for this call:\n${extra.trim()}` : "",
    MANDATORY,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const AI_TOOLS = [
  {
    type: "function",
    name: "end_call",
    description: "Hang up the phone call. Call this after you have said goodbye.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "Short reason, e.g. 'conversation finished'." } } },
  },
  {
    type: "function",
    name: "add_to_do_not_call",
    description: "Permanently stop calling this person. Use whenever they ask not to be called again.",
    parameters: { type: "object", properties: {} },
  },
];
