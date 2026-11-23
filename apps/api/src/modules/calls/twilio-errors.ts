/** Plain-English explanations for Twilio call-placement errors (codes from the Twilio error dictionary). */
export function explainCallError(err: any): { code: string; message: string } {
  const code = String(err?.code ?? err?.ErrorCode ?? "unknown");
  const map: Record<string, string> = {
    "13227": "Twilio isn't allowed to call this country yet. Turn it on in Twilio Console → Voice → Settings → Geo permissions.",
    "21215": "Twilio's Geo Permissions block calls to this country. Turn it on in Twilio Console → Voice → Settings → Geo permissions.",
    "21210": "The caller ID number isn't verified in your Twilio account. Choose another caller ID on the Phone Numbers page.",
    "21211": "That phone number isn't valid. Check the country code and number.",
    "21212": "The caller ID number isn't valid for this call. Choose another caller ID.",
    "21216": "Twilio has blocked calls to this number (often premium-rate or high-risk numbers).",
    "21219": "Your Twilio account is a trial and this number isn't verified. Verify it in Twilio or upgrade the account.",
    "21217": "That phone number isn't valid. Check the country code and number.",
    "20003": "Twilio rejected the saved credentials. Re-test the Twilio connection on the Integrations page.",
    "20429": "Too many calls are being placed at once. Wait a moment and try again.",
  };
  return { code, message: map[code] ?? `The call couldn't be placed (Twilio error ${code}). ${err?.message ?? ""}`.trim() };
}
