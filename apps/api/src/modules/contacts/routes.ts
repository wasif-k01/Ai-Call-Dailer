import { Router } from "express";
import { z } from "zod";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { query } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { applyDncToCampaigns } from "../campaigns/engine.js";
import { cleanNumberInput } from "../calls/destination.js";

const router = Router();
router.use(requireAuth);

const likeOf = (q: string) => `%${q.replace(/[%_\\]/g, "\\$&")}%`;

function toE164(phone: string, country?: string) {
  const clean = cleanNumberInput(phone);
  const p = parsePhoneNumberFromString(clean, clean.startsWith("+") ? undefined : (country as CountryCode | undefined));
  if (!p?.isValid()) throw badRequest("That phone number isn't valid. Include the country code, e.g. +971 50 123 4567.");
  return p.number;
}

/** Quick search for the dialer. */
router.get("/search", requirePermission("calls:view"), async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(60).default("") }).parse(req.query);
  if (q.length < 2) return res.json({ contacts: [] });
  const { rows } = await query(
    `SELECT id, first_name, last_name, phone_e164, company FROM contacts
      WHERE org_id = $1 AND (first_name ILIKE $2 OR last_name ILIKE $2 OR company ILIKE $2 OR phone_e164 LIKE $3)
      ORDER BY first_name NULLS LAST LIMIT 8`,
    [req.user!.orgId, likeOf(q), `%${q.replace(/\D/g, "") || "~"}%`],
  );
  res.json({ contacts: rows });
});

// ───────────── Do Not Call list ─────────────
router.get("/dnc", requirePermission("calls:view"), async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(60).default("") }).parse(req.query);
  const { rows } = await query(
    `SELECT d.id, d.phone_e164, d.reason, d.source, d.created_at, u.full_name AS added_by
       FROM do_not_call_list d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.org_id = $1 AND ($2 = '' OR d.phone_e164 LIKE $3)
      ORDER BY d.created_at DESC LIMIT 500`,
    [req.user!.orgId, q, `%${q.replace(/\D/g, "")}%`],
  );
  res.json({ entries: rows });
});

router.post("/dnc", requirePermission("contacts:manage"), async (req, res) => {
  const body = z.object({ phone: z.string().min(3).max(40), defaultCountry: z.string().length(2).optional(), reason: z.string().trim().max(200).optional() }).parse(req.body);
  const e164 = toE164(body.phone, body.defaultCountry);
  const { rowCount } = await query(
    `INSERT INTO do_not_call_list (org_id, phone_e164, reason, source, created_by) VALUES ($1,$2,$3,'manual',$4)
     ON CONFLICT (org_id, phone_e164) DO NOTHING`,
    [req.user!.orgId, e164, body.reason ?? null, req.user!.id],
  );
  if (!rowCount) throw conflict("That number is already on the Do Not Call list.");
  await applyDncToCampaigns(req.user!.orgId, e164);
  await query("UPDATE contacts SET consent_status = 'revoked', updated_at = now() WHERE org_id = $1 AND phone_e164 = $2", [req.user!.orgId, e164]);
  await audit(req, "dnc.added", { metadata: { phone: e164 } });
  res.status(201).json({ ok: true, phone: e164 });
});

/** Removing someone from the list is a deliberate admin action and is audit-logged. */
router.delete("/dnc/:id", requirePermission("campaigns:manage"), async (req, res) => {
  const { rows } = await query("DELETE FROM do_not_call_list WHERE id = $1 AND org_id = $2 RETURNING phone_e164", [String(req.params.id), req.user!.orgId]);
  if (!rows[0]) throw notFound("Entry not found.");
  await audit(req, "dnc.removed", { metadata: { phone: rows[0].phone_e164 } });
  res.json({ ok: true });
});

// ───────────── Contacts ─────────────
const ContactSchema = z.object({
  firstName: z.string().trim().max(80).optional().nullable(),
  lastName: z.string().trim().max(80).optional().nullable(),
  phone: z.string().min(3).max(40),
  defaultCountry: z.string().length(2).optional(),
  email: z.union([z.email(), z.literal("")]).optional().nullable(),
  company: z.string().trim().max(120).optional().nullable(),
  consentStatus: z.enum(["unknown", "granted", "revoked"]).default("unknown"),
  consentSource: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

router.get("/", requirePermission("calls:view"), async (req, res) => {
  const q = z
    .object({ q: z.string().trim().max(60).default(""), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(25) })
    .parse(req.query);
  const params = [req.user!.orgId, q.q, likeOf(q.q), `%${q.q.replace(/\D/g, "") || "~"}%`];
  const where = `c.org_id = $1 AND ($2 = '' OR c.first_name ILIKE $3 OR c.last_name ILIKE $3 OR c.company ILIKE $3 OR c.email ILIKE $3 OR c.phone_e164 LIKE $4)`;
  const total = await query(`SELECT count(*)::int n FROM contacts c WHERE ${where}`, params);
  const { rows } = await query(
    `SELECT c.id, c.first_name, c.last_name, c.phone_e164, c.email, c.company, c.consent_status, c.consent_source, c.notes, c.created_at,
            EXISTS (SELECT 1 FROM do_not_call_list d WHERE d.org_id = c.org_id AND d.phone_e164 = c.phone_e164) AS on_dnc,
            (SELECT count(*)::int FROM calls k WHERE k.org_id = c.org_id AND k.to_number = c.phone_e164) AS call_count
       FROM contacts c WHERE ${where}
      ORDER BY c.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    params,
  );
  res.json({ contacts: rows, total: total.rows[0].n, page: q.page, pageSize: q.pageSize });
});

function contactValues(b: z.infer<typeof ContactSchema>) {
  return [
    b.firstName || null, b.lastName || null, toE164(b.phone, b.defaultCountry), b.email || null, b.company || null,
    b.consentStatus, b.consentSource || null, b.consentStatus === "granted" ? new Date() : null, b.notes || null,
  ];
}

router.post("/", requirePermission("contacts:manage"), async (req, res) => {
  const b = ContactSchema.parse(req.body);
  try {
    const { rows } = await query(
      `INSERT INTO contacts (first_name, last_name, phone_e164, email, company, consent_status, consent_source, consent_at, notes, org_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [...contactValues(b), req.user!.orgId],
    );
    await audit(req, "contact.created", { entityType: "contact", entityId: rows[0].id });
    res.status(201).json({ id: rows[0].id });
  } catch (err: any) {
    if (err?.code === "23505") throw conflict("A contact with this phone number already exists.");
    throw err;
  }
});

router.put("/:id", requirePermission("contacts:manage"), async (req, res) => {
  const b = ContactSchema.parse(req.body);
  try {
    const { rowCount } = await query(
      `UPDATE contacts SET first_name=$1, last_name=$2, phone_e164=$3, email=$4, company=$5, consent_status=$6, consent_source=$7,
              consent_at = CASE WHEN $6 = 'granted' AND consent_status <> 'granted' THEN now() WHEN $6 <> 'granted' THEN NULL ELSE consent_at END,
              notes=$8, updated_at = now()
        WHERE id = $9 AND org_id = $10`,
      [...contactValues(b).filter((_, i) => i !== 7), String(req.params.id), req.user!.orgId],
    );
    if (!rowCount) throw notFound("Contact not found.");
  } catch (err: any) {
    if (err?.code === "23505") throw conflict("Another contact already has this phone number.");
    throw err;
  }
  await audit(req, "contact.updated", { entityType: "contact", entityId: String(req.params.id) });
  res.json({ ok: true });
});

router.delete("/:id", requirePermission("contacts:manage"), async (req, res) => {
  const { rowCount } = await query("DELETE FROM contacts WHERE id = $1 AND org_id = $2", [String(req.params.id), req.user!.orgId]);
  if (!rowCount) throw notFound("Contact not found.");
  await audit(req, "contact.deleted", { entityType: "contact", entityId: String(req.params.id) });
  res.json({ ok: true });
});

export default router;
