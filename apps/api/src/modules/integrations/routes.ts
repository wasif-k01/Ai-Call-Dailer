import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { redisHealthy } from "../../lib/redis.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { REALTIME_MODELS, testOpenAI, VOICES } from "./providers/openai.js";
import { explainTwilioError, fetchAccount, verifyApiKey } from "./providers/twilio.js";
import {
  clearSetupSteps, disconnect, getIntegration, getSecrets, markSetupStep, mergeConfig, saveIntegration, setStatus, twilioCredsFor, type Provider,
} from "./store.js";
import { syncTwilioNumbers } from "../phone-numbers/service.js";

const router = Router();
router.use(requireAuth, requirePermission("integrations:manage"));

const optionalSecret = (re: RegExp, msg: string) =>
  z.string().trim().optional().refine((v) => v === undefined || v === "" || re.test(v), msg);

const OpenAISchema = z.object({
  apiKey: optionalSecret(/^sk-[A-Za-z0-9_\-]{20,}$/, "OpenAI API keys start with \"sk-\" and are long. Copy the whole key."),
  projectId: z.string().trim().regex(/^(proj_[A-Za-z0-9]+)?$/, "Project IDs start with \"proj_\"").optional(),
  model: z.enum(REALTIME_MODELS),
  voice: z.enum(VOICES),
});

const TwilioSchema = z.object({
  accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, "Account SID starts with \"AC\" followed by 32 characters."),
  authToken: optionalSecret(/^[0-9a-fA-F]{32}$/, "The Auth Token is 32 letters/numbers. Click \"Show\" in the Twilio Console and copy it."),
  apiKeySid: z.string().trim().regex(/^(SK[0-9a-fA-F]{32})?$/, "API Key SID starts with \"SK\" followed by 32 characters.").optional(),
  apiKeySecret: optionalSecret(/^[A-Za-z0-9]{32}$/, "The API Key Secret is 32 letters/numbers."),
  twimlAppSid: z.string().trim().regex(/^(AP[0-9a-fA-F]{32})?$/, "TwiML App SID starts with \"AP\" followed by 32 characters.").optional(),
});

function withDefaults(provider: string, view: Awaited<ReturnType<typeof getIntegration>>) {
  return view ?? { provider, status: "not_connected", config: {}, secrets: {}, lastTestedAt: null, lastError: null };
}

router.get("/", async (req, res) => {
  const orgId = req.user!.orgId;
  const [openai, twilio] = await Promise.all([getIntegration(orgId, "openai"), getIntegration(orgId, "twilio")]);
  const dbOk = await pool.query("SELECT 1").then(() => true, () => false);
  const redisOk = await redisHealthy();
  const dbHost = (() => {
    try {
      return new URL(env.DATABASE_URL).hostname;
    } catch {
      return "";
    }
  })();
  res.json({
    openai: withDefaults("openai", openai),
    twilio: withDefaults("twilio", twilio),
    // Infrastructure connections are configured by the server's environment, not from the UI
    // (the app needs the database to even load this page). Shown read-only.
    database: {
      status: dbOk ? "connected" : "error",
      kind: dbHost.includes("supabase") ? "Supabase PostgreSQL" : "PostgreSQL",
      host: dbHost.includes("supabase") ? dbHost : dbHost === "localhost" || dbHost === "127.0.0.1" ? "local" : "custom",
    },
    redis: { status: redisOk ? "connected" : "error" },
    options: { realtimeModels: REALTIME_MODELS, voices: VOICES },
  });
});

// ───────────── OpenAI ─────────────
router.put("/openai", async (req, res) => {
  const body = OpenAISchema.parse(req.body);
  const existing = await getIntegration(req.user!.orgId, "openai");
  if (!body.apiKey && !existing?.secrets.api_key) throw badRequest("Enter your OpenAI API key.");
  await saveIntegration(req.user!.orgId, "openai", { model: body.model, voice: body.voice, projectId: body.projectId || null }, { api_key: body.apiKey || undefined });
  await clearSetupSteps(req.user!.orgId, ["openai_voice"]);
  await audit(req, "integration.openai.saved", { entityType: "integration", entityId: "openai", metadata: { keyChanged: !!body.apiKey } });
  res.json({ ok: true, integration: await getIntegration(req.user!.orgId, "openai") });
});

router.post("/openai/test", async (req, res) => {
  const orgId = req.user!.orgId;
  const integ = await getIntegration(orgId, "openai");
  const secrets = await getSecrets(orgId, "openai");
  if (!integ || !secrets.api_key) throw badRequest("Save your OpenAI API key first.");
  await setStatus(orgId, "openai", "testing");
  const model = String(integ.config.model ?? REALTIME_MODELS[0]);
  const result = await testOpenAI(secrets.api_key, model, (integ.config.projectId as string) || undefined);
  await setStatus(orgId, "openai", result.ok ? "connected" : "error", result.ok ? null : result.message);
  if (result.ok) {
    await mergeConfig(orgId, "openai", { availableRealtimeModels: result.availableRealtimeModels ?? null });
    if (integ.config.voice) await markSetupStep(orgId, "openai_voice", { model, voice: integ.config.voice });
  } else {
    await clearSetupSteps(orgId, ["openai_voice"]);
  }
  await audit(req, "integration.openai.tested", { metadata: { ok: result.ok } });
  res.json({ ok: result.ok, message: result.message, integration: await getIntegration(orgId, "openai") });
});

// ───────────── Twilio ─────────────
router.put("/twilio", async (req, res) => {
  const body = TwilioSchema.parse(req.body);
  const orgId = req.user!.orgId;
  const existing = await getIntegration(orgId, "twilio");
  if (!body.authToken && !existing?.secrets.auth_token) throw badRequest("Enter your Twilio Auth Token.");
  if (body.apiKeySid && !body.apiKeySecret && !existing?.secrets.api_key_secret)
    throw badRequest("Enter the API Key Secret that goes with this API Key SID.");
  await saveIntegration(
    orgId,
    "twilio",
    { accountSid: body.accountSid, apiKeySid: body.apiKeySid || null, twimlAppSid: body.twimlAppSid || null },
    { auth_token: body.authToken || undefined, api_key_secret: body.apiKeySid === "" ? "" : body.apiKeySecret || undefined },
  );
  // Only a different Twilio account invalidates the countries check (adding an API key doesn't).
  if (existing?.config.accountSid !== body.accountSid) await clearSetupSteps(orgId, ["geo_permissions"]);
  await audit(req, "integration.twilio.saved", { metadata: { tokenChanged: !!body.authToken } });
  res.json({ ok: true, integration: await getIntegration(orgId, "twilio") });
});

router.post("/twilio/test", async (req, res) => {
  const orgId = req.user!.orgId;
  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Save your Twilio Account SID and Auth Token first.");
  await setStatus(orgId, "twilio", "testing");
  try {
    // Auth Token is always required (it signs webhooks), so test it on its own first.
    const account = await fetchAccount({ accountSid: creds.accountSid, authToken: creds.authToken });
    if (account.status !== "active") throw Object.assign(new Error(`account status is ${account.status}`), { code: 20005 });
    if (creds.apiKeySid && creds.apiKeySecret) {
      try {
        await verifyApiKey(creds);
      } catch (err: any) {
        throw new Error(
          err?.status === 401 && err?.code === 20003
            ? "The Auth Token works, but the API Key SID / Secret were rejected. Check both were copied completely, and that the key was created in the United States (US1) region."
            : `The Auth Token works, but the API key check failed: ${explainTwilioError(err)}`,
        );
      }
    }
    const numbers = await syncTwilioNumbers(orgId, creds);
    await mergeConfig(orgId, "twilio", { accountName: account.friendlyName, accountType: account.type });
    await setStatus(orgId, "twilio", "connected");
    await audit(req, "integration.twilio.tested", { metadata: { ok: true } });
    res.json({
      ok: true,
      message: `Connected to "${account.friendlyName}" (${account.type === "Trial" ? "trial account" : "full account"}). Found ${numbers.length} number(s).`,
      integration: await getIntegration(orgId, "twilio"),
    });
  } catch (err: any) {
    const message = err?.status || err?.code ? explainTwilioError(err) : err.message;
    await setStatus(orgId, "twilio", "error", message);
    await audit(req, "integration.twilio.tested", { metadata: { ok: false } });
    res.json({ ok: false, message, integration: await getIntegration(orgId, "twilio") });
  }
});

router.delete("/:provider", async (req, res) => {
  const provider = req.params.provider as Provider;
  if (!["openai", "twilio"].includes(provider)) throw badRequest("Unknown integration.");
  await disconnect(req.user!.orgId, provider);
  await clearSetupSteps(req.user!.orgId, provider === "openai" ? ["openai_voice"] : ["geo_permissions"]);
  await audit(req, `integration.${provider}.disconnected`);
  res.json({ ok: true });
});

export default router;
