import { Router } from "express";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { query, withTransaction } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { explainTwilioError, fetchGeoPermissions } from "../integrations/providers/twilio.js";
import { markSetupStep, twilioCredsFor } from "../integrations/store.js";
import { syncTwilioNumbers } from "./service.js";

const router = Router();
router.use(requireAuth);

const COLUMNS = `id, provider, number_type, e164, friendly_name, country_iso, provider_sid, capabilities, status, is_default, created_at`;

router.get("/", requirePermission("calls:view"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM phone_numbers WHERE org_id = $1 ORDER BY is_default DESC, status, created_at`,
    [req.user!.orgId],
  );
  res.json({ numbers: rows });
});

router.post("/sync", requirePermission("numbers:manage"), async (req, res) => {
  const creds = await twilioCredsFor(req.user!.orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  try {
    const numbers = await syncTwilioNumbers(req.user!.orgId, creds);
    await audit(req, "phone_numbers.synced", { metadata: { count: numbers.length } });
    res.json({ ok: true, count: numbers.length });
  } catch (err) {
    throw badRequest(explainTwilioError(err));
  }
});

router.post("/:id/default", requirePermission("numbers:manage"), async (req, res) => {
  const orgId = req.user!.orgId;
  const { rows } = await query(`SELECT ${COLUMNS} FROM phone_numbers WHERE id = $1 AND org_id = $2`, [req.params.id, orgId]);
  const n = rows[0];
  if (!n) throw notFound("Phone number not found.");
  if (n.status !== "active") throw badRequest("Only active numbers can be the default caller ID.");
  if (!["provider_owned", "verified_caller_id"].includes(n.number_type))
    throw badRequest("Only a Twilio number or a Twilio-verified caller ID can be used as the outbound caller ID.");
  if (!n.capabilities?.voice) throw badRequest("This number can't make voice calls.");
  await withTransaction(async (c) => {
    await c.query("UPDATE phone_numbers SET is_default = false WHERE org_id = $1 AND is_default", [orgId]);
    await c.query("UPDATE phone_numbers SET is_default = true, updated_at = now() WHERE id = $1", [n.id]);
  });
  await audit(req, "phone_numbers.default_set", { entityType: "phone_number", entityId: n.id });
  res.json({ ok: true });
});

const AddSchema = z.discriminatedUnion("numberType", [
  z.object({ numberType: z.literal("external"), value: z.string().trim(), friendlyName: z.string().trim().max(80).optional() }),
  z.object({
    numberType: z.literal("sip_endpoint"),
    value: z.string().trim().regex(/^sips?:[^@\s]+@[^\s]+$/, "A SIP address looks like sip:user@example.com"),
    friendlyName: z.string().trim().max(80).optional(),
  }),
]);

router.post("/", requirePermission("numbers:manage"), async (req, res) => {
  const body = AddSchema.parse(req.body);
  let value = body.value;
  let country: string | null = null;
  if (body.numberType === "external") {
    const p = parsePhoneNumberFromString(body.value);
    if (!p?.isValid()) throw badRequest("Enter the number in international format, e.g. +971501234567.");
    value = p.number;
    country = p.country ?? null;
  }
  try {
    const { rows } = await query(
      `INSERT INTO phone_numbers (org_id, provider, number_type, e164, friendly_name, country_iso, capabilities, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unverified') RETURNING ${COLUMNS}`,
      [
        req.user!.orgId,
        body.numberType === "sip_endpoint" ? "sip" : "external",
        body.numberType,
        value,
        body.friendlyName ?? null,
        country,
        { voice: body.numberType === "sip_endpoint" },
      ],
    );
    await audit(req, "phone_numbers.added", { entityType: "phone_number", entityId: rows[0].id, metadata: { type: body.numberType } });
    res.status(201).json({ number: rows[0] });
  } catch (err: any) {
    if (err?.code === "23505") throw conflict("This number is already in your list.");
    throw err;
  }
});

router.delete("/:id", requirePermission("numbers:manage"), async (req, res) => {
  const { rows } = await query("SELECT number_type, status, is_default FROM phone_numbers WHERE id = $1 AND org_id = $2", [req.params.id, req.user!.orgId]);
  const n = rows[0];
  if (!n) throw notFound("Phone number not found.");
  if (n.number_type === "provider_owned" && n.status === "active")
    throw badRequest("Active Twilio numbers are managed in Twilio. Release the number in the Twilio Console, then click Refresh.");
  if (n.is_default) throw badRequest("Choose a different default number first.");
  await query("DELETE FROM phone_numbers WHERE id = $1", [req.params.id]);
  await audit(req, "phone_numbers.removed", { entityType: "phone_number", entityId: String(req.params.id) });
  res.json({ ok: true });
});

const GeoSchema = z.object({
  countries: z
    .string()
    .default("US,AE,GB,PK")
    .transform((s) => [...new Set(s.split(",").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 30)),
});

router.get("/destinations", requirePermission("calls:view"), async (req, res) => {
  const { countries } = GeoSchema.parse(req.query);
  const orgId = req.user!.orgId;
  const creds = await twilioCredsFor(orgId);
  if (!creds) throw badRequest("Connect Twilio first (Integrations & API Settings).");
  try {
    const permissions = await fetchGeoPermissions(creds, countries);
    await markSetupStep(orgId, "geo_permissions", {
      enabled: permissions.filter((p) => p.lowRiskNumbersEnabled).map((p) => p.isoCode),
      disabled: permissions.filter((p) => !p.lowRiskNumbersEnabled).map((p) => p.isoCode),
    });
    const acct = await query("SELECT config->>'accountType' AS type FROM integrations WHERE org_id = $1 AND provider = 'twilio'", [orgId]);
    res.json({ permissions, accountType: acct.rows[0]?.type ?? null });
  } catch (err) {
    throw badRequest(explainTwilioError(err));
  }
});

export default router;
