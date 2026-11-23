import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";

// Fake Twilio: per-call prices and account usage records.
const prices = new Map<string, string | null>();
const usageList = vi.fn();
const callsCreate = vi.fn();
const fakeClient = {
  calls: Object.assign(
    (sid: string) => ({ fetch: async () => ({ sid, price: prices.get(sid) ?? null, priceUnit: "USD" }), update: async () => ({}) }),
    { create: (p: unknown) => callsCreate(p) },
  ),
  usage: { records: { list: (p: unknown) => usageList(p) } },
};
vi.mock("../src/modules/integrations/providers/twilio.js", async (orig) => {
  const actual = await orig<typeof import("../src/modules/integrations/providers/twilio.js")>();
  return { ...actual, twilioClient: vi.fn(() => fakeClient), fetchAccount: vi.fn(), verifyApiKey: vi.fn(), fetchNumbers: vi.fn(), fetchGeoPermissions: vi.fn() };
});
const tw = await import("../src/modules/integrations/providers/twilio.js");
const { app, resetDb, signUp } = await import("./helpers.js");
const { computeCallCost } = await import("../src/modules/usage/costs.js");
const { estimateAiCost, pricesFor } = await import("../src/modules/usage/pricing.js");
const engine = await import("../src/modules/campaigns/engine.js");

beforeEach(async () => {
  await resetDb();
  prices.clear();
  usageList.mockReset();
  let n = 0;
  callsCreate.mockReset().mockImplementation(async () => ({ sid: "CA" + String(++n).padStart(32, "5") }));
  const keys = await redis().keys("acp:geo:*");
  if (keys.length) await redis().del(...keys);
  vi.mocked(tw.fetchGeoPermissions).mockImplementation(async (_c, isos) =>
    isos.map((iso) => ({ isoCode: iso, name: iso, countryCodes: [], lowRiskNumbersEnabled: true, highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false })),
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
  await s.agent.put("/api/integrations/twilio").send({ accountSid: "AC" + "1".repeat(32), authToken: "2".repeat(32) });
  await s.agent.post("/api/integrations/twilio/test");
  await s.agent.put("/api/integrations/openai").send({ apiKey: "sk-proj-TESTKEY1234567890abcdefXYZ9", model: "gpt-realtime-2.1", voice: "marin" });
  await pool.query("UPDATE integrations SET status = 'connected' WHERE provider = 'openai'");
  const me = (await s.agent.get("/api/auth/me")).body;
  const agentId = (await s.agent.get("/api/agents")).body.agents[0].id as string;
  return { ...s, orgId: me.organization.id as string, agentId };
}

async function insertCall(orgId: string, fields: Record<string, unknown>) {
  const f = { mode: "human", status: "completed", from_number: "+14155550100", to_number: "+971501234567", to_country_iso: "AE", duration_sec: 60, metadata: {}, ...fields };
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO calls (org_id, ${keys.join(",")}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(",")}) RETURNING id`,
    [orgId, ...Object.values(f)],
  );
  return rows[0].id as string;
}

describe("AI cost estimate", () => {
  it("uses OpenAI list prices, bills cached tokens at the cached rate, adds transcription", () => {
    const p = { "m:input_audio_tokens": { usd: 32 }, "m:output_audio_tokens": { usd: 64 }, "m:input_text_tokens": { usd: 4 }, "m:output_text_tokens": { usd: 24 }, "m:cached_tokens": { usd: 0.4 }, "t:transcribe_input_tokens": { usd: 1.25 }, "t:transcribe_output_tokens": { usd: 5 } };
    const usd = estimateAiCost(p, "m", { input_audio_tokens: 1_000_000, cached_tokens: 500_000, output_audio_tokens: 1_000_000, input_text_tokens: 0, output_text_tokens: 0, transcribe_input_tokens: 1_000_000, transcribe_output_tokens: 0 }, "t");
    // 0.5M full-price audio in ($16) + 0.5M cached ($0.20) + 1M audio out ($64) + 1M transcription ($1.25)
    expect(usd).toBeCloseTo(81.45, 5);
    expect(estimateAiCost(p, "unknown-model", { input_audio_tokens: 1 })).toBeNull(); // never guesses
  });
});

describe("call costs", () => {
  it("human call: sums Twilio's billed price for both legs and records it as actual", async () => {
    const { orgId } = await setupOrg();
    const id = await insertCall(orgId, { provider_call_sid: "CA" + "a".repeat(32), metadata: { browserCallSid: "CA" + "b".repeat(32) } });
    prices.set("CA" + "a".repeat(32), "-0.07400");
    prices.set("CA" + "b".repeat(32), "-0.00400");
    expect(await computeCallCost(id)).toBe("done");
    const c = (await pool.query("SELECT telephony_cost_usd::float t, actual_cost_usd::float a, estimated_cost_usd::float e, cost_status FROM calls WHERE id = $1", [id])).rows[0];
    expect(c).toEqual({ t: 0.078, a: 0.078, e: 0.078, cost_status: "final" });
    expect((await pool.query("SELECT source FROM usage_records WHERE call_id = $1 AND provider = 'twilio'", [id])).rows[0].source).toBe("provider");
  });

  it("waits for Twilio to price the call, then marks it partial on the last attempt", async () => {
    const { orgId } = await setupOrg();
    const id = await insertCall(orgId, { provider_call_sid: "CA" + "c".repeat(32) });
    expect(await computeCallCost(id)).toBe("retry");
    let c = (await pool.query("SELECT cost_status, telephony_cost_usd FROM calls WHERE id = $1", [id])).rows[0];
    expect(c).toEqual({ cost_status: "pending", telephony_cost_usd: null }); // unknown, not $0
    // once Twilio prices it, the cost becomes final
    prices.set("CA" + "c".repeat(32), "-0.02000");
    expect(await computeCallCost(id)).toBe("done");
    c = (await pool.query("SELECT cost_status, telephony_cost_usd::float t FROM calls WHERE id = $1", [id])).rows[0];
    expect(c).toEqual({ cost_status: "final", t: 0.02 });
  });

  it("only gives up on a Twilio price after 7 days", async () => {
    const { orgId } = await setupOrg();
    const recent = await insertCall(orgId, { provider_call_sid: "CA" + "1".repeat(32), ended_at: new Date(Date.now() - 3600_000) });
    const old = await insertCall(orgId, { provider_call_sid: "CA" + "2".repeat(32), started_at: new Date(Date.now() - 7.5 * 86400_000), ended_at: new Date(Date.now() - 7.5 * 86400_000) });
    const { sweepPendingCosts } = await import("../src/modules/usage/costs.js");
    expect(await sweepPendingCosts()).toEqual({ checked: 2, priced: 1 });
    const rows = (await pool.query("SELECT id, cost_status FROM calls")).rows;
    expect(rows.find((r) => r.id === recent).cost_status).toBe("pending");
    expect(rows.find((r) => r.id === old).cost_status).toBe("unavailable");
  });

  it("AI call: Twilio actual + OpenAI estimate kept separate", async () => {
    const { orgId } = await setupOrg();
    const id = await insertCall(orgId, {
      mode: "ai", provider_call_sid: "CA" + "d".repeat(32),
      metadata: { aiModel: "gpt-realtime-2.1", transcribeModel: "gpt-4o-mini-transcribe", aiUsage: { input_audio_tokens: 10_000, output_audio_tokens: 5_000, input_text_tokens: 0, output_text_tokens: 0, cached_tokens: 0, transcribe_input_tokens: 0, transcribe_output_tokens: 0 } },
    });
    await pool.query("INSERT INTO usage_records (org_id, call_id, provider, category, quantity, unit) VALUES ($1,$2,'openai','ai_audio',10000,'input_audio_tokens')", [orgId, id]);
    prices.set("CA" + "d".repeat(32), "-0.05000");
    await computeCallCost(id);
    const c = (await pool.query("SELECT telephony_cost_usd::float t, ai_cost_usd::float ai, estimated_cost_usd::float e FROM calls WHERE id = $1", [id])).rows[0];
    expect(c.t).toBe(0.05);
    expect(c.ai).toBeCloseTo(0.32 + 0.32, 6); // 10k × $32/M + 5k × $64/M
    expect(c.e).toBeCloseTo(0.69, 6);
    expect((await pool.query("SELECT estimated_cost_usd::float u FROM usage_records WHERE call_id = $1 AND unit = 'input_audio_tokens'", [id])).rows[0].u).toBeCloseTo(0.32, 6);
  });

  it("owner price overrides change estimates; other roles can't edit prices", async () => {
    const { agent, orgId, email } = await setupOrg();
    expect((await agent.put("/api/usage/pricing").send({ overrides: { "gpt-realtime-2.1:output_audio_tokens": 50 } })).status).toBe(200);
    expect((await pricesFor(orgId))["gpt-realtime-2.1:output_audio_tokens"]).toMatchObject({ usd: 50, default: 64, overridden: true });
    expect((await agent.put("/api/usage/pricing").send({ overrides: { "made-up:thing": 1 } })).status).toBe(400);
    await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
    expect((await agent.put("/api/usage/pricing").send({ overrides: { "gpt-realtime-2.1:output_audio_tokens": 1 } })).status).toBe(403);
  });
});

describe("usage summary and Twilio reconciliation", () => {
  it("summarises the month by mode, country, day, tokens and campaign", async () => {
    const { agent, orgId } = await setupOrg();
    const month = new Date().toISOString().slice(0, 7);
    await insertCall(orgId, { telephony_cost_usd: 0.1, estimated_cost_usd: 0.1, cost_status: "final", duration_sec: 120 });
    await insertCall(orgId, { mode: "ai", to_country_iso: "GB", to_number: "+442079460958", telephony_cost_usd: 0.05, ai_cost_usd: 0.2, estimated_cost_usd: 0.25, cost_status: "final" });
    await insertCall(orgId, { started_at: "2020-01-01T00:00:00Z", estimated_cost_usd: 99 }); // other month
    const s = (await agent.get(`/api/usage/summary?month=${month}`)).body;
    expect(s.totals).toMatchObject({ calls: 2, seconds: 180, telephony_usd: 0.15, ai_usd: 0.2, total_usd: 0.35 });
    expect(s.byCountry.map((c: any) => c.country)).toEqual(["AE", "GB"]);
    expect(s.byMode).toHaveLength(2);
    expect(s.byDay).toHaveLength(1);
    expect((await agent.get("/api/usage/summary?month=2026-13")).status).toBe(400);
  });

  it("stores Twilio's own billed usage, separately from estimates", async () => {
    const { agent } = await setupOrg();
    usageList.mockResolvedValue([
      { category: "calls-outbound", price: 1.23, priceUnit: "usd", description: "Outbound calls", usage: "10", usageUnit: "minutes", count: "5" },
      { category: "sms", price: 0, priceUnit: "usd" },
    ]);
    const month = new Date().toISOString().slice(0, 7);
    expect((await agent.post(`/api/usage/reconcile?month=${month}`)).body).toEqual({ ok: true, categories: 1 });
    const s = (await agent.get(`/api/usage/summary?month=${month}`)).body;
    expect(s.twilioBilled).toEqual([expect.objectContaining({ category: "calls-outbound", amount_usd: 1.23 })]);
  });
});

describe("spending limits", () => {
  it("alerts once at the threshold; in block mode stops new AI calls and pauses campaigns", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    expect((await agent.put("/api/usage/limits").send({ monthlyLimitUsd: 1, alertThresholdPct: 50, action: "alert" })).status).toBe(200);
    const id = await insertCall(orgId, { provider_call_sid: "CA" + "e".repeat(32) });
    prices.set("CA" + "e".repeat(32), "-0.60000");
    await computeCallCost(id);
    const alerts = (await pool.query("SELECT level FROM spend_alerts")).rows.map((r) => r.level);
    expect(alerts).toEqual(["threshold"]);
    // alert-only mode doesn't block
    expect((await agent.post("/api/calls/ai").send({ to: "+971501234567", agentId, idempotencyKey: "spend-key-001" })).status).toBe(201);

    const id2 = await insertCall(orgId, { provider_call_sid: "CA" + "f".repeat(32) });
    prices.set("CA" + "f".repeat(32), "-0.50000");
    await computeCallCost(id2); // month-to-date $1.10 ≥ $1 limit
    expect((await pool.query("SELECT level FROM spend_alerts ORDER BY level")).rows.map((r) => r.level)).toEqual(["limit", "threshold"]);
    expect((await agent.put("/api/usage/limits").send({ monthlyLimitUsd: 1, alertThresholdPct: 50, action: "block" })).status).toBe(200);
    const blocked = await agent.post("/api/calls/ai").send({ to: "+971501234568", agentId, idempotencyKey: "spend-key-002" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/spending limit/);

    const camp = await pool.query(`INSERT INTO campaigns (org_id, name, ai_agent_id, status) VALUES ($1,'C',$2,'running') RETURNING id`, [orgId, agentId]);
    await engine.runCampaignTick(async () => {});
    expect((await pool.query("SELECT status FROM campaigns WHERE id = $1", [camp.rows[0].id])).rows[0].status).toBe("paused");
    const s = (await agent.get("/api/usage/summary")).body.spend;
    expect(s).toMatchObject({ action: "block", overLimit: true });
  });
});

describe("security hardening", () => {
  it("refuses cross-site form posts to the API", async () => {
    const { agent } = await setupOrg();
    const res = await agent.post("/api/contacts/dnc").type("form").send({ phone: "+971501234567" });
    expect(res.status).toBe(415);
    const textPlain = await agent.post("/api/auth/logout").set("Content-Type", "text/plain").send("x");
    expect(textPlain.status).toBe(415);
  });

  it("locks an account after 10 failed sign-ins, even from different IPs", async () => {
    const { email, password } = await signUp();
    for (let i = 0; i < 10; i++) await request(app).post("/api/auth/login").set("X-Forwarded-For", `10.0.0.${i}`).send({ email, password: "wrong-password-1" });
    const locked = await request(app).post("/api/auth/login").send({ email, password });
    expect(locked.status).toBe(403);
    expect(locked.body.error.message).toMatch(/Too many failed sign-in attempts/);
  });

  it("successful sign-in clears earlier failures", async () => {
    const { email, password } = await signUp();
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/login").send({ email, password: "wrong-password-1" });
    expect((await request(app).post("/api/auth/login").send({ email, password })).status).toBe(200);
    expect(await redis().get(`acp:loginfail:${email}`)).toBeNull();
  });

  it("audit log is visible to the owner only", async () => {
    const { agent, email } = await setupOrg();
    const res = await agent.get("/api/settings/audit");
    expect(res.body.entries.map((e: any) => e.action)).toContain("integration.twilio.saved");
    await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
    expect((await agent.get("/api/settings/audit")).status).toBe(403);
  });
});
