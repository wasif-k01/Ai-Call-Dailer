import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import twilio from "twilio";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";

let sidCounter = 0;
const calls = { create: vi.fn(), update: vi.fn() };
const fakeClient = {
  calls: Object.assign((sid: string) => ({ update: (p: unknown) => calls.update(sid, p) }), { create: (p: unknown) => calls.create(p) }),
};
vi.mock("../src/modules/integrations/providers/twilio.js", async (orig) => {
  const actual = await orig<typeof import("../src/modules/integrations/providers/twilio.js")>();
  return { ...actual, twilioClient: vi.fn(() => fakeClient), fetchAccount: vi.fn(), verifyApiKey: vi.fn(), fetchNumbers: vi.fn(), fetchGeoPermissions: vi.fn() };
});
const tw = await import("../src/modules/integrations/providers/twilio.js");
const { app, resetDb, signUp } = await import("./helpers.js");
const engine = await import("../src/modules/campaigns/engine.js");

const SID = "AC" + "1".repeat(32);
const TOKEN = "2".repeat(32);
const BASE = "https://api.test.example";

beforeEach(async () => {
  await resetDb();
  const keys = await redis().keys("acp:geo:*");
  if (keys.length) await redis().del(...keys);
  calls.create.mockReset().mockImplementation(async () => ({ sid: "CA" + String(++sidCounter).padStart(32, "0") }));
  calls.update.mockReset().mockResolvedValue({});
  vi.mocked(tw.fetchGeoPermissions).mockImplementation(async (_c, isos) =>
    isos.map((iso) => ({ isoCode: iso, name: iso, countryCodes: [], lowRiskNumbersEnabled: iso !== "PK", highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false })),
  );
});
afterAll(async () => {
  await closeRedis();
  await pool.end();
});

async function setupOrg() {
  const s = await signUp();
  vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "Acct", status: "active", type: "Full" });
  vi.mocked(tw.fetchNumbers).mockResolvedValue([
    { e164: "+14155550100", providerSid: "PN1", friendlyName: "US", countryIso: "US", numberType: "provider_owned", capabilities: { voice: true } },
  ]);
  await s.agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN });
  await s.agent.post("/api/integrations/twilio/test");
  await s.agent.put("/api/integrations/openai").send({ apiKey: "sk-proj-TESTKEY1234567890abcdefXYZ9", model: "gpt-realtime-2.1", voice: "marin" });
  await pool.query("UPDATE integrations SET status = 'connected' WHERE provider = 'openai'");
  await pool.query("UPDATE org_settings SET max_concurrent_ai_calls = 20");
  const agentId = (await s.agent.get("/api/agents")).body.agents[0].id as string;
  return { ...s, agentId };
}

const UAE = ["+971501234561", "+971501234562", "+971501234563", "+971501234564", "+971501234565"];

function campaignBody(agentId: string, rows: { phone: string; name?: string }[], extra: Record<string, unknown> = {}) {
  return {
    name: "Test campaign", agentId, instructions: "Remind them about the sale.",
    callingHoursStart: "00:00", callingHoursEnd: "23:59", timezone: "Asia/Dubai",
    maxConcurrent: 2, maxRetries: 1, retryDelayMin: 5, defaultCountry: "AE", rows, ...extra,
  };
}

async function createAndStart(agent: any, agentId: string, rows = UAE.map((phone, i) => ({ phone, name: `Person ${i + 1}` })), extra = {}) {
  const c = await agent.post("/api/campaigns").send(campaignBody(agentId, rows, extra));
  expect(c.status).toBe(201);
  const id = c.body.campaign.id as string;
  const start = await agent.post(`/api/campaigns/${id}/start`).send({ consentConfirmed: true, confirmContactCount: c.body.added });
  expect(start.status).toBe(200);
  return id;
}

/** Runs the scheduler with dial jobs executed inline (no Redis queue needed). */
const tick = (now?: Date) => engine.runCampaignTick(async (id) => void (await engine.dialCampaignContact(id)), now);

function twilioStatus(callId: string, callSid: string, status: string, extra: Record<string, string> = {}) {
  const path = `/webhooks/twilio/status?callId=${callId}`;
  const params = { CallSid: callSid, CallStatus: status, ...extra };
  return request(app).post(path).set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(TOKEN, BASE + path, params)).type("form").send(params);
}

const contacts = async (campaignId: string) =>
  (await pool.query("SELECT phone_e164, status, attempts, final, last_call_id, next_attempt_at FROM campaign_contacts WHERE campaign_id = $1 ORDER BY phone_e164", [campaignId])).rows;

describe("list validation", () => {
  it("normalises, de-duplicates and flags invalid and Do Not Call numbers", async () => {
    const { agent, orgId } = { ...(await setupOrg()), orgId: "" };
    await agent.post("/api/contacts/dnc").send({ phone: "+971501234569" });
    const res = await agent.post("/api/campaigns/validate").send({
      defaultCountry: "AE",
      rows: [{ phone: "050 123 4561" }, { phone: "+971501234561" }, { phone: "00971501234562" }, { phone: "12" }, { phone: "+971501234569" }, { phone: "+44 20 7946 0958", name: "UK" }],
    });
    expect(res.body.summary).toEqual({ total: 6, valid: 3, invalid: 1, duplicate: 1, dnc: 1 });
    expect(res.body.results.map((r: any) => [r.e164, r.status])).toEqual([
      ["+971501234561", "valid"], ["+971501234561", "duplicate"], ["+971501234562", "valid"], [null, "invalid"], ["+971501234569", "dnc"], ["+442079460958", "valid"],
    ]);
    void orgId;
  });

  it("rejects lists over the 5,000 contact limit", async () => {
    const { agent } = await setupOrg();
    const rows = Array.from({ length: 5001 }, (_, i) => ({ phone: `+97150${String(1000000 + i)}` }));
    expect((await agent.post("/api/campaigns/validate").send({ defaultCountry: "AE", rows })).status).toBe(400);
  });
});

describe("creating and starting", () => {
  it("re-validates on the server, saves contacts, and skips bad rows", async () => {
    const { agent, agentId } = await setupOrg();
    const res = await agent.post("/api/campaigns").send(campaignBody(agentId, [{ phone: "+971501234561", name: "A" }, { phone: "nope" }, { phone: "+971501234561" }]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 1, skipped: 2 });
    expect(res.body.campaign.status).toBe("draft");
    expect((await pool.query("SELECT first_name FROM contacts")).rows[0].first_name).toBe("A");
  });

  it("requires explicit consent and the exact contact count to start", async () => {
    const { agent, agentId } = await setupOrg();
    const c = (await agent.post("/api/campaigns").send(campaignBody(agentId, UAE.map((phone) => ({ phone }))))).body.campaign;
    expect((await agent.post(`/api/campaigns/${c.id}/start`).send({ consentConfirmed: false, confirmContactCount: 5 })).status).toBe(400);
    const wrong = await agent.post(`/api/campaigns/${c.id}/start`).send({ consentConfirmed: true, confirmContactCount: 50 });
    expect(wrong.body.error.message).toMatch(/Type the number of contacts \(5\)/);
    expect((await agent.post(`/api/campaigns/${c.id}/start`).send({ consentConfirmed: true, confirmContactCount: 5 })).status).toBe(200);
    const setup = (await agent.get("/api/setup")).body.steps.find((s: any) => s.key === "bulk_enabled");
    expect(setup.status).toBe("verified");
  });

  it("caps concurrency at 10 and validates calling hours / timezone", async () => {
    const { agent, agentId } = await setupOrg();
    const res = await agent.post("/api/campaigns").send(campaignBody(agentId, [{ phone: UAE[0] }], { maxConcurrent: 50, timezone: "Mars/Base", callingHoursStart: "25:00" }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: any) => f.path).sort()).toEqual(["callingHoursStart", "maxConcurrent", "timezone"]);
  });
});

describe("the campaign engine", () => {
  it("never exceeds the campaign's simultaneous call limit", async () => {
    const { agent, agentId } = await setupOrg();
    const id = await createAndStart(agent, agentId);
    await tick();
    await tick(); // second tick must not add more while 2 are still active
    expect(calls.create).toHaveBeenCalledTimes(2);
    const rows = await contacts(id);
    expect(rows.filter((r) => r.status === "calling")).toHaveLength(2);
    // the AI call gets the campaign instructions plus the person's name
    const meta = (await pool.query("SELECT metadata FROM calls ORDER BY created_at LIMIT 1")).rows[0].metadata;
    expect(meta.extraInstructions).toMatch(/Remind them about the sale\.\nThe person you are calling is called Person/);
  });

  it("respects calling hours in the campaign's timezone", async () => {
    expect(engine.withinCallingHours(new Date("2026-11-24T05:30:00Z"), "Asia/Dubai", "09:00", "18:00")).toBe(true); // 09:30 Dubai
    expect(engine.withinCallingHours(new Date("2026-11-24T04:30:00Z"), "Asia/Dubai", "09:00", "18:00")).toBe(false); // 08:30
    expect(engine.withinCallingHours(new Date("2026-11-24T22:30:00Z"), "Asia/Dubai", "20:00", "03:00")).toBe(true); // 02:30, overnight window
    const { agent, agentId } = await setupOrg();
    await createAndStart(agent, agentId, undefined, { callingHoursStart: "09:00", callingHoursEnd: "18:00" });
    await tick(new Date("2026-11-24T04:30:00Z"));
    expect(calls.create).not.toHaveBeenCalled();
  });

  it("records outcomes from Twilio, retries no-answers after the delay, and completes", async () => {
    const { agent, agentId } = await setupOrg();
    const id = await createAndStart(agent, agentId, [{ phone: UAE[0] }, { phone: UAE[1] }]);
    await tick();
    let rows = await contacts(id);
    const sidOf = async (callId: string) => (await pool.query("SELECT provider_call_sid FROM calls WHERE id = $1", [callId])).rows[0].provider_call_sid;

    // contact 1 answers and completes; contact 2 doesn't answer
    await twilioStatus(rows[0].last_call_id, await sidOf(rows[0].last_call_id), "in-progress");
    expect((await contacts(id))[0].status).toBe("answered");
    await twilioStatus(rows[0].last_call_id, await sidOf(rows[0].last_call_id), "completed", { CallDuration: "40" });
    await twilioStatus(rows[1].last_call_id, await sidOf(rows[1].last_call_id), "no-answer");
    rows = await contacts(id);
    expect(rows.map((r) => [r.status, r.final])).toEqual([["completed", true], ["no_answer", false]]);

    await tick(); // retry not due yet (5 min delay)
    expect(calls.create).toHaveBeenCalledTimes(2);
    await pool.query("UPDATE campaign_contacts SET next_attempt_at = now() - interval '1 minute' WHERE status = 'no_answer'");
    await tick(); // retry #1
    expect(calls.create).toHaveBeenCalledTimes(3);
    rows = await contacts(id);
    await twilioStatus(rows[1].last_call_id, await sidOf(rows[1].last_call_id), "busy");
    rows = await contacts(id);
    expect(rows[1]).toMatchObject({ status: "busy", attempts: 2, final: true }); // maxRetries = 1 → no more attempts

    await tick();
    const camp = (await agent.get(`/api/campaigns/${id}`)).body;
    expect(camp.campaign.status).toBe("completed");
    expect(camp.stats).toMatchObject({ total: 2, attempted: 2, answered: 1, successful: 1, failed: 1, avg_duration_sec: 40 });
  });

  it("pause stops new calls, resume continues, stop ends the campaign", async () => {
    const { agent, agentId } = await setupOrg();
    const id = await createAndStart(agent, agentId, UAE.map((phone) => ({ phone })), { maxConcurrent: 1 });
    await agent.post(`/api/campaigns/${id}/pause`);
    await tick();
    expect(calls.create).not.toHaveBeenCalled();
    await agent.post(`/api/campaigns/${id}/resume`);
    await tick();
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect((await agent.post(`/api/campaigns/${id}/stop`)).body.campaign.status).toBe("stopped");
    expect((await agent.post(`/api/campaigns/${id}/resume`)).status).toBe(409);
    await pool.query("UPDATE calls SET status = 'completed'");
    await tick();
    expect(calls.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry permanent problems, and honours Do Not Call added mid-campaign", async () => {
    const { agent, agentId } = await setupOrg();
    const id = await createAndStart(agent, agentId, [{ phone: "+923001234567" }, { phone: UAE[0] }, { phone: UAE[1] }], { maxConcurrent: 1 });
    await agent.post("/api/contacts/dnc").send({ phone: UAE[1] }); // opt-out arrives before we reach them
    for (let i = 0; i < 3; i++) await tick();
    const rows = await contacts(id);
    const pk = rows.find((r) => r.phone_e164 === "+923001234567")!;
    expect(pk).toMatchObject({ status: "failed", final: true, attempts: 1 }); // Pakistan blocked by geo permissions
    expect(rows.find((r) => r.phone_e164 === UAE[1])).toMatchObject({ status: "opted_out", final: true, attempts: 0 });
    expect(calls.create.mock.calls.map(([p]: any) => p.to)).toEqual([UAE[0]]);
  });

  it("waits (without using an attempt) when the account-wide AI call limit is reached", async () => {
    const { agent, agentId } = await setupOrg();
    await pool.query("UPDATE org_settings SET max_concurrent_ai_calls = 1");
    const id = await createAndStart(agent, agentId, [{ phone: UAE[0] }, { phone: UAE[1] }], { maxConcurrent: 2 });
    await tick();
    expect(calls.create).toHaveBeenCalledTimes(1);
    const rows = await contacts(id);
    expect(rows.find((r) => r.status === "pending")).toMatchObject({ attempts: 0 });
  });

  it("an opt-out during an AI call marks the contact opted out", async () => {
    const { agent, agentId } = await setupOrg();
    const id = await createAndStart(agent, agentId, [{ phone: UAE[0] }]);
    await tick();
    const [c] = await contacts(id);
    const sid = (await pool.query("SELECT provider_call_sid FROM calls WHERE id = $1", [c.last_call_id])).rows[0].provider_call_sid;
    await twilioStatus(c.last_call_id, sid, "in-progress");
    await pool.query(`UPDATE calls SET metadata = metadata || '{"optedOut": true}' WHERE id = $1`, [c.last_call_id]);
    await twilioStatus(c.last_call_id, sid, "completed", { CallDuration: "20" });
    expect((await contacts(id))[0]).toMatchObject({ status: "opted_out", final: true });
  });
});

describe("contacts and Do Not Call list", () => {
  it("creates, searches, updates and deletes contacts", async () => {
    const { agent } = await setupOrg();
    const c = await agent.post("/api/contacts").send({ firstName: "Sara", lastName: "Khan", phone: "050 123 4567", defaultCountry: "AE", consentStatus: "granted", consentSource: "Web form" });
    expect(c.status).toBe(201);
    expect((await agent.post("/api/contacts").send({ phone: "+971501234567" })).status).toBe(409);
    const list = (await agent.get("/api/contacts?q=sara")).body;
    expect(list.total).toBe(1);
    expect(list.contacts[0]).toMatchObject({ phone_e164: "+971501234567", consent_status: "granted", on_dnc: false });
    expect((await agent.put(`/api/contacts/${c.body.id}`).send({ firstName: "Sara", phone: "00971501234567", company: "Acme" })).status).toBe(200);
    expect((await agent.get("/api/contacts?q=acme")).body.total).toBe(1);
    expect((await agent.delete(`/api/contacts/${c.body.id}`)).status).toBe(200);
  });

  it("adding to Do Not Call revokes consent; only admins can remove entries", async () => {
    const { agent, email } = await setupOrg();
    await agent.post("/api/contacts").send({ firstName: "Ali", phone: "+971501234567", consentStatus: "granted" });
    expect((await agent.post("/api/contacts/dnc").send({ phone: "+971501234567", reason: "Asked by phone" })).status).toBe(201);
    expect((await agent.post("/api/contacts/dnc").send({ phone: "+971501234567" })).status).toBe(409);
    const contact = (await agent.get("/api/contacts")).body.contacts[0];
    expect(contact).toMatchObject({ consent_status: "revoked", on_dnc: true });
    const entry = (await agent.get("/api/contacts/dnc")).body.entries[0];
    await pool.query("UPDATE users SET role = 'agent' WHERE email = $1", [email]);
    expect((await agent.delete(`/api/contacts/dnc/${entry.id}`)).status).toBe(403);
    await pool.query("UPDATE users SET role = 'owner' WHERE email = $1", [email]);
    expect((await agent.delete(`/api/contacts/dnc/${entry.id}`)).status).toBe(200);
  });
});
