import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { publishEvent } from "../../realtime/events.js";
import { hangUpLegs, logCallEvent, setCallMetadata } from "../calls/service.js";
import { getIntegration, getSecrets, twilioCredsFor } from "../integrations/store.js";
import { AI_TOOLS, buildInstructions, getAgent } from "./agents.js";
import { applyDncToCampaigns } from "../campaigns/engine.js";

/**
 * Twilio Media Streams ⇄ OpenAI Realtime bridge.
 *
 *   Twilio  --(μ-law 8 kHz base64)-->  this server  --input_audio_buffer.append-->  OpenAI
 *   Twilio  <--media / mark / clear--  this server  <--response.output_audio.delta--  OpenAI
 *
 * Both sides use G.711 μ-law, so audio is passed through without re-encoding.
 */

export const MEDIA_STREAM_PREFIX = "/twilio/media-stream/";
const TURN_DETECTION = { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true };
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Live bridges on this instance (used to drain calls on redeploy). */
export const activeBridges = new Set<AiCallBridge>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

/**
 * Handshake: the call id is in the path (Twilio Stream URLs can't carry query strings).
 * The handshake must be signed by Twilio with the owning account's Auth Token.
 */
export async function handleMediaStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? "/", "http://internal");
  const callId = url.pathname.slice(MEDIA_STREAM_PREFIX.length);
  const deny = (code: number, why: string) => {
    logger.warn({ callId, why }, "media stream handshake rejected");
    socket.write(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return deny(404, "bad call id");
  const { rows } = await query("SELECT id, org_id, mode FROM calls WHERE id = $1", [callId]);
  if (!rows[0] || rows[0].mode !== "ai") return deny(404, "unknown call");
  const creds = await twilioCredsFor(rows[0].org_id);
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const base = env.PUBLIC_API_URL.replace(/^http/, "ws").replace(/\/$/, "") + url.pathname;
  // Twilio's docs suggest also trying a trailing "/" for WebSocket handshakes.
  const valid =
    !!signature && !!creds && [base, `${base}/`].some((u) => twilio.validateRequest(creds.authToken!, signature, u, {}));
  if (!valid) return deny(403, "invalid signature");
  wss.handleUpgrade(req, socket, head, (ws) => {
    const bridge = new AiCallBridge(ws, rows[0].org_id, callId);
    activeBridges.add(bridge);
    bridge.onClose(() => activeBridges.delete(bridge));
  });
}

interface FunctionCallItem {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

export class AiCallBridge {
  private openai: WebSocket | null = null;
  private streamSid: string | null = null;
  private latestMediaTs = 0;
  private responseStartTs: number | null = null;
  private lastAssistantItem: string | null = null;
  private markQueue: string[] = [];
  private pendingAudio: string[] = [];
  private openaiReady = false;
  private greeted = false;
  private ending = false;
  private closed = false;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private closeHandlers: (() => void)[] = [];
  private usage = { input_audio_tokens: 0, output_audio_tokens: 0, input_text_tokens: 0, output_text_tokens: 0, cached_tokens: 0 };

  constructor(
    private twilioWs: WebSocket,
    private orgId: string,
    private callId: string,
  ) {
    twilioWs.on("message", (raw) => this.onTwilioMessage(raw.toString()).catch((err) => this.fail("twilio message", err)));
    twilioWs.on("close", () => void this.finish("twilio stream closed"));
    twilioWs.on("error", (err) => logger.warn({ err: err.message, callId }, "twilio ws error"));
  }

  onClose(fn: () => void) {
    this.closeHandlers.push(fn);
  }

  private sendTwilio(msg: Record<string, unknown>) {
    if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.send(JSON.stringify(msg));
  }

  private sendOpenAI(msg: Record<string, unknown>) {
    if (this.openai?.readyState === WebSocket.OPEN) this.openai.send(JSON.stringify(msg));
  }

  // ───────────────────────── Twilio side ─────────────────────────
  private async onTwilioMessage(raw: string) {
    const msg = JSON.parse(raw);
    switch (msg.event) {
      case "start":
        return this.onStart(msg);
      case "media": {
        this.latestMediaTs = Number(msg.media.timestamp) || this.latestMediaTs;
        if (this.openaiReady) this.sendOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
        else if (this.pendingAudio.length < 250) this.pendingAudio.push(msg.media.payload); // ~5s while connecting
        return;
      }
      case "mark": {
        this.markQueue.shift();
        if (msg.mark?.name === "end-call") await this.hangUp("ai ended call");
        return;
      }
      case "stop":
        return this.finish("twilio stop");
    }
  }

  private async onStart(msg: any) {
    this.streamSid = msg.start.streamSid ?? msg.streamSid;
    const token = msg.start.customParameters?.token as string | undefined;
    // Second factor on top of the signed handshake: a one-time token issued with this call's TwiML.
    const { rows } = await query(
      `UPDATE calls SET metadata = metadata || jsonb_build_object('streamStarted', true, 'streamSid', $3::text)
        WHERE id = $1 AND org_id = $4 AND metadata->>'streamTokenHash' = $2 AND coalesce(metadata->>'streamStarted','false') = 'false'
        RETURNING ai_agent_id, metadata, recording_enabled`,
      [this.callId, hashToken(token ?? ""), this.streamSid, this.orgId],
    );
    if (!rows[0]) {
      logger.warn({ callId: this.callId }, "media stream token invalid or reused");
      return this.twilioWs.close(1008, "unauthorized");
    }
    const agent = await getAgent(this.orgId, rows[0].ai_agent_id);
    const secrets = await getSecrets(this.orgId, "openai");
    const integ = await getIntegration(this.orgId, "openai");
    if (!agent || !secrets.api_key) return this.fail("start", new Error("AI agent or OpenAI key missing"));

    const model = String(integ?.config.model ?? "gpt-realtime-2.1");
    await logCallEvent(this.orgId, this.callId, "ai.stream_started", { model, agentId: agent.id });

    this.maxTimer = setTimeout(() => void this.hangUp("max duration reached"), agent.max_call_duration_sec * 1000);

    const headers: Record<string, string> = { Authorization: `Bearer ${secrets.api_key}` };
    if (integ?.config.projectId) headers["OpenAI-Project"] = String(integ.config.projectId);
    this.openai = new WebSocket(`${env.OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers });

    this.openai.on("open", () => {
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model,
          output_modalities: ["audio"],
          instructions: buildInstructions(agent, rows[0].metadata?.extraInstructions, { recording: rows[0].recording_enabled }),
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: { model: env.OPENAI_TRANSCRIBE_MODEL },
              // Replies are switched on only after the greeting has played, so the person's
              // "Hello?" when picking up doesn't trigger a second greeting.
              turn_detection: { ...TURN_DETECTION, create_response: false },
            },
            output: { format: { type: "audio/pcmu" }, voice: agent.voice, speed: Number(agent.speaking_speed) || 1 },
          },
          tools: AI_TOOLS,
          tool_choice: "auto",
        },
      });
      this.openaiReady = true;
      this.pendingAudio = []; // whatever was said while connecting is a pick-up "hello"; don't answer it
      this.sendOpenAI({ type: "input_audio_buffer.clear" });
      // The AI speaks first, with the agent's greeting.
      this.sendOpenAI({
        type: "response.create",
        response: { instructions: `Begin the call now by saying this greeting naturally: "${agent.greeting_message}"` },
      });
    });
    this.openai.on("message", (raw) => this.onOpenAIMessage(raw.toString()).catch((err) => this.fail("openai message", err)));
    this.openai.on("close", (code) => {
      if (!this.closed && !this.ending) void this.fail("openai closed", new Error(`OpenAI connection closed (${code})`));
    });
    this.openai.on("error", (err) => void this.fail("openai error", err));
  }

  // ───────────────────────── OpenAI side ─────────────────────────
  private async onOpenAIMessage(raw: string) {
    const evt = JSON.parse(raw);
    switch (evt.type) {
      case "response.output_audio.delta": {
        if (!this.streamSid) return;
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: evt.delta } });
        if (this.responseStartTs === null) this.responseStartTs = this.latestMediaTs;
        if (evt.item_id) this.lastAssistantItem = evt.item_id;
        this.markQueue.push("audio");
        this.sendTwilio({ event: "mark", streamSid: this.streamSid, mark: { name: "audio" } });
        return;
      }
      case "input_audio_buffer.speech_started":
        return this.onInterruption();
      case "response.output_audio_transcript.done":
        return this.saveTranscript("ai", evt.transcript);
      case "conversation.item.input_audio_transcription.completed":
        return this.saveTranscript("caller", evt.transcript);
      case "response.done":
        return this.onResponseDone(evt.response);
      case "error":
        logger.warn({ callId: this.callId, error: evt.error }, "openai realtime error event");
        await logCallEvent(this.orgId, this.callId, "ai.error", { code: evt.error?.code, message: evt.error?.message });
        return;
    }
  }

  /** The person started talking over the AI: stop playback and tell OpenAI how much was actually heard. */
  private onInterruption() {
    if (!this.markQueue.length || !this.lastAssistantItem || this.responseStartTs === null || !this.streamSid) return;
    const heardMs = Math.max(0, this.latestMediaTs - this.responseStartTs);
    void logCallEvent(this.orgId, this.callId, "ai.interrupted", { heardMs, pendingMarks: this.markQueue.length }).catch(() => {});
    this.sendOpenAI({ type: "conversation.item.truncate", item_id: this.lastAssistantItem, content_index: 0, audio_end_ms: heardMs });
    this.sendTwilio({ event: "clear", streamSid: this.streamSid });
    this.markQueue = [];
    this.lastAssistantItem = null;
    this.responseStartTs = null;
  }

  private async onResponseDone(response: any) {
    this.responseStartTs = null;
    if (!this.greeted) {
      this.greeted = true;
      this.sendOpenAI({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: TURN_DETECTION } } } });
    }
    const u = response?.usage;
    if (u) {
      this.usage.input_audio_tokens += u.input_token_details?.audio_tokens ?? 0;
      this.usage.input_text_tokens += u.input_token_details?.text_tokens ?? 0;
      this.usage.cached_tokens += u.input_token_details?.cached_tokens ?? 0;
      this.usage.output_audio_tokens += u.output_token_details?.audio_tokens ?? 0;
      this.usage.output_text_tokens += u.output_token_details?.text_tokens ?? 0;
    }
    const calls = ((response?.output ?? []) as FunctionCallItem[]).filter((o) => o.type === "function_call");
    for (const fc of calls) await this.onFunctionCall(fc);
  }

  private async onFunctionCall(fc: FunctionCallItem) {
    await logCallEvent(this.orgId, this.callId, "ai.tool_call", { name: fc.name });
    if (fc.name === "add_to_do_not_call") {
      const { rows } = await query("SELECT to_number FROM calls WHERE id = $1", [this.callId]);
      await query(
        `INSERT INTO do_not_call_list (org_id, phone_e164, reason, source) VALUES ($1,$2,'Asked not to be called (during AI call)','opt_out_during_call')
         ON CONFLICT (org_id, phone_e164) DO NOTHING`,
        [this.orgId, rows[0].to_number],
      );
      await applyDncToCampaigns(this.orgId, rows[0].to_number);
      await setCallMetadata(this.orgId, this.callId, { optedOut: true });
      this.sendOpenAI({ type: "conversation.item.create", item: { type: "function_call_output", call_id: fc.call_id, output: JSON.stringify({ ok: true }) } });
      this.sendOpenAI({ type: "response.create" }); // lets the AI apologise and say goodbye
      return;
    }
    if (fc.name === "end_call") {
      this.ending = true;
      // Hang up once the goodbye has finished playing (Twilio echoes this mark when the audio is done).
      if (this.streamSid && this.markQueue.length) {
        this.markQueue.push("end-call");
        this.sendTwilio({ event: "mark", streamSid: this.streamSid, mark: { name: "end-call" } });
        setTimeout(() => void this.hangUp("ai ended call (timeout)"), 15_000);
      } else {
        await this.hangUp("ai ended call");
      }
    }
  }

  private async saveTranscript(speaker: "ai" | "caller", text?: string) {
    const clean = text?.trim();
    if (!clean) return;
    await query("INSERT INTO call_transcripts (org_id, call_id, speaker, text) VALUES ($1,$2,$3,$4)", [this.orgId, this.callId, speaker, clean]);
    await publishEvent({ orgId: this.orgId, type: "transcript.segment", data: { callId: this.callId, speaker, text: clean, at: new Date().toISOString() } }).catch(() => {});
  }

  // ───────────────────────── Ending ─────────────────────────
  private async hangUp(reason: string) {
    if (this.closed) return;
    this.ending = true;
    await logCallEvent(this.orgId, this.callId, "ai.hangup", { reason });
    await hangUpLegs(this.orgId, this.callId);
  }

  private async fail(where: string, err: unknown) {
    if (this.closed) return;
    logger.error({ callId: this.callId, where, err: (err as Error)?.message }, "ai bridge failure");
    await setCallMetadata(this.orgId, this.callId, { aiError: (err as Error)?.message ?? "AI connection failed" }).catch(() => {});
    await this.hangUp(`error: ${where}`).catch(() => {});
    await this.finish(where);
  }

  /** Idempotent cleanup: closes both sockets and stores token usage. */
  async finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.maxTimer);
    try {
      this.openai?.close();
    } catch {
      /* already closed */
    }
    if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close();
    try {
      const entries = Object.entries(this.usage).filter(([, v]) => v > 0);
      for (const [unit, qty] of entries) {
        await query(
          `INSERT INTO usage_records (org_id, call_id, provider, category, quantity, unit, source)
           VALUES ($1,$2,'openai',$3,$4,$5,'estimate')`,
          [this.orgId, this.callId, unit.includes("audio") ? "ai_audio" : "ai_text", qty, unit],
        );
      }
      await query("UPDATE calls SET metadata = metadata || $2 WHERE id = $1", [this.callId, { aiUsage: this.usage, aiEndReason: reason }]);
    } catch (err) {
      logger.warn({ err, callId: this.callId }, "failed to store AI usage");
    }
    for (const fn of this.closeHandlers) fn();
  }
}
