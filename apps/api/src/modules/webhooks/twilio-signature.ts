import type { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { twilioCredsFor } from "../integrations/store.js";
import { publicUrl } from "../voice/twiml-app.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      twilioCall?: { id: string; orgId: string };
    }
  }
}

/** Finds which call (and therefore which org's Auth Token) a webhook belongs to. */
async function resolveCall(req: Request) {
  const callId = (req.query.callId as string) ?? req.body?.callId;
  if (callId && /^[0-9a-f-]{36}$/i.test(callId)) {
    const { rows } = await query("SELECT id, org_id FROM calls WHERE id = $1", [callId]);
    if (rows[0]) return { id: rows[0].id as string, orgId: rows[0].org_id as string };
  }
  const sid = req.body?.CallSid;
  if (sid && /^CA[0-9a-f]{32}$/i.test(sid)) {
    const { rows } = await query(
      "SELECT id, org_id FROM calls WHERE provider_call_sid = $1 OR metadata->>'browserCallSid' = $1 LIMIT 1",
      [sid],
    );
    if (rows[0]) return { id: rows[0].id as string, orgId: rows[0].org_id as string };
  }
  return null;
}

/**
 * Rejects any request not signed by Twilio with the owning account's Auth Token.
 * The URL is rebuilt from PUBLIC_API_URL because proxies (Railway, tunnels) rewrite host/scheme.
 */
export async function verifyTwilio(req: Request, res: Response, next: NextFunction) {
  const signature = req.header("X-Twilio-Signature");
  const call = await resolveCall(req);
  const creds = call ? await twilioCredsFor(call.orgId) : null;
  const url = publicUrl(req.originalUrl);
  const params = req.method === "POST" ? (req.body ?? {}) : {};
  if (!signature || !call || !creds || !twilio.validateRequest(creds.authToken!, signature, url, params)) {
    logger.warn({ path: req.path, hasSignature: !!signature, knownCall: !!call }, "rejected unsigned/invalid Twilio webhook");
    return res.status(403).type("text/plain").send("Invalid signature");
  }
  req.twilioCall = call;
  next();
}
