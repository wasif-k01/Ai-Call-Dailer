import { Router } from "express";
import twilio from "twilio";
import { badRequest } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { explainTwilioError } from "../integrations/providers/twilio.js";
import { twilioCredsFor } from "../integrations/store.js";
import { ensureTwimlApp } from "./twiml-app.js";

const router = Router();

export const clientIdentity = (userId: string) => `u_${userId}`;

/** Short-lived Twilio Voice access token for the browser SDK. Outgoing only; no incoming calls to the browser. */
router.post("/token", requireAuth, requirePermission("calls:make"), async (req, res) => {
  const creds = await twilioCredsFor(req.user!.orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  if (!creds.apiKeySid || !creds.apiKeySecret)
    throw badRequest("Browser calling needs a Twilio API Key. Add the API Key SID and Secret under Integrations → Twilio → Browser calling settings.");
  let appSid: string;
  try {
    appSid = await ensureTwimlApp(req.user!.orgId, creds);
  } catch (err: any) {
    if (err?.status && err?.code) throw badRequest(explainTwilioError(err));
    throw err;
  }
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(creds.accountSid, creds.apiKeySid, creds.apiKeySecret, {
    identity: clientIdentity(req.user!.id),
    ttl: 3600,
  });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: false }));
  res.json({ token: token.toJwt(), identity: clientIdentity(req.user!.id), expiresInSec: 3600 });
});

export default router;
