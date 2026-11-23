import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { closeRedis } from "../src/lib/redis.js";
import { resetDb, signUp } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await closeRedis();
  await pool.end();
});

const valid = {
  name: "Appointment Reminder",
  description: "Confirms appointments",
  systemInstructions: "You call patients to confirm their appointment time and offer to reschedule if needed.",
  voice: "cedar",
  language: "ur",
  speakingSpeed: 1.1,
  conversationStyle: "professional",
  greetingMessage: "Hello, this is an AI assistant from the clinic.",
  maxCallDurationSec: 240,
  conversationRules: "Never give medical advice.",
  callEndingInstructions: "Confirm the time, then say goodbye.",
  isActive: true,
};

describe("AI agent management", () => {
  it("creates a starter agent automatically and lists it", async () => {
    const { agent } = await signUp();
    const res = await agent.get("/api/agents");
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({ name: "General Assistant", is_active: true, voice: "marin" });
  });

  it("creates, reads and updates an agent with every field", async () => {
    const { agent } = await signUp();
    const created = await agent.post("/api/agents").send(valid);
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ name: valid.name, voice: "cedar", language: "ur", speaking_speed: 1.1, max_call_duration_sec: 240 });
    const id = created.body.agent.id;
    const upd = await agent.put(`/api/agents/${id}`).send({ ...valid, greetingMessage: "Hi, AI assistant here from the clinic.", isActive: false });
    expect(upd.body.agent).toMatchObject({ greeting_message: "Hi, AI assistant here from the clinic.", is_active: false });
    expect((await agent.get(`/api/agents/${id}`)).body.agent.conversation_rules).toBe("Never give medical advice.");
  });

  it("validates fields with clear messages", async () => {
    const { agent } = await signUp();
    const res = await agent.post("/api/agents").send({ ...valid, name: "x", systemInstructions: "short", maxCallDurationSec: 7200, voice: "robot" });
    expect(res.status).toBe(400);
    const paths = res.body.error.fields.map((f: any) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "systemInstructions", "maxCallDurationSec", "voice"]));
  });

  it("rejects duplicate names (case-insensitive)", async () => {
    const { agent } = await signUp();
    await agent.post("/api/agents").send(valid);
    expect((await agent.post("/api/agents").send({ ...valid, name: "appointment reminder" })).status).toBe(409);
  });

  it("duplicates as an inactive copy with a unique name", async () => {
    const { agent } = await signUp();
    const id = (await agent.post("/api/agents").send(valid)).body.agent.id;
    const a = await agent.post(`/api/agents/${id}/duplicate`);
    const b = await agent.post(`/api/agents/${id}/duplicate`);
    expect(a.body.agent).toMatchObject({ name: "Appointment Reminder (copy)", is_active: false, voice: "cedar" });
    expect(b.body.agent.name).toBe("Appointment Reminder (copy 2)");
  });

  it("activates and deactivates", async () => {
    const { agent } = await signUp();
    const id = (await agent.post("/api/agents").send(valid)).body.agent.id;
    expect((await agent.post(`/api/agents/${id}/deactivate`)).body.agent.is_active).toBe(false);
    expect((await agent.post(`/api/agents/${id}/activate`)).body.agent.is_active).toBe(true);
  });

  it("deletes, but not while a running campaign uses it; call history is kept", async () => {
    const { agent } = await signUp();
    const id = (await agent.post("/api/agents").send(valid)).body.agent.id;
    const org = (await pool.query("SELECT org_id FROM ai_agents WHERE id = $1", [id])).rows[0].org_id;
    await pool.query(`INSERT INTO calls (org_id, mode, from_number, to_number, status, ai_agent_id) VALUES ($1,'ai','+14155550100','+971501234567','completed',$2)`, [org, id]);
    const camp = await pool.query(`INSERT INTO campaigns (org_id, name, ai_agent_id, status) VALUES ($1,'C',$2,'running') RETURNING id`, [org, id]);
    expect((await agent.delete(`/api/agents/${id}`)).status).toBe(400);
    await pool.query("UPDATE campaigns SET status = 'stopped' WHERE id = $1", [camp.rows[0].id]);
    expect((await agent.delete(`/api/agents/${id}`)).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int n FROM calls")).rows[0].n).toBe(1);
  });

  it("shows exactly what the AI is told, including rules that are always added", async () => {
    const { agent } = await signUp();
    const id = (await agent.post("/api/agents").send(valid)).body.agent.id;
    const p = (await agent.get(`/api/agents/${id}/instructions-preview`)).body.instructions;
    expect(p).toContain("Never give medical advice.");
    expect(p).toContain("Speak Urdu by default");
    expect(p).toContain("MANDATORY RULES");
  });

  it("agents role can use agents but not edit them; other orgs can't see them", async () => {
    const owner = await signUp();
    const id = (await owner.agent.post("/api/agents").send(valid)).body.agent.id;
    await pool.query("UPDATE users SET role = 'agent' WHERE email = $1", [owner.email]);
    expect((await owner.agent.get("/api/agents")).status).toBe(200);
    expect((await owner.agent.put(`/api/agents/${id}`).send(valid)).status).toBe(403);
    expect((await owner.agent.delete(`/api/agents/${id}`)).status).toBe(403);
    const other = await signUp();
    expect((await other.agent.get(`/api/agents/${id}`)).status).toBe(404);
    expect((await other.agent.delete(`/api/agents/${id}`)).status).toBe(404);
  });

  it("owner can rename the organization", async () => {
    const { agent } = await signUp();
    expect((await agent.put("/api/settings/organization").send({ name: "Acme Dubai" })).status).toBe(200);
    expect((await agent.get("/api/auth/me")).body.organization.name).toBe("Acme Dubai");
  });
});
