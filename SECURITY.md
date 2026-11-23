# Security overview

Reviewed in Phase 8 (2026-11-24). This document lists what's protected, how, and the risks that remain.

## Protections in place

| Area | What's done | Where |
|---|---|---|
| **Secrets** | OpenAI/Twilio credentials are AES-256-GCM encrypted at rest (key from `CREDENTIALS_ENCRYPTION_KEY`). The browser only ever receives a masked `••••last4`. They're decrypted only server-side, at the moment of use. | `lib/crypto.ts`, `integrations/store.ts` |
| | `.env` files are git-ignored; only `*.example` templates are committed. Logs redact authorization headers, cookies, passwords and keys. | `.gitignore`, `lib/logger.ts` |
| **Authentication** | bcrypt (cost 12). httpOnly, `SameSite=Lax`, `Secure` (in production) session cookie. JWT with a token version, so changing the password signs out every other session. | `modules/auth` |
| | Rate limit per IP (10 attempts / 15 min), plus a **per-account lockout** after 10 failures within 15 minutes (stops distributed guessing). Sign-up can be turned off with `ALLOW_SIGNUP=false`. | `modules/auth/routes.ts` |
| **Authorization** | Roles owner / admin / agent / viewer, with permission checks on every route. Every query is scoped by `org_id` (tenant isolation is covered by tests). | `middleware/auth.ts` |
| **CSRF** | SameSite cookie, and the JSON API **refuses form / multipart / text-plain bodies** on state-changing requests (HTTP 415). | `middleware/csrf.ts` |
| **Database** | Row Level Security is enabled on every table with no public policies, so the Supabase anon/authenticated keys can't read anything. Only the backend connects. All SQL is parameterised. | `migrations/001_init.sql` |
| **Webhooks** | Every Twilio webhook and Media Stream handshake checks `X-Twilio-Signature` against a URL rebuilt from `PUBLIC_API_URL`. AI audio streams also need a one-time token, of which only a hash is stored. A call can only be started once, by the user who prepared it. | `webhooks/twilio-signature.ts`, `ai/bridge.ts` |
| **WebSockets** | Dashboard sockets need a 60-second, single-purpose ticket. Events are delivered only to the owning organisation. | `realtime/` |
| **Recordings** | No public URLs. Audio is streamed through the authenticated API (`Cache-Control: private, no-store`). Provider SIDs and URLs never reach the browser. Deleting a recording also deletes it in Twilio. Recording is off by default; the AI announces when a call is recorded. | `modules/history/routes.ts` |
| **Calling safeguards** | Do Not Call is checked at the moment of dialling, and opt-outs apply immediately. Geo Permissions are checked. One live browser call per user. Org-wide AI concurrency cap. Campaign concurrency ≤ 10. Calling hours. Consent confirmation **plus typing the exact contact count** before a campaign starts. Idempotency keys. Monthly spending limit with optional hard block. | `calls/`, `campaigns/`, `usage/` |
| **AI safety rules** | Always added and can't be removed by agent settings: disclose that it's an AI, honour opt-outs, keep voicemail short, never ask for financial or ID data. | `ai/agents.ts` |
| **HTTP** | `helmet` on the API. On the web app: HSTS, `X-Frame-Options: DENY`, `nosniff`, a strict Referrer-Policy, Permissions-Policy (microphone only) and a **Content Security Policy**. | `app.ts`, `apps/web/next.config.ts` |
| **Exports** | CSV cells that could run as spreadsheet formulas are neutralised. Exports are audit-logged. | `history/routes.ts` |
| **Audit log** | Sign-ins (including failures and lockouts), integration and settings changes, calls started, campaign actions, exports, deletions, spending alerts. The owner can view them in Settings. | `audit/service.ts` |
| **Dependencies** | `npm audit`: 0 known vulnerabilities (2026-11-24). New packages are pinned to releases at least two weeks old. | |

## Remaining risks / not done

1. **CSP allows inline scripts** (`'unsafe-inline'`), because Next.js needs inline bootstrap scripts unless every request gets a nonce. Moving to a nonce-based CSP would close this.
2. **No two-factor authentication**, and there's no user-invite screen yet (a single owner per workspace).
3. **Client IP behind the Vercel proxy:** per-IP rate limits may see Vercel's IP until `TRUST_PROXY_HOPS` is checked against the live deployment. The per-account lockout doesn't depend on IPs.
4. **No key rotation procedure** for `CREDENTIALS_ENCRYPTION_KEY`. Losing the key means re-entering integration credentials; leaking it exposes them. Keep it sealed in Railway and backed up offline.
5. **Recording and calling consent** is a legal responsibility of the account owner. The platform records the confirmation but can't verify it.
6. **Spending alerts appear in the app only.** There's no email or SMS notification provider yet.
7. **The transcription model `gpt-4o-mini-transcribe` is marked deprecated by OpenAI.** Plan a switch before it's retired.

## Reporting

Report suspected vulnerabilities privately to the workspace owner, not in public issues.
