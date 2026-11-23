import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import twilio from "twilio";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";

const calls = { create: vi.fn(), update: vi.fn() };
const participants = { create: vi.fn(), update: vi.fn() };
const recordings = { remove: vi.fn() };
const fakeClient = {
  calls: Object.assign((sid: string) => ({ update: (p: unknown) => calls.update(sid, p) }), { create: (p: unknown) => calls.create(p) }),
  conferences: (name: string) => ({
    participants: Object.assign((sid: string) => ({ update: (p: unknown) => participants.update(name, sid, p) }), { create: (p: unknown) => participants.create(name, p) }),
  }),
  recordings: (sid: string) => ({ remove: () => recordings.remove(sid) }),
};
vi.mock("../src/modules/integrations/providers/twilio.js", async (orig) => {
  const actual = await orig<typeof import("../src/modules/integrations/providers/twilio.js")>();
  return { ...actual, twilioClient: vi.fn(() => fakeClient), fetchAccount: vi.fn(), verifyApiKey: vi.fn(), fetchNumbers: vi.fn(), fetchGeoPermissions: vi.fn() };
});
const tw = await import("../src/modules/integrations/providers/twilio.js");
const { app, resetDb, signUp } = await import("./helpers.js");

const SID = "AC" + "1".repeat(32);
const TOKEN = "2".repeat(32);
const BASE = "https://api.test.example";

beforeEach(async () => {
  await resetDb();
  const keys = await redis().keys("acp:geo:*");
  if (keys.length) await redis().del(...keys);
  let n = 0;
  calls.create.mockReset().mockImplementation(async () => ({ sid: "CA" + String(++n).padStart(32, "7") }));
  calls.update.mockReset().mockResolvedValue({});
  participants.create.mockReset().mockResolvedValue({ callSid: "CA" + "8".repeat(32) });
  participants.update.mockReset().mockResolvedValue({});
  recordings.remove.mockReset().mockResolvedValue(true);
  vi.unstubAllGlobals();
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
  await s.agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN });
  await s.agent.post("/api/integrations/twilio/test");
  await s.agent.put("/api/integrations/openai").send({ apiKey: "sk-proj-TESTKEY1234567890abcdefXYZ9", model: "gpt-realtime-2.1", voice: "marin" });
  await pool.query("UPDATE integrations SET status = 'connected' WHERE provider = 'openai'");
  const me = (await s.agent.get("/api/auth/me")).body;
  const agentId = (await s.agent.get("/api/agents")).body.agents[0].id as string;
  return { ...s, agentId, orgId: me.organization.id as string, userId: me.user.id as string };
}

const twilioPost = (path: string, params: Record<string, string>) =>
  request(app).post(path).set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(TOKEN, BASE + path, params)).type("form").send(params);

async function seedCalls(orgId: string, agentId: string) {
  const ins = (mode: string, to: string, status: string, started: string, extra = "") =>
    pool.query(
      `INSERT INTO calls (org_id, mode, from_number, to_number, to_country_iso, status, started_at, duration_sec, ai_agent_id ${extra ? ", error_message" : ""})
       VALUES ($1,$2,'+14155550100',$3,'AE',$4,$5,60,$6 ${extra ? ", $7" : ""}) RETURNING id`,
      extra ? [orgId, mode, to, status, started, mode === "ai" ? agentId : null, extra] : [orgId, mode, to, status, started, mode === "ai" ? agentId : null],
    );
  const a = (await ins("ai", "+971501111111", "completed", "2026-11-20T10:00:00Z")).rows[0].id;
  await ins("human", "+971502222222", "no_answer", "2026-11-21T10:00:00Z");
  await ins("human", "+447700900001", "failed", "2026-11-22T10:00:00Z", "=HYPERLINK(\"http://evil\")");
  await ins("ai", "+971503333333", "in_progress", new Date().toISOString());
  return a;
}

describe("call history", () => {
  it("filters, searches and paginates; other orgs see nothing", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    await seedCalls(orgId, agentId);
    expect((await agent.get("/api/calls")).body.total).toBe(4);
    expect((await agent.get("/api/calls?mode=ai")).body.total).toBe(2);
    expect((await agent.get("/api/calls?status=no_answer")).body.calls[0].to_number).toBe("+971502222222");
    expect((await agent.get("/api/calls?q=2222")).body.total).toBe(1);
    expect((await agent.get("/api/calls?from=2026-11-21&to=2026-11-21")).body.total).toBe(1);
    expect((await agent.get(`/api/calls?agentId=${agentId}`)).body.calls[0].agent_name).toBe("General Assistant");
    const p = (await agent.get("/api/calls?pageSize=10&page=1")).body;
    expect(p.calls).toHaveLength(4);
    const other = await signUp();
    expect((await other.agent.get("/api/calls")).body.total).toBe(0);
  });

  it("exports CSV safely (no spreadsheet formula injection)", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    await seedCalls(orgId, agentId);
    const res = await agent.get("/api/calls/export.csv");
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="?call-history-/);
    const lines = res.text.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toMatch(/^Call ID,Started,Ended,Mode,Status,From,To/);
    expect(lines).toHaveLength(5);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.text).toContain(`"+971501111111"`);
  });

  it("lists live calls and returns full call detail", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    const id = await seedCalls(orgId, agentId);
    const live = (await agent.get("/api/calls/live")).body.calls;
    expect(live.map((c: any) => c.to_number)).toEqual(["+971503333333"]);
    await pool.query("INSERT INTO call_transcripts (org_id, call_id, speaker, text) VALUES ($1,$2,'ai','Hello, I am an AI assistant.')", [orgId, id]);
    await pool.query("INSERT INTO call_events (org_id, call_id, event_type) VALUES ($1,$2,'ai.stream_started')", [orgId, id]);
    const d = (await agent.get(`/api/calls/${id}/detail`)).body;
    expect(d.call).toMatchObject({ id, agent_name: "General Assistant", transcript_count: 1 });
    expect(d.events.map((e: any) => e.event_type)).toEqual(["ai.stream_started"]);
    expect(d.transcript[0].text).toBe("Hello, I am an AI assistant.");
  });
});

describe("recordings", () => {
  it("is off by default; when enabled, AI calls are recorded and the AI is told to announce it", async () => {
    const { agent, agentId } = await setupOrg();
    await agent.post("/api/calls/ai").send({ to: "+971501234567", agentId, idempotencyKey: "rec-off-key-0001" });
    expect(calls.create.mock.calls[0][0]).not.toHaveProperty("record");
    expect((await agent.put("/api/settings/calling").send({ recordingEnabled: true, maxConcurrentAiCalls: 5 })).status).toBe(200);
    await pool.query("UPDATE calls SET status = 'completed'");
    const r = await agent.post("/api/calls/ai").send({ to: "+971501234568", agentId, idempotencyKey: "rec-on-key-0001" });
    expect(r.status).toBe(201);
    expect(calls.create.mock.calls[1][0]).toMatchObject({
      record: true, recordingChannels: "dual",
      recordingStatusCallback: `${BASE}/webhooks/twilio/recording?callId=${r.body.call.id}`,
    });
    const { buildInstructions, getAgent } = await import("../src/modules/ai/agents.js");
    const org = (await pool.query("SELECT org_id FROM calls LIMIT 1")).rows[0].org_id;
    expect(buildInstructions((await getAgent(org, agentId))!, null, { recording: true })).toMatch(/This call is being recorded/);
  });

  it("human calls record the conference when enabled", async () => {
    const { agent, userId } = await setupOrg();
    await agent.put("/api/settings/calling").send({ recordingEnabled: true, maxConcurrentAiCalls: 2 });
    const callId = (await agent.post("/api/calls/human").send({ to: "+971501234567", idempotencyKey: "human-rec-key-0001" })).body.call.id;
    const res = await twilioPost("/webhooks/twilio/voice/client", { CallSid: "CA" + "b".repeat(32), From: `client:u_${userId}`, callId });
    expect(res.text).toContain('record="record-from-start"');
    expect(res.text).toContain(`/webhooks/twilio/recording?callId=${callId}`);
  });

  it("stores finished recordings, streams them only through the API, and deletes them in Twilio", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    const callId = await seedCalls(orgId, agentId);
    await twilioPost(`/webhooks/twilio/recording?callId=${callId}`, { RecordingSid: "RE" + "1".repeat(32), RecordingStatus: "completed", RecordingDuration: "42", RecordingChannels: "2", CallSid: "CA" + "7".repeat(32) });
    const list = (await agent.get("/api/recordings")).body;
    expect(list.recordings[0]).toMatchObject({ call_id: callId, duration_sec: 42 });
    expect(JSON.stringify(list)).not.toMatch(/api\.twilio\.com|RE1111/); // no provider URL or SID leaks

    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-2/100", "accept-ranges": "bytes" } }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = await agent.get(`/api/recordings/${list.recordings[0].id}/audio`).set("Range", "bytes=0-2").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(audio.status).toBe(206);
    expect(audio.headers["content-type"]).toBe("audio/mpeg");
    expect(audio.headers["cache-control"]).toBe("private, no-store");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE${"1".repeat(32)}.mp3`);
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-2");
    vi.unstubAllGlobals();

    const other = await signUp();
    expect((await other.agent.get(`/api/recordings/${list.recordings[0].id}/audio`)).status).toBe(404);
    expect((await agent.delete(`/api/recordings/${list.recordings[0].id}`)).status).toBe(200);
    expect(recordings.remove).toHaveBeenCalledWith("RE" + "1".repeat(32));
    expect((await agent.get("/api/recordings")).body.total).toBe(0);
  });

  it("only the owner can change calling settings", async () => {
    const { agent, email } = await setupOrg();
    await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
    expect((await agent.put("/api/settings/calling").send({ recordingEnabled: true, maxConcurrentAiCalls: 2 })).status).toBe(403);
    expect((await agent.get("/api/settings/calling")).body.settings.recording_enabled).toBe(false);
  });
});

describe("transcripts", () => {
  it("searches across what was said and downloads as text", async () => {
    const { agent, orgId, agentId } = await setupOrg();
    const id = await seedCalls(orgId, agentId);
    await pool.query(
      "INSERT INTO call_transcripts (org_id, call_id, speaker, text) VALUES ($1,$2,'ai','Hello from the clinic'),($1,$2,'caller','I want to reschedule my appointment')",
      [orgId, id],
    );
    expect((await agent.get("/api/transcripts")).body.calls).toHaveLength(1);
    const hit = (await agent.get("/api/transcripts?q=reschedule")).body.calls;
    expect(hit[0].snippet).toMatch(/reschedule my appointment/);
    expect((await agent.get("/api/transcripts?q=pizza")).body.calls).toHaveLength(0);
    const txt = await agent.get(`/api/transcripts/${id}.txt`);
    expect(txt.text).toMatch(/AI: Hello from the clinic\n.*Caller: I want to reschedule/);
  });
});

describe("live call controls", () => {
  it("mutes the browser user's conference leg on a connected human call", async () => {
    const { agent, userId } = await setupOrg();
    const prep = await agent.post("/api/calls/human").send({ to: "+971501234567", idempotencyKey: "mute-key-0001" });
    const callId = prep.body.call.id;
    await twilioPost("/webhooks/twilio/voice/client", { CallSid: "CA" + "b".repeat(32), From: `client:u_${userId}`, callId });
    await new Promise((r) => setTimeout(r, 50));
    expect((await agent.post(`/api/calls/${callId}/mute`).send({ muted: true })).status).toBe(400); // not connected yet
    await twilioPost(`/webhooks/twilio/status?callId=${callId}`, { CallSid: "CA" + "8".repeat(32), CallStatus: "in-progress" });
    expect((await agent.post(`/api/calls/${callId}/mute`).send({ muted: true })).status).toBe(200);
    expect(participants.update).toHaveBeenCalledWith(`acp-${callId}`, "CA" + "b".repeat(32), { muted: true });
  });
});
