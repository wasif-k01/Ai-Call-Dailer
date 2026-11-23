import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import twilio from "twilio";
import jwt from "jsonwebtoken";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";

// ── Fake Twilio client: records every call, never touches the network ──
const calls = { update: vi.fn() };
const participants = { create: vi.fn(), update: vi.fn() };
const apps = { fetch: vi.fn(), update: vi.fn(), create: vi.fn() };
const fakeClient = {
  calls: vi.fn((sid: string) => ({ update: (p: unknown) => calls.update(sid, p) })),
  conferences: vi.fn((name: string) => ({
    participants: Object.assign((sid: string) => ({ update: (p: unknown) => participants.update(name, sid, p) }), {
      create: (p: unknown) => participants.create(name, p),
    }),
  })),
  applications: Object.assign((sid: string) => ({ fetch: () => apps.fetch(sid), update: (p: unknown) => apps.update(sid, p) }), {
    create: (p: unknown) => apps.create(p),
  }),
};

vi.mock("../src/modules/integrations/providers/twilio.js", async (orig) => {
  const actual = await orig<typeof import("../src/modules/integrations/providers/twilio.js")>();
  return { ...actual, twilioClient: vi.fn(() => fakeClient), fetchAccount: vi.fn(), verifyApiKey: vi.fn(async () => {}), fetchNumbers: vi.fn(), fetchGeoPermissions: vi.fn() };
});
const tw = await import("../src/modules/integrations/providers/twilio.js");
const { app, resetDb, signUp } = await import("./helpers.js");

const SID = "AC" + "1".repeat(32);
const TOKEN = "2".repeat(32);
const API_KEY = "SK" + "3".repeat(32);
const API_SECRET = "s".repeat(32);
const BASE = "https://api.test.example";
const BROWSER_SID = "CA" + "b".repeat(32);
const CUSTOMER_SID = "CA" + "c".repeat(32);

function geo(allowed: Record<string, boolean>) {
  vi.mocked(tw.fetchGeoPermissions).mockImplementation(async (_c, isos) =>
    isos.map((iso) => ({ isoCode: iso, name: iso, countryCodes: [], lowRiskNumbersEnabled: !!allowed[iso], highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false })),
  );
}

/** Sends a webhook exactly as Twilio would, with a valid X-Twilio-Signature. */
function twilioPost(path: string, params: Record<string, string>, token = TOKEN) {
  const sig = twilio.getExpectedTwilioSignature(token, BASE + path, params);
  return request(app).post(path).set("X-Twilio-Signature", sig).type("form").send(params);
}

async function setupOrg(withApiKey = true) {
  const s = await signUp();
  vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "Acct", status: "active", type: "Full" });
  vi.mocked(tw.fetchNumbers).mockResolvedValue([
    { e164: "+14155550100", providerSid: "PN1", friendlyName: "US", countryIso: "US", numberType: "provider_owned", capabilities: { voice: true } },
  ]);
  await s.agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN, ...(withApiKey ? { apiKeySid: API_KEY, apiKeySecret: API_SECRET } : {}) });
  await s.agent.post("/api/integrations/twilio/test");
  const me = (await s.agent.get("/api/auth/me")).body;
  return { ...s, userId: me.user.id as string, orgId: me.organization.id as string };
}

async function prepare(agent: any, to = "+971501234567", key = `k-${Math.random()}`) {
  return agent.post("/api/calls/human").send({ to, idempotencyKey: key });
}

beforeEach(async () => {
  await resetDb();
  const keys = await redis().keys("acp:geo:*");
  if (keys.length) await redis().del(...keys);
  for (const f of [calls.update, participants.create, participants.update, apps.fetch, apps.update, apps.create]) f.mockReset();
  participants.create.mockResolvedValue({ callSid: CUSTOMER_SID });
  calls.update.mockResolvedValue({});
  apps.create.mockResolvedValue({ sid: "AP" + "9".repeat(32) });
  geo({ US: true, AE: true, GB: true, PK: false });
});
afterAll(async () => {
  await closeRedis();
  await pool.end();
});

describe("preparing a human call", () => {
  it("rejects invalid numbers in plain English", async () => {
    const { agent } = await setupOrg();
    const res = await prepare(agent, "12345");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/isn't valid/);
  });

  it("blocks countries switched off in Twilio Geo Permissions", async () => {
    const { agent } = await setupOrg();
    const res = await prepare(agent, "+923001234567");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Geo permissions/);
  });

  it("blocks numbers on the Do Not Call list", async () => {
    const { agent, orgId } = await setupOrg();
    await pool.query("INSERT INTO do_not_call_list (org_id, phone_e164) VALUES ($1, '+971501234567')", [orgId]);
    const res = await prepare(agent);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Do Not Call/);
  });

  it("normalises the number, uses the default US caller ID, and is idempotent", async () => {
    const { agent } = await setupOrg();
    const a = await prepare(agent, "+971 50 123 4567", "same-key-123");
    expect(a.status).toBe(201);
    expect(a.body.call).toMatchObject({ to_number: "+971501234567", from_number: "+14155550100", status: "initiated", to_country_iso: "AE" });
    const b = await prepare(agent, "+971 50 123 4567", "same-key-123");
    expect(b.body.duplicate).toBe(true);
    expect(b.body.call.id).toBe(a.body.call.id);
    expect((await pool.query("SELECT count(*)::int n FROM calls")).rows[0].n).toBe(1);
  });

  it("allows only one active call per user", async () => {
    const { agent } = await setupOrg();
    await prepare(agent);
    expect((await prepare(agent, "+442079460958")).status).toBe(409);
  });

  it("viewers cannot place calls", async () => {
    const { agent, email } = await setupOrg();
    await pool.query("UPDATE users SET role = 'viewer' WHERE email = $1", [email]);
    expect((await prepare(agent)).status).toBe(403);
  });
});

describe("browser voice token", () => {
  it("explains that an API key is required", async () => {
    const { agent } = await setupOrg(false);
    const res = await agent.post("/api/voice/token");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/API Key/);
  });

  it("creates the TwiML App with public https webhooks and issues an outgoing-only token", async () => {
    const { agent, userId } = await setupOrg();
    const res = await agent.post("/api/voice/token");
    expect(res.status).toBe(200);
    expect(apps.create).toHaveBeenCalledWith(expect.objectContaining({ voiceUrl: `${BASE}/webhooks/twilio/voice/client`, statusCallback: `${BASE}/webhooks/twilio/client-status` }));
    const decoded = jwt.decode(res.body.token) as any;
    expect(decoded.iss).toBe(API_KEY);
    expect(decoded.grants.identity).toBe(`u_${userId}`);
    expect(decoded.grants.voice.outgoing.application_sid).toBe("AP" + "9".repeat(32));
    expect(decoded.grants.voice.incoming?.allow).not.toBe(true);
  });

  it("repairs the TwiML App when the public URL changed", async () => {
    const { agent } = await setupOrg();
    await agent.post("/api/voice/token");
    apps.fetch.mockResolvedValue({ voiceUrl: "https://old-tunnel.example/webhooks/twilio/voice/client", statusCallback: "x" });
    await agent.post("/api/voice/token");
    expect(apps.update).toHaveBeenCalledWith("AP" + "9".repeat(32), expect.objectContaining({ voiceUrl: `${BASE}/webhooks/twilio/voice/client` }));
  });
});

describe("Twilio webhooks", () => {
  async function startCall() {
    const s = await setupOrg();
    const call = (await prepare(s.agent)).body.call;
    return { ...s, callId: call.id as string };
  }
  const clientParams = (callId: string, userId: string) => ({ CallSid: BROWSER_SID, From: `client:u_${userId}`, callId, AccountSid: SID });
  const flush = () => new Promise((r) => setTimeout(r, 50));

  it("rejects unsigned or forged requests", async () => {
    const { callId, userId } = await startCall();
    expect((await request(app).post("/webhooks/twilio/voice/client").type("form").send(clientParams(callId, userId))).status).toBe(403);
    expect((await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId), "f".repeat(32))).status).toBe(403);
  });

  it("joins the browser to a conference and dials the recipient into it", async () => {
    const { callId, userId, agent } = await startCall();
    const res = await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<Conference`);
    expect(res.text).toContain(`acp-${callId}`);
    await flush();
    expect(participants.create).toHaveBeenCalledWith(`acp-${callId}`, expect.objectContaining({
      from: "+14155550100", to: "+971501234567", earlyMedia: true,
      statusCallback: `${BASE}/webhooks/twilio/status?callId=${callId}`,
    }));
    const call = (await agent.get(`/api/calls/${callId}`)).body.call;
    expect(call.status).toBe("queued");
  });

  it("a prepared call can only be started once, and only by its owner", async () => {
    const { callId, userId } = await startCall();
    const wrongUser = await twilioPost("/webhooks/twilio/voice/client", { ...clientParams(callId, userId), From: "client:u_someone-else" });
    expect(wrongUser.text).toContain("<Hangup");
    await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    const replay = await twilioPost("/webhooks/twilio/voice/client", { ...clientParams(callId, userId), CallSid: "CA" + "d".repeat(32) });
    expect(replay.text).toContain("<Hangup");
    await flush();
    expect(participants.create).toHaveBeenCalledTimes(1);
  });

  it("tracks status forward only, records duration, and ends the browser leg", async () => {
    const { callId, userId, agent } = await startCall();
    await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    await flush();
    const status = (s: string, extra: Record<string, string> = {}) =>
      twilioPost(`/webhooks/twilio/status?callId=${callId}`, { CallSid: CUSTOMER_SID, CallStatus: s, ...extra });
    await status("ringing");
    await status("in-progress");
    expect((await agent.get(`/api/calls/${callId}`)).body.call.status).toBe("in_progress");
    await status("completed", { CallDuration: "42" });
    await status("ringing"); // late, out-of-order retry
    const call = (await agent.get(`/api/calls/${callId}`)).body.call;
    expect(call).toMatchObject({ status: "completed", duration_sec: 42 });
    expect(calls.update).toHaveBeenCalledWith(BROWSER_SID, expect.anything());
  });

  it("marks the call failed with a plain-English reason when dialing fails", async () => {
    const { callId, userId, agent } = await startCall();
    participants.create.mockRejectedValue(Object.assign(new Error("geo"), { code: 21215, status: 400 }));
    await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    await flush();
    const call = (await agent.get(`/api/calls/${callId}`)).body.call;
    expect(call.status).toBe("failed");
    expect(call.error_message).toMatch(/Geo Permissions/);
  });

  it("cancels the call if the browser hangs up before anyone answers", async () => {
    const { callId, userId, agent } = await startCall();
    await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    await flush();
    await twilioPost("/webhooks/twilio/client-status", { CallSid: BROWSER_SID, CallStatus: "completed" });
    expect((await agent.get(`/api/calls/${callId}`)).body.call.status).toBe("canceled");
    expect(calls.update).toHaveBeenCalledWith(CUSTOMER_SID, expect.anything());
  });

  it("hold and keypad work once answered", async () => {
    const { callId, userId, agent } = await startCall();
    expect((await agent.post(`/api/calls/${callId}/hold`).send({ hold: true })).status).toBe(400);
    await twilioPost("/webhooks/twilio/voice/client", clientParams(callId, userId));
    await flush();
    await twilioPost(`/webhooks/twilio/status?callId=${callId}`, { CallSid: CUSTOMER_SID, CallStatus: "in-progress" });

    expect((await agent.post(`/api/calls/${callId}/dtmf`).send({ digits: "12#" })).status).toBe(200);
    const [sid, upd] = calls.update.mock.calls.at(-1)!;
    expect(sid).toBe(CUSTOMER_SID);
    expect((upd as any).twiml).toContain('<Play digits="12#"/>');
    expect((upd as any).twiml).toContain(`acp-${callId}`);
    expect((await agent.post(`/api/calls/${callId}/dtmf`).send({ digits: "1<x>" })).status).toBe(400);

    const hold = await agent.post(`/api/calls/${callId}/hold`).send({ hold: true });
    expect(hold.status).toBe(200);
    expect(participants.update).toHaveBeenCalledWith(`acp-${callId}`, CUSTOMER_SID, expect.objectContaining({ hold: true }));
    expect((await agent.post(`/api/calls/${callId}/dtmf`).send({ digits: "1" })).status).toBe(400); // not while on hold
    expect((await agent.get(`/api/calls/${callId}`)).body.call.on_hold).toBe(true);

    const holdTwiml = await twilioPost(`/webhooks/twilio/hold?callId=${callId}`, {});
    expect(holdTwiml.text).toContain("Please hold");
  });
});
