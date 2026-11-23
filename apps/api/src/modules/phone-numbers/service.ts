import { withTransaction } from "../../db/pool.js";
import { fetchNumbers, type TwilioCreds } from "../integrations/providers/twilio.js";

/**
 * Pulls Twilio-owned numbers and verified caller IDs into phone_numbers.
 * Numbers that disappeared from Twilio are marked "released" (kept for call history).
 * If no default exists, the first US Twilio-owned voice number becomes the default.
 */
export async function syncTwilioNumbers(orgId: string, creds: TwilioCreds) {
  const numbers = await fetchNumbers(creds);
  await withTransaction(async (c) => {
    for (const n of numbers) {
      await c.query(
        `INSERT INTO phone_numbers (org_id, provider, number_type, e164, friendly_name, country_iso, provider_sid, capabilities, status)
         VALUES ($1,'twilio',$2,$3,$4,$5,$6,$7,'active')
         ON CONFLICT (org_id, e164) DO UPDATE SET
           number_type = EXCLUDED.number_type, friendly_name = EXCLUDED.friendly_name, country_iso = EXCLUDED.country_iso,
           provider_sid = EXCLUDED.provider_sid, capabilities = EXCLUDED.capabilities, status = 'active', updated_at = now()`,
        [orgId, n.numberType, n.e164, n.friendlyName, n.countryIso, n.providerSid, n.capabilities],
      );
    }
    await c.query(
      `UPDATE phone_numbers SET status = 'released', is_default = false, updated_at = now()
        WHERE org_id = $1 AND provider = 'twilio' AND number_type IN ('provider_owned','verified_caller_id')
          AND NOT (e164 = ANY($2))`,
      [orgId, numbers.map((n) => n.e164)],
    );
    const hasDefault = await c.query("SELECT 1 FROM phone_numbers WHERE org_id = $1 AND is_default", [orgId]);
    if (!hasDefault.rowCount) {
      await c.query(
        `UPDATE phone_numbers SET is_default = true WHERE id = (
           SELECT id FROM phone_numbers
            WHERE org_id = $1 AND status = 'active' AND number_type = 'provider_owned' AND (capabilities->>'voice')::boolean
            ORDER BY (country_iso = 'US') DESC, created_at LIMIT 1)`,
        [orgId],
      );
    }
  });
  return numbers;
}
