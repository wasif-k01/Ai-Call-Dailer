# Twilio configuration for production

> **Status:** the webhook endpoints below are **planned**. They will be built and tested in Phase 3 (human calls) and Phase 4 (AI calls). This document fixes the URLs and security rules now, so the deployment doesn't need to change later. Until then, Twilio has nothing to call.

All URLs use `PUBLIC_API_URL`, the Railway API domain (for example `https://api-xxxx.up.railway.app`). **Never** use the Vercel URL. Twilio has to reach the API directly.

## Endpoints

| Purpose | Method + URL | Who sets it | Phase |
|---|---|---|---|
| Browser (human) call: returns `<Dial>` TwiML | `POST {PUBLIC_API_URL}/webhooks/twilio/voice/client` | TwiML App **Voice Request URL** (the app sets this through the API when you connect Twilio) | 3 |
| Call status updates (ringing, answered, completed, busy, no-answer, failed) | `POST {PUBLIC_API_URL}/webhooks/twilio/status` | Sent per call by the backend as `statusCallback`. Nothing to configure in the console. | 3 |
| AI call: returns `<Connect><Stream>` TwiML | `POST {PUBLIC_API_URL}/webhooks/twilio/voice/ai` | Sent per call by the backend as the call's `url` | 4 |
| Live call audio (Media Streams, μ-law 8 kHz, both ways) | `wss://{api-domain}/twilio/media-stream` | Inside the `<Stream>` TwiML. Nothing to configure. | 4 |
| Recording finished | `POST {PUBLIC_API_URL}/webhooks/twilio/recording` | Sent per call as `recordingStatusCallback` | 7 |

Most URLs are attached **per call** by the backend when it calls Twilio's REST API, so there is very little to set in the console. The only console object is the **TwiML App** that browser calling uses, and the Integrations page will create or update it for you.

## What you set up manually in the Twilio Console

### 1. Voice Geo Permissions (needed before calling outside the US)
Go to Console → **Voice → Settings → Geo permissions** (https://console.twilio.com/us1/develop/voice/settings/geo-permissions).
- Tick only the countries you'll actually call: **United States/Canada**, **United Arab Emirates**, **United Kingdom**, **Pakistan**, and any others you need.
- Some countries are marked high-risk and show extra warnings or need extra steps. Twilio blocks calls to unticked countries with error **13227/21215**, and the dialer will show a plain-English message when that happens.
- Trial accounts can only call **verified** numbers. Upgrade the account to call anyone.

### 2. API Key (Phase 3, for browser calling)
Go to Console → **Account → API keys & tokens → Create API key** (type: *Standard*).
Copy the **SID** (`SK…`) and **Secret**. The secret is shown only once. Enter both on the app's **Integrations** page. **Not** in env vars, and **not** in chat.

### 3. Your existing US number
The number stays a normal Programmable Voice number and is used as the outbound caller ID for both human and AI calls. You don't need to change its incoming-call settings for outbound-only use.
If you also want inbound calls later, its "A call comes in" webhook will point to `{PUBLIC_API_URL}/webhooks/twilio/voice/inbound`. That's not built yet.

## Security rules the backend enforces
- **Signature validation on every webhook.** Twilio signs each request with `X-Twilio-Signature` (HMAC-SHA1 over the full URL plus the POST parameters, keyed with the account **Auth Token**). The API rebuilds the URL from `PUBLIC_API_URL` and the request path, not from the incoming Host header, because Railway's proxy changes the scheme and host. If `PUBLIC_API_URL` doesn't match the domain Twilio called, every webhook gets **403**. That's the first thing to check if calls fail right after a domain change.
- **Media Stream authentication.** The WebSocket upgrade is checked the same way, and each stream also carries a one-time, per-call token passed as a `<Parameter>`. An unknown or reused token closes the stream.
- **Idempotency.** Twilio retries webhooks, so status events are stored with the `CallSid` + status and applied once.
- **No secrets in URLs.** Nothing sensitive goes into query strings Twilio will log.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Twilio debugger shows **11200 HTTP retrieval failure** | API down or wrong URL. Run `node scripts/verify-deployment.mjs --api …` |
| Webhooks return **403** | `PUBLIC_API_URL` doesn't match the Railway domain exactly (scheme/host) |
| **13227** / "Permission to call … not enabled" | That country isn't ticked in Geo Permissions |
| **21219** / unverified number | Twilio trial account calling a non-verified number |
| AI call connects but is silent | WSS blocked or the media stream failed: check `api` logs for `/twilio/media-stream` |
