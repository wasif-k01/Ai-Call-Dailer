import twilio from "twilio";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface TwilioCreds {
  accountSid: string;
  authToken?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
}

export function twilioClient(c: TwilioCreds) {
  if (c.apiKeySid && c.apiKeySecret) return twilio(c.apiKeySid, c.apiKeySecret, { accountSid: c.accountSid });
  if (!c.authToken) throw new Error("Twilio Auth Token is missing.");
  return twilio(c.accountSid, c.authToken);
}

/** Maps Twilio SDK errors to plain English. */
export function explainTwilioError(err: any): string {
  const status = err?.status;
  const code = err?.code;
  if (status === 401 || code === 20003)
    return "Twilio rejected these credentials. Check the Account SID and Auth Token in the Twilio Console (Account → API keys & tokens).";
  if (status === 404 || code === 20404) return "Twilio couldn't find that account or resource. Check the Account SID.";
  if (code === 20005) return "This Twilio account is suspended or closed. Contact Twilio support.";
  if (status === 429) return "Twilio is rate-limiting requests. Wait a minute and try again.";
  if (err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT")
    return "Couldn't reach Twilio. Check the server's internet connection.";
  return `Twilio returned an error${code ? ` (code ${code})` : ""}: ${err?.message ?? "unknown error"}`;
}

export interface TwilioAccountInfo {
  friendlyName: string;
  status: string;
  type: "Trial" | "Full";
}

export async function fetchAccount(c: TwilioCreds): Promise<TwilioAccountInfo> {
  const acct = await twilioClient(c).api.v2010.accounts(c.accountSid).fetch();
  return { friendlyName: acct.friendlyName, status: acct.status, type: acct.type };
}

export interface ProviderNumber {
  e164: string;
  providerSid: string;
  friendlyName: string;
  countryIso: string | null;
  numberType: "provider_owned" | "verified_caller_id";
  capabilities: Record<string, boolean>;
}

const countryOf = (e164: string) => parsePhoneNumberFromString(e164)?.country ?? null;

export async function fetchNumbers(c: TwilioCreds): Promise<ProviderNumber[]> {
  const client = twilioClient(c);
  const [owned, verified] = await Promise.all([
    client.incomingPhoneNumbers.list({ limit: 200 }),
    client.outgoingCallerIds.list({ limit: 200 }),
  ]);
  const ownedSet = new Set(owned.map((n) => n.phoneNumber));
  return [
    ...owned.map((n) => ({
      e164: n.phoneNumber,
      providerSid: n.sid,
      friendlyName: n.friendlyName,
      countryIso: countryOf(n.phoneNumber),
      numberType: "provider_owned" as const,
      capabilities: { voice: n.capabilities.voice, sms: n.capabilities.sms, mms: n.capabilities.mms },
    })),
    // A verified caller ID can be shown as "from" on calls, but you don't own it and it can't receive calls via Twilio.
    ...verified
      .filter((v) => !ownedSet.has(v.phoneNumber))
      .map((v) => ({
        e164: v.phoneNumber,
        providerSid: v.sid,
        friendlyName: v.friendlyName,
        countryIso: countryOf(v.phoneNumber),
        numberType: "verified_caller_id" as const,
        capabilities: { voice: true, sms: false, mms: false },
      })),
  ];
}

export interface GeoPermission {
  isoCode: string;
  name: string;
  countryCodes: string[];
  lowRiskNumbersEnabled: boolean;
  highRiskSpecialNumbersEnabled: boolean;
  highRiskTollfraudNumbersEnabled: boolean;
}

/** Voice Dialing Permissions (Geo Permissions) for the given ISO country codes. */
export async function fetchGeoPermissions(c: TwilioCreds, isoCodes: string[]): Promise<GeoPermission[]> {
  const client = twilioClient(c);
  return Promise.all(
    isoCodes.map(async (iso) => {
      const p = await client.voice.v1.dialingPermissions.countries(iso).fetch();
      return {
        isoCode: p.isoCode,
        name: p.name,
        countryCodes: p.countryCodes,
        lowRiskNumbersEnabled: p.lowRiskNumbersEnabled,
        highRiskSpecialNumbersEnabled: p.highRiskSpecialNumbersEnabled,
        highRiskTollfraudNumbersEnabled: p.highRiskTollfraudNumbersEnabled,
      };
    }),
  );
}
