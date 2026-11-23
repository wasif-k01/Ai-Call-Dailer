import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { closeRedis } from "../src/lib/redis.js";

// Twilio is fully mocked: no real network calls, no real phone numbers.
vi.mock("../src/modules/integrations/providers/twilio.js", async (orig) => {
  const actual = await orig<typeof import("../src/modules/integrations/providers/twilio.js")>();
  return {
    ...actual,
    fetchAccount: vi.fn(), verifyApiKey: vi.fn(async () => {}),
    fetchNumbers: vi.fn(),
    fetchGeoPermissions: vi.fn(),
  };
});
const tw = await import("../src/modules/integrations/providers/twilio.js");
const { resetDb, signUp } = await import("./helpers.js");

const OPENAI_KEY = "sk-proj-TESTKEY1234567890abcdefXYZ9";
const SID = "AC" + "a".repeat(32);
const TOKEN = "b".repeat(32);

beforeEach(async () => {
  await resetDb();
  vi.mocked(tw.fetchAccount).mockReset();
  vi.mocked(tw.fetchNumbers).mockReset();
  vi.mocked(tw.fetchGeoPermissions).mockReset();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeRedis();
  await pool.end();
});

function mockOpenAI(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-realtime-2.1" }, { id: "gpt-4.1" }] }), { status: 200 });
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OpenAI integration", () => {
  it("validates key format before saving", async () => {
    const { agent } = await signUp();
    const res = await agent.put("/api/integrations/openai").send({ apiKey: "not-a-key", model: "gpt-realtime-2.1", voice: "marin" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].message).toMatch(/sk-/);
  });

  it("stores the key encrypted and never returns it", async () => {
    const { agent } = await signUp();
    const res = await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
    expect(res.status).toBe(200);
    const list = await agent.get("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain(OPENAI_KEY);
    expect(list.body.openai.secrets.api_key).toBe("••••XYZ9");
    expect(list.body.openai.status).toBe("not_connected"); // saved but not yet tested
    const { rows } = await pool.query("SELECT ciphertext FROM encrypted_credentials");
    expect(rows[0].ciphertext).not.toContain("sk-");
  });

  it("marks connected only after a successful test, sends the key only to OpenAI", async () => {
    const { agent } = await signUp();
    await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "cedar" });
    const fetchMock = mockOpenAI(200, { id: "gpt-realtime-2.1" });
    const res = await agent.post("/api/integrations/openai/test");
    expect(res.body.ok).toBe(true);
    expect(res.body.integration.status).toBe("connected");
    expect(res.body.integration.config.availableRealtimeModels).toEqual(["gpt-realtime-2.1"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models/gpt-realtime-2.1");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("explains an invalid key in plain English and records the error", async () => {
    const { agent } = await signUp();
    await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
    mockOpenAI(401, { error: { code: "invalid_api_key" } });
    const res = await agent.post("/api/integrations/openai/test");
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/rejected the API key/);
    expect(res.body.integration.status).toBe("error");
  });

  it("explains missing credit", async () => {
    const { agent } = await signUp();
    await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
    mockOpenAI(429, { error: { code: "insufficient_quota" } });
    expect((await agent.post("/api/integrations/openai/test")).body.message).toMatch(/no credit/);
  });

  it("allows updating settings without re-entering the key; changes reset status", async () => {
    const { agent } = await signUp();
    await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
    mockOpenAI(200);
    await agent.post("/api/integrations/openai/test");
    const upd = await agent.put("/api/integrations/openai").send({ model: "gpt-realtime-2.1-mini", voice: "marin" });
    expect(upd.status).toBe(200);
    expect(upd.body.integration.secrets.api_key).toBe("••••XYZ9");
    expect(upd.body.integration.status).toBe("not_connected");
  });

  it("disconnect deletes stored credentials", async () => {
    const { agent } = await signUp();
    await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
    await agent.delete("/api/integrations/openai");
    expect((await pool.query("SELECT count(*)::int n FROM encrypted_credentials")).rows[0].n).toBe(0);
  });

  it("only owners/admins can manage integrations", async () => {
    const { agent, email } = await signUp();
    await pool.query("UPDATE users SET role = 'agent' WHERE email = $1", [email]);
    expect((await agent.get("/api/integrations")).status).toBe(403);
    expect((await agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" })).status).toBe(403);
  });
});

describe("Twilio integration & phone numbers", () => {
  async function connectTwilio(type: "Trial" | "Full" = "Full") {
    const s = await signUp();
    vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "My Account", status: "active", type });
    vi.mocked(tw.fetchNumbers).mockResolvedValue([
      { e164: "+14155550100", providerSid: "PN1", friendlyName: "Main US", countryIso: "US", numberType: "provider_owned", capabilities: { voice: true, sms: true } },
      { e164: "+971501234567", providerSid: "CA1", friendlyName: "My mobile", countryIso: "AE", numberType: "verified_caller_id", capabilities: { voice: true } },
    ]);
    await s.agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN });
    const res = await s.agent.post("/api/integrations/twilio/test");
    return { ...s, res };
  }

  it("validates SID / token formats", async () => {
    const { agent } = await signUp();
    const res = await agent.put("/api/integrations/twilio").send({ accountSid: "AC123", authToken: "short" });
    expect(res.status).toBe(400);
  });

  it("connects, syncs numbers, and makes the US Twilio number the default", async () => {
    const { agent, res } = await connectTwilio();
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/Found 2 number/);
    const nums = (await agent.get("/api/phone-numbers")).body.numbers;
    const def = nums.find((n: any) => n.is_default);
    expect(def.e164).toBe("+14155550100");
    expect(nums.find((n: any) => n.e164 === "+971501234567").number_type).toBe("verified_caller_id");
    expect(JSON.stringify((await agent.get("/api/integrations")).body)).not.toContain(TOKEN);
  });

  it("explains rejected credentials", async () => {
    const { agent } = await signUp();
    vi.mocked(tw.fetchAccount).mockRejectedValue(Object.assign(new Error("Authenticate"), { status: 401, code: 20003 }));
    await agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN });
    const res = await agent.post("/api/integrations/twilio/test");
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/rejected these credentials/);
    expect(res.body.integration.status).toBe("error");
  });

  it("marks numbers that disappeared from Twilio as released", async () => {
    const { agent } = await connectTwilio();
    vi.mocked(tw.fetchNumbers).mockResolvedValue([
      { e164: "+14155550100", providerSid: "PN1", friendlyName: "Main US", countryIso: "US", numberType: "provider_owned", capabilities: { voice: true } },
    ]);
    await agent.post("/api/phone-numbers/sync");
    const nums = (await agent.get("/api/phone-numbers")).body.numbers;
    expect(nums.find((n: any) => n.e164 === "+971501234567").status).toBe("released");
  });

  it("refuses external numbers as caller ID until verified in Twilio", async () => {
    const { agent } = await connectTwilio();
    const add = await agent.post("/api/phone-numbers").send({ numberType: "external", value: "+44 20 7946 0958" });
    expect(add.status).toBe(201);
    expect(add.body.number.e164).toBe("+442079460958");
    expect(add.body.number.status).toBe("unverified");
    const def = await agent.post(`/api/phone-numbers/${add.body.number.id}/default`);
    expect(def.status).toBe(400);
  });

  it("can switch default to a verified caller ID", async () => {
    const { agent } = await connectTwilio();
    const nums = (await agent.get("/api/phone-numbers")).body.numbers;
    const ae = nums.find((n: any) => n.e164 === "+971501234567");
    expect((await agent.post(`/api/phone-numbers/${ae.id}/default`)).status).toBe(200);
    const after = (await agent.get("/api/phone-numbers")).body.numbers;
    expect(after.filter((n: any) => n.is_default).map((n: any) => n.e164)).toEqual(["+971501234567"]);
  });

  it("checks geo permissions and records the setup step", async () => {
    const { agent } = await connectTwilio("Trial");
    vi.mocked(tw.fetchGeoPermissions).mockResolvedValue([
      { isoCode: "US", name: "United States", countryCodes: ["+1"], lowRiskNumbersEnabled: true, highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false },
      { isoCode: "PK", name: "Pakistan", countryCodes: ["+92"], lowRiskNumbersEnabled: false, highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false },
    ]);
    const res = await agent.get("/api/phone-numbers/destinations?countries=US,PK");
    expect(res.status).toBe(200);
    expect(res.body.accountType).toBe("Trial");
    expect(vi.mocked(tw.fetchGeoPermissions).mock.calls[0][1]).toEqual(["US", "PK"]);
    const setup = (await agent.get("/api/setup")).body;
    expect(setup.steps.find((s: any) => s.key === "geo_permissions")).toMatchObject({ status: "verified", details: { disabled: ["PK"] } });
  });
});

describe("setup wizard", () => {
  it("starts at 0% and never marks unbuilt steps as done", async () => {
    const { agent } = await signUp();
    const res = await agent.get("/api/setup");
    expect(res.body.percent).toBe(0);
    expect(res.body.steps).toHaveLength(8);
    expect(res.body.steps.find((s: any) => s.key === "test_ai_call").status).toBe("not_available_yet");
  });
});

describe("Twilio API key check", () => {
  it("validates Standard API keys without touching the Account resource (Twilio 70004)", async () => {
    const { agent } = await signUp();
    vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "Acct", status: "active", type: "Full" });
    vi.mocked(tw.fetchNumbers).mockResolvedValue([]);
    await agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN, apiKeySid: "SK" + "4".repeat(32), apiKeySecret: "x".repeat(32) });
    const res = await agent.post("/api/integrations/twilio/test");
    expect(res.body.ok).toBe(true);
    expect(tw.verifyApiKey).toHaveBeenCalledWith(expect.objectContaining({ apiKeySid: "SK" + "4".repeat(32) }));
    // the Account resource is only ever read with the Auth Token
    for (const [creds] of vi.mocked(tw.fetchAccount).mock.calls) expect(creds.apiKeySid).toBeUndefined();
  });

  it("explains a rejected API key", async () => {
    const { agent } = await signUp();
    vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "Acct", status: "active", type: "Full" });
    vi.mocked(tw.verifyApiKey).mockRejectedValueOnce(Object.assign(new Error("Authenticate"), { status: 401, code: 20003 }));
    await agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN, apiKeySid: "SK" + "4".repeat(32), apiKeySecret: "x".repeat(32) });
    const res = await agent.post("/api/integrations/twilio/test");
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/API Key SID \/ Secret were rejected/);
  });
});
