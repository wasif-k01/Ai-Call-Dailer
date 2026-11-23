import { Router } from "express";
import rateLimit from "express-rate-limit";
import twilio from "twilio";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { twilioClient } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { clientIdentity } from "../voice/routes.js";
import { publicUrl } from "../voice/twiml-app.js";
import { conferenceName, hangUpLegs, logCallEvent, mapTwilioStatus, TERMINAL, transitionCall } from "../calls/service.js";
import { explainCallError } from "../calls/twilio-errors.js";
import { verifyTwilio } from "./twilio-signature.js";
import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { hashToken, MEDIA_STREAM_PREFIX } from "../ai/bridge.js";

const { VoiceResponse } = twilio.twiml;
const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-8", legacyHeaders: false }));

const xml = (res: import("express").Response, twiml: InstanceType<typeof VoiceResponse>) => res.type("text/xml").send(twiml.toString());

function reject(res: import("express").Response, message: string) {
  const t = new VoiceResponse();
  t.say(message);
  t.hangup();
  return xml(res, t);
}

/**
 * The browser (Twilio Voice SDK) connected. Puts the browser leg into a private conference
 * and dials the recipient into the same conference. A conference (rather than a direct
 * <Dial><Number>) is what makes Hold possible.
 */
router.post("/voice/client", verifyTwilio, async (req, res) => {
  const { id: callId, orgId } = req.twilioCall!;
  const { rows } = await query("SELECT * FROM calls WHERE id = $1", [callId]);
  const call = rows[0];
  // Single use: only the user who prepared this call, only once, only while still "initiated".
  if (!call || call.mode !== "human" || call.status !== "initiated" || call.metadata?.browserCallSid || req.body.From !== `client:${clientIdentity(call.user_id)}`) {
    logger.warn({ callId }, "voice/client: call not startable");
    return reject(res, "This call could not be started. Please try again from the dialer.");
  }
  await transitionCall(orgId, callId, "queued", { metadata: { browserCallSid: req.body.CallSid } });

  const t = new VoiceResponse();
  const dial = t.dial();
  dial.conference(
    { beep: "false", startConferenceOnEnter: true, endConferenceOnExit: true, waitUrl: "", participantLabel: "agent" },
    conferenceName(callId),
  );
  xml(res, t);

  // Dial the recipient into the conference (after responding, so Twilio isn't kept waiting).
  setImmediate(async () => {
    try {
      const creds = (await twilioCredsFor(orgId))!;
      const p = await twilioClient(creds).conferences(conferenceName(callId)).participants.create({
        from: call.from_number,
        to: call.to_number,
        label: "customer",
        earlyMedia: true, // lets the caller hear ringing / network messages
        beep: "false",
        startConferenceOnEnter: true,
        endConferenceOnExit: false, // ending is handled by our status webhook (keypad tones briefly leave the conference)
        timeout: 45,
        statusCallback: publicUrl(`/webhooks/twilio/status?callId=${callId}`),
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      await query("UPDATE calls SET provider_call_sid = $2, updated_at = now() WHERE id = $1", [callId, p.callSid]);
      await logCallEvent(orgId, callId, "participant.created", { callSid: p.callSid });
    } catch (err) {
      const e = explainCallError(err);
      logger.warn({ callId, code: e.code }, "failed to dial recipient");
      await transitionCall(orgId, callId, "failed", { errorCode: e.code, errorMessage: e.message });
      await hangUpLegs(orgId, callId);
    }
  });
});

/**
 * AI call answered: connect its audio to the AI bridge over a bidirectional Media Stream.
 * A one-time token (only its hash is stored) is passed as a Stream <Parameter> and checked again
 * when the stream starts, on top of the Twilio-signed WebSocket handshake.
 */
router.post("/voice/ai", verifyTwilio, async (req, res) => {
  const { id: callId } = req.twilioCall!;
  const token = randomBytes(24).toString("hex");
  const { rowCount } = await query(
    `UPDATE calls SET metadata = metadata || jsonb_build_object('streamTokenHash', $2::text)
      WHERE id = $1 AND mode = 'ai' AND metadata->>'streamTokenHash' IS NULL
        AND status NOT IN ('completed','busy','no_answer','failed','canceled')`,
    [callId, hashToken(token)],
  );
  if (!rowCount) return reject(res, "Sorry, this call can't continue. Goodbye.");
  const t = new VoiceResponse();
  const stream = t.connect().stream({ url: env.PUBLIC_API_URL.replace(/^http/, "ws").replace(/\/$/, "") + MEDIA_STREAM_PREFIX + callId });
  stream.parameter({ name: "token", value: token });
  xml(res, t);
});

/** Recipient leg progress: initiated → ringing → answered → completed/busy/no-answer/failed. */
router.post("/status", verifyTwilio, async (req, res) => {
  const { id: callId, orgId } = req.twilioCall!;
  const b = req.body;
  await logCallEvent(orgId, callId, "twilio.status", { CallStatus: b.CallStatus, SequenceNumber: b.SequenceNumber, CallDuration: b.CallDuration });
  const next = mapTwilioStatus(b.CallStatus);
  if (next) {
    await query("UPDATE calls SET provider_call_sid = coalesce(provider_call_sid, $2) WHERE id = $1", [callId, b.CallSid]);
    const errorCode = b.ErrorCode || (next === "failed" ? "call_failed" : undefined);
    await transitionCall(orgId, callId, next, {
      durationSec: b.CallDuration ? Number(b.CallDuration) : undefined,
      errorCode,
      errorMessage: b.ErrorCode ? explainCallError({ code: b.ErrorCode }).message : undefined,
    });
    if (TERMINAL.includes(next)) await hangUpLegs(orgId, callId); // end the browser side too
  }
  res.sendStatus(204);
});

/** Browser leg finished (user hung up, closed the tab, or lost connection). */
router.post("/client-status", verifyTwilio, async (req, res) => {
  const { id: callId, orgId } = req.twilioCall!;
  const next = mapTwilioStatus(req.body.CallStatus);
  await logCallEvent(orgId, callId, "twilio.client_status", { CallStatus: req.body.CallStatus });
  if (next && TERMINAL.includes(next)) {
    const { rows } = await query("SELECT status, provider_call_sid FROM calls WHERE id = $1", [callId]);
    if (rows[0] && !TERMINAL.includes(rows[0].status)) {
      if (rows[0].provider_call_sid) await hangUpLegs(orgId, callId);
      // If the recipient was never reached, close the record here; otherwise their status webhook will.
      if (!rows[0].provider_call_sid || rows[0].status !== "in_progress")
        await transitionCall(orgId, callId, rows[0].status === "in_progress" ? "completed" : "canceled");
    }
  }
  res.sendStatus(204);
});

/** What the recipient hears while on hold. Uses only built-in TwiML (no external audio files). */
router.post("/hold", verifyTwilio, (req, res) => {
  const t = new VoiceResponse();
  t.say("Please hold. We'll be right back with you.");
  t.pause({ length: 20 });
  t.redirect({ method: "POST" }, publicUrl(`/webhooks/twilio/hold?callId=${req.twilioCall!.id}`));
  xml(res, t);
});

export default router;
