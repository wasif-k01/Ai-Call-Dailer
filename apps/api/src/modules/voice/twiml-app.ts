import { env } from "../../config/env.js";
import { badRequest } from "../../lib/errors.js";
import { twilioClient, type TwilioCreds } from "../integrations/providers/twilio.js";
import { getIntegration, mergeConfig } from "../integrations/store.js";

export function publicUrl(path: string) {
  return env.PUBLIC_API_URL.replace(/\/$/, "") + path;
}

export function assertPublicUrl() {
  if (!/^https:\/\//.test(env.PUBLIC_API_URL) || /localhost|127\.0\.0\.1/.test(env.PUBLIC_API_URL))
    throw badRequest(
      "Twilio can't reach this server yet: it needs a public HTTPS address. For local testing run `npm run dev:api:tunnel`; in production set PUBLIC_API_URL.",
    );
}

/**
 * Makes sure a TwiML App exists for browser calling and points at this server's current
 * public URL (the URL changes every time a dev tunnel restarts). Creates it if missing.
 */
export async function ensureTwimlApp(orgId: string, creds: TwilioCreds): Promise<string> {
  assertPublicUrl();
  const client = twilioClient({ accountSid: creds.accountSid, authToken: creds.authToken });
  const voiceUrl = publicUrl("/webhooks/twilio/voice/client");
  const statusCallback = publicUrl("/webhooks/twilio/client-status");
  const integ = await getIntegration(orgId, "twilio");
  const existingSid = integ?.config.twimlAppSid as string | undefined;

  if (existingSid) {
    try {
      const app = await client.applications(existingSid).fetch();
      if (app.voiceUrl !== voiceUrl || app.statusCallback !== statusCallback) {
        await client.applications(existingSid).update({ voiceUrl, voiceMethod: "POST", statusCallback, statusCallbackMethod: "POST" });
      }
      return existingSid;
    } catch (err: any) {
      if (err?.status !== 404) throw err; // deleted in the console → recreate below
    }
  }
  const app = await client.applications.create({
    friendlyName: "AI Cloud Calling Platform (browser calls)",
    voiceUrl,
    voiceMethod: "POST",
    statusCallback,
    statusCallbackMethod: "POST",
  });
  await mergeConfig(orgId, "twilio", { twimlAppSid: app.sid });
  return app.sid;
}
