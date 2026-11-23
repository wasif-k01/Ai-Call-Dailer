import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";

// ── Fake Twilio REST client ──
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
const { attachWebSockets } = await import("../src/realtime/ws-server.js");

const SID = "AC" + "1".repeat(32);
const TOKEN = "2".repeat(32);
const OPENAI_KEY = "sk-proj-TESTKEY1234567890abcdefXYZ9";
const BASE = "https://api.test.example";
const PSTN_SID = "CA" + "e".repeat(32);

// ── Fake OpenAI Realtime server (port fixed in test/setup.ts) ──
let fakeOpenAI: WebSocketServer;
let openaiConn: { ws: WebSocket; received: any[]; headers: http.IncomingHttpHeaders; url: string } | null = null;
let server: http.Server;
let wsHandle: ReturnType<typeof attachWebSockets>;
let wsBase: string;

beforeAll(async () => {
  fakeOpenAI = new WebSocketServer({ port: 47123 });
  fakeOpenAI.on("connection", (ws, req) => {
    openaiConn = { ws, received: [], headers: req.headers, url: req.url ?? "" };
    ws.on("message", (m) => openaiConn!.received.push(JSON.parse(m.toString())));
  });
  server = http.createServer(app);
  wsHandle = attachWebSockets(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await wsHandle.close();
  server.close();
  fakeOpenAI.close();
  await closeRedis();
  await pool.end();
});
beforeEach(async () => {
  await resetDb();
  const keys = await redis().keys("acp:geo:*");
  if (keys.length) await redis().del(...keys);
  calls.create.mockReset().mockResolvedValue({ sid: PSTN_SID });
  calls.update.mockReset().mockResolvedValue({});
  openaiConn = null;
  vi.mocked(tw.fetchGeoPermissions).mockImplementation(async (_c, isos) =>
    isos.map((iso) => ({ isoCode: iso, name: iso, countryCodes: [], lowRiskNumbersEnabled: iso !== "PK", highRiskSpecialNumbersEnabled: false, highRiskTollfraudNumbersEnabled: false })),
  );
});

const waitFor = async (fn: () => unknown, ms = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function setupOrg() {
  const s = await signUp();
  vi.mocked(tw.fetchAccount).mockResolvedValue({ friendlyName: "Acct", status: "active", type: "Full" });
  vi.mocked(tw.fetchNumbers).mockResolvedValue([
    { e164: "+14155550100", providerSid: "PN1", friendlyName: "US", countryIso: "US", numberType: "provider_owned", capabilities: { voice: true } },
  ]);
  await s.agent.put("/api/integrations/twilio").send({ accountSid: SID, authToken: TOKEN });
  await s.agent.post("/api/integrations/twilio/test");
  await s.agent.put("/api/integrations/openai").send({ apiKey: OPENAI_KEY, model: "gpt-realtime-2.1", voice: "marin" });
  await pool.query("UPDATE integrations SET status = 'connected' WHERE provider = 'openai'");
  const agents = (await s.agent.get("/api/agents")).body.agents;
  return { ...s, agentId: agents[0].id as string };
}

function twilioPost(path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(TOKEN, BASE + path, params);
  return request(app).post(path).set("X-Twilio-Signature", sig).type("form").send(params);
}

/** Starts an AI call and walks it to the point where Twilio opens the media stream. */
async function startAiCall() {
  const s = await setupOrg();
  const res = await s.agent.post("/api/calls/ai").send({ to: "+971501234567", agentId: s.agentId, idempotencyKey: `k-${Math.random()}` });
  expect(res.status).toBe(201);
  const callId = res.body.call.id as string;
  const twiml = await twilioPost(`/webhooks/twilio/voice/ai?callId=${callId}`, { CallSid: PSTN_SID, CallStatus: "in-progress" });
  const token = /name="token" value="([0-9a-f]+)"/.exec(twiml.text)?.[1];
  return { ...s, callId, twiml: twiml.text, token: token! };
}

function openTwilioStream(callId: string, opts: { badSignature?: boolean } = {}) {
  const path = `/twilio/media-stream/${callId}`;
  const sig = twilio.getExpectedTwilioSignature(opts.badSignature ? "f".repeat(32) : TOKEN, `wss://api.test.example${path}`, {});
  return new Promise<{ ws: WebSocket; got: any[]; closed: Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(wsBase + path, { headers: { "X-Twilio-Signature": sig } });
    const got: any[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    ws.on("open", () => resolve({ ws, got, closed }));
    ws.on("unexpected-response", (_q, r) => reject(new Error(String(r.statusCode))));
    ws.on("error", reject);
  });
}

const start = (ws: WebSocket, token: string) => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: { streamSid: "MZ1", callSid: PSTN_SID, customParameters: { token }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }));
};
const media = (ws: WebSocket, payload: string, timestamp: number) =>
  ws.send(JSON.stringify({ event: "media", streamSid: "MZ1", media: { track: "inbound", timestamp: String(timestamp), payload } }));
const fromOpenAI = (evt: Record<string, unknown>) => openaiConn!.ws.send(JSON.stringify(evt));

describe("starting an AI call", () => {
  it("places the call via Twilio REST with signed webhooks and a time limit", async () => {
    const { twiml, callId } = await startAiCall();
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({
      to: "+971501234567", from: "+14155550100",
      url: `${BASE}/webhooks/twilio/voice/ai?callId=${callId}`,
      statusCallback: `${BASE}/webhooks/twilio/status?callId=${callId}`,
      timeLimit: 210,
    }));
    expect(twiml).toContain(`<Stream url="wss://api.test.example/twilio/media-stream/${callId}"`);
  });

  it("requires OpenAI to be connected", async () => {
    const s = await setupOrg();
    await pool.query("UPDATE integrations SET status = 'error' WHERE provider = 'openai'");
    const res = await s.agent.post("/api/calls/ai").send({ to: "+971501234567", agentId: s.agentId, idempotencyKey: "kkkkkkkk1" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/OpenAI/);
  });

  it("respects the Do Not Call list and inactive agents", async () => {
    const s = await setupOrg();
    await pool.query("INSERT INTO do_not_call_list (org_id, phone_e164) SELECT org_id, '+971501234567' FROM users LIMIT 1");
    expect((await s.agent.post("/api/calls/ai").send({ to: "+971501234567", agentId: s.agentId, idempotencyKey: "kkkkkkkk2" })).status).toBe(400);
    await pool.query("UPDATE ai_agents SET is_active = false");
    const r = await s.agent.post("/api/calls/ai").send({ to: "+442079460958", agentId: s.agentId, idempotencyKey: "kkkkkkkk3" });
    expect(r.body.error.message).toMatch(/switched off/);
  });

  it("caps simultaneous AI calls", async () => {
    const s = await setupOrg();
    await pool.query("UPDATE org_settings SET max_concurrent_ai_calls = 1");
    expect((await s.agent.post("/api/calls/ai").send({ to: "+971501234567", agentId: s.agentId, idempotencyKey: "kkkkkkkk4" })).status).toBe(201);
    expect((await s.agent.post("/api/calls/ai").send({ to: "+442079460958", agentId: s.agentId, idempotencyKey: "kkkkkkkk5" })).status).toBe(409);
  });

  it("marks the call failed with a plain reason when Twilio refuses", async () => {
    const s = await setupOrg();
    calls.create.mockRejectedValue(Object.assign(new Error("x"), { code: 21215 }));
    const res = await s.agent.post("/api/calls/ai").send({ to: "+971501234567", agentId: s.agentId, idempotencyKey: "kkkkkkkk6" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Geo Permissions/);
  });
});

describe("media stream security", () => {
  it("rejects handshakes without a valid Twilio signature", async () => {
    const { callId } = await startAiCall();
    await expect(openTwilioStream(callId, { badSignature: true })).rejects.toThrow("403");
  });

  it("closes the stream when the one-time token is wrong", async () => {
    const { callId } = await startAiCall();
    const t = await openTwilioStream(callId);
    start(t.ws, "0".repeat(48));
    expect(await t.closed).toBe(1008);
    expect(openaiConn).toBeNull();
  });

  it("the voice/ai webhook can only issue a stream token once", async () => {
    const { callId } = await startAiCall();
    const again = await twilioPost(`/webhooks/twilio/voice/ai?callId=${callId}`, { CallSid: PSTN_SID });
    expect(again.text).toContain("<Hangup");
  });
});

describe("the AI conversation bridge", () => {
  it("configures OpenAI for phone audio, relays audio both ways, handles interruptions, transcripts, opt-out and hang-up", async () => {
    const { callId, token, agent } = await startAiCall();
    const t = await openTwilioStream(callId);
    start(t.ws, token);

    // 1. OpenAI session is configured from the agent, with μ-law audio and mandatory rules
    await waitFor(() => openaiConn?.received.length! >= 3);
    expect(openaiConn!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(openaiConn!.url).toContain("model=gpt-realtime-2.1");
    const [update, greet] = openaiConn!.received;
    expect(update.type).toBe("session.update");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.output).toMatchObject({ format: { type: "audio/pcmu" }, voice: "marin" });
    expect(update.session.audio.input.transcription.model).toBe("gpt-4o-mini-transcribe");
    expect(update.session.instructions).toMatch(/Say so once, in your opening greeting/);
    expect(update.session.tools.map((x: any) => x.name)).toEqual(["end_call", "add_to_do_not_call"]);
    expect(update.session.audio.input.turn_detection).toMatchObject({ type: "semantic_vad", create_response: false });
    expect(greet.type).toBe("input_audio_buffer.clear");
    const greeting = openaiConn!.received[2];
    expect(greeting.type).toBe("response.create");
    expect(greeting.response.instructions).toMatch(/AI assistant calling on behalf of Test Org/);
    // after the greeting finishes, normal turn-taking is switched on
    fromOpenAI({ type: "response.done", response: { output: [] } });
    await waitFor(() => openaiConn!.received.some((m) => m.type === "session.update" && m.session.audio?.input?.turn_detection?.create_response === true));

    // 2. caller audio → OpenAI
    media(t.ws, "AAAA", 1000);
    await waitFor(() => openaiConn!.received.some((m) => m.type === "input_audio_buffer.append" && m.audio === "AAAA"));

    // 3. AI audio → caller, with a playback mark
    fromOpenAI({ type: "response.output_audio.delta", item_id: "item1", delta: "BBBB" });
    await waitFor(() => t.got.some((m) => m.event === "media" && m.media.payload === "BBBB"));
    expect(t.got.find((m) => m.event === "mark")).toMatchObject({ streamSid: "MZ1" });

    // 4. caller talks over the AI → stop playback and truncate what wasn't heard
    media(t.ws, "CCCC", 1800);
    await waitFor(() => openaiConn!.received.some((m) => m.audio === "CCCC"));
    fromOpenAI({ type: "input_audio_buffer.speech_started", item_id: "item2", audio_start_ms: 800 });
    await waitFor(() => t.got.some((m) => m.event === "clear"));
    const trunc = openaiConn!.received.find((m) => m.type === "conversation.item.truncate");
    expect(trunc).toEqual({ type: "conversation.item.truncate", item_id: "item1", content_index: 0, audio_end_ms: 800 });
    let interrupted: any[] = [];
    for (let i = 0; i < 50 && !interrupted.length; i++) {
      interrupted = (await pool.query("SELECT payload FROM call_events WHERE event_type = 'ai.interrupted'")).rows;
      if (!interrupted.length) await new Promise((r) => setTimeout(r, 20));
    }
    expect(interrupted[0]?.payload.heardMs).toBe(800);

    // 5. transcripts for both sides are stored
    fromOpenAI({ type: "response.output_audio_transcript.done", item_id: "item1", transcript: "Hi, I'm an AI assistant." });
    fromOpenAI({ type: "conversation.item.input_audio_transcription.completed", item_id: "item2", content_index: 0, transcript: "Please don't call me again." });
    let tr: any[] = [];
    for (let i = 0; i < 100 && tr.length < 2; i++) {
      tr = (await agent.get(`/api/calls/${callId}/transcript`)).body.segments;
      if (tr.length < 2) await new Promise((r) => setTimeout(r, 20));
    }
    expect(tr.map((s: any) => [s.speaker, s.text])).toEqual([["ai", "Hi, I'm an AI assistant."], ["caller", "Please don't call me again."]]);

    // 6. opt-out tool → Do Not Call list immediately, AI allowed to say goodbye
    fromOpenAI({
      type: "response.done",
      response: { output: [{ type: "function_call", name: "add_to_do_not_call", call_id: "c1", arguments: "{}" }], usage: { input_token_details: { audio_tokens: 120, text_tokens: 30 }, output_token_details: { audio_tokens: 200, text_tokens: 10 } } },
    });
    await waitFor(() => openaiConn!.received.some((m) => m.type === "conversation.item.create" && m.item.call_id === "c1"));
    const dnc = await pool.query("SELECT source FROM do_not_call_list WHERE phone_e164 = '+971501234567'");
    expect(dnc.rows[0].source).toBe("opt_out_during_call");

    // 7. end_call tool → hang up through Twilio (after the goodbye audio finishes)
    t.got.length = 0;
    fromOpenAI({ type: "response.output_audio.delta", item_id: "item3", delta: "DDDD" });
    await waitFor(() => t.got.some((m) => m.media?.payload === "DDDD"));
    fromOpenAI({ type: "response.done", response: { output: [{ type: "function_call", name: "end_call", call_id: "c2", arguments: "{}" }] } });
    await waitFor(() => t.got.some((m) => m.event === "mark" && m.mark.name === "end-call"));
    expect(calls.update).not.toHaveBeenCalled(); // waits for audio to finish
    t.ws.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "audio" } }));
    t.ws.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "end-call" } }));
    await waitFor(() => calls.update.mock.calls.length > 0);
    expect(calls.update.mock.calls[0][0]).toBe(PSTN_SID);

    // 8. stream stops → OpenAI closed, usage recorded
    t.ws.send(JSON.stringify({ event: "stop", streamSid: "MZ1", stop: { callSid: PSTN_SID } }));
    let n = 0;
    for (let i = 0; i < 100 && n < 4; i++) {
      n = (await pool.query("SELECT count(*)::int n FROM usage_records")).rows[0].n;
      if (n < 4) await new Promise((r) => setTimeout(r, 20));
    }
    const usage = await pool.query("SELECT unit, quantity::int q FROM usage_records ORDER BY unit");
    expect(usage.rows).toEqual(expect.arrayContaining([{ unit: "input_audio_tokens", q: 120 }, { unit: "output_audio_tokens", q: 200 }]));
    expect(openaiConn!.ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it("hangs up instead of leaving dead air when OpenAI disconnects", async () => {
    const { callId, token } = await startAiCall();
    const t = await openTwilioStream(callId);
    start(t.ws, token);
    await waitFor(() => openaiConn?.received.length! >= 1);
    openaiConn!.ws.close(1011);
    await waitFor(() => calls.update.mock.calls.length > 0);
    const meta = (await pool.query("SELECT metadata FROM calls WHERE id = $1", [callId])).rows[0].metadata;
    expect(meta.aiError).toMatch(/OpenAI connection closed/);
  });
});
