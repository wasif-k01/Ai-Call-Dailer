import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { query } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { redis } from "../../lib/redis.js";
import { fetchGeoPermissions, type TwilioCreds } from "../integrations/providers/twilio.js";

export interface Destination {
  e164: string;
  countryIso: string;
}

/** Twilio groups the US and Canada under one Geo Permissions entry ("US"). */
const geoIso = (iso: string) => (iso === "CA" ? "US" : iso);

/** "00971…" is the international prefix used in the UAE, UK, Pakistan and most of the world: treat it as "+". */
export function cleanNumberInput(input: string) {
  const t = input.trim();
  return t.startsWith("00") ? `+${t.slice(2)}` : t;
}

export function normalizeNumber(input: string, defaultCountry?: string): Destination {
  const clean = cleanNumberInput(input);
  const p = parsePhoneNumberFromString(clean, clean.startsWith("+") ? undefined : (defaultCountry as CountryCode | undefined));
  if (!p || !p.isValid()) throw badRequest("That phone number isn't valid. Include the country code, e.g. +971 50 123 4567.");
  if (!p.country) throw badRequest("Couldn't work out which country this number belongs to.");
  return { e164: p.number, countryIso: p.country };
}

/** Checks the account's real Twilio Geo Permissions (cached 10 minutes). */
export async function assertCountryAllowed(orgId: string, creds: TwilioCreds, countryIso: string) {
  const iso = geoIso(countryIso);
  const key = `acp:geo:${orgId}:${iso}`;
  let allowed = await redis().get(key).catch(() => null);
  if (allowed === null) {
    const [perm] = await fetchGeoPermissions(creds, [iso]);
    allowed = perm?.lowRiskNumbersEnabled ? "1" : "0";
    await redis().set(key, allowed, "EX", 600).catch(() => {});
  }
  if (allowed !== "1")
    throw badRequest(
      `Calls to ${countryIso} are switched off in your Twilio account. Turn the country on in Twilio Console → Voice → Settings → Geo permissions, then re-check on the Phone Numbers page.`,
    );
}

export async function clearGeoCache(orgId: string) {
  const keys = await redis().keys(`acp:geo:${orgId}:*`).catch(() => [] as string[]);
  if (keys.length) await redis().del(...keys).catch(() => {});
}

export async function assertNotOnDnc(orgId: string, e164: string) {
  const { rowCount } = await query("SELECT 1 FROM do_not_call_list WHERE org_id = $1 AND phone_e164 = $2", [orgId, e164]);
  if (rowCount) throw badRequest("This number is on your Do Not Call list, so it can't be called.");
}

/** Returns the caller ID to use: the requested number or the org default. Must be usable as Twilio caller ID. */
export async function resolveCallerId(orgId: string, fromNumberId?: string) {
  const { rows } = await query(
    `SELECT id, e164 FROM phone_numbers
      WHERE org_id = $1 AND status = 'active' AND number_type IN ('provider_owned','verified_caller_id')
        AND (capabilities->>'voice')::boolean AND ${fromNumberId ? "id = $2" : "is_default"}`,
    fromNumberId ? [orgId, fromNumberId] : [orgId],
  );
  if (!rows[0])
    throw badRequest(
      fromNumberId
        ? "That caller ID can't be used. Pick a Twilio number or a Twilio-verified number."
        : "No default caller ID is set. Choose one on the Phone Numbers page.",
    );
  return rows[0] as { id: string; e164: string };
}
