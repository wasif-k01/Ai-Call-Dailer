# Development Progress — AI Cloud Calling Platform

_Last updated: 2026-11-23_

## Current phase: Phase 8 done → Phase 9 (production deployment & end-to-end testing) next. Still pending: a real campaign test and a real recording test.

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo inspection, architecture, project setup, database, authentication, dashboard | ✅ Done (tested) |
| 2 | Integrations & API Settings UI, setup wizard, OpenAI + Twilio connection, phone numbers | ✅ Done: owner connected real OpenAI + Twilio (full account); US number is default; geo: US/AE/GB allowed, PK blocked (owner will enable later) |
| 3 | Unified Dialer + Human-to-Human calling (Twilio Voice JS SDK) | ✅ Real browser → UAE mobile call completed (75s) on 2026-11-23. **Hold and keypad not yet tried on a real call.** |
| 4 | OpenAI Realtime voice + AI-to-Human calling | Pending |
| 5 | AI Agent management | ✅ Done: CRUD, duplicate, activate/deactivate, guarded delete, instruction preview, test-call shortcut; 10 tests |
| 6 | Bulk campaigns, CSV/XLSX upload, BullMQ queue, DNC list | 🟡 Built; 15 engine/API tests pass with mocked Twilio; **owner hasn't run a real campaign yet** |
| 7 | Live Calls, Call History, Recordings, Transcripts | ✅ Built; 9 tests; checked against real call data (9 calls, 8 transcripts). **Recording not yet tried on a real call** (off by default). |
| 8 | Usage & cost tracking, security hardening | ✅ Done: 13 tests; checked against real Twilio usage records and real OpenAI token data; see SECURITY.md |
| 9 | Production deployment + end-to-end testing | 🟡 Configs, docs and infrastructure code ready; **not deployed** (waiting for approval) |

## Repository inspection (Phase 1)
The repository was empty (no commits), with the remote `wasif-k01/Ai-Call-Dailer`. There was no existing code, so the recommended stack was used.
Local environment: Node 26, PostgreSQL 16 (Homebrew), Redis (Homebrew). Docker is installed but not running, and it isn't needed.
Port 3000 on this machine is used by an unrelated app, so the web app runs on **3100**.

## Architecture
```
apps/web  (Next.js 16, React 19, Tailwind 4)  :3100  → deploy to Vercel
   └─ /api/* is proxied (same origin) to the backend; no secrets in browser code
apps/api  (Express 5, TypeScript, zod, pg)    :4000  → deploy to Railway/Render
   ├─ PostgreSQL (local now → Supabase in production)
   ├─ Redis + BullMQ (bulk campaign queue — Phase 6)
   ├─ Twilio REST + webhooks + Voice SDK tokens (Phases 2–3)
   └─ Twilio Media Streams ⇄ OpenAI Realtime bridge over WebSocket (Phase 4; final choice to be confirmed against current docs)
```

## Completed features
- npm workspaces monorepo (`apps/api`, `apps/web`)
- Environment validation (bad config fails fast and shows variable names only, never values)
- SQL migration runner. Migrations run automatically when the API starts.
- Full schema: organizations, users, roles, profiles, org_settings, contacts, do_not_call_list, integrations, encrypted_credentials, setup_progress, phone_numbers, ai_agents, campaigns, campaign_contacts, campaign_logs, calls, call_events, call_recordings, call_transcripts, usage_records, billing_records, audit_logs. Includes foreign keys, indexes, check constraints, and idempotency key on calls.
- Row Level Security enabled on all tables with no public policies, so the Supabase anon key cannot read any data
- Authentication: register (first user becomes owner), login, logout, me, change password
  - bcrypt (cost 12), httpOnly session cookie, JWT with token version (changing the password signs out other sessions)
  - Rate limiting on auth endpoints and the API overall
- Role-based access control (owner / admin / agent / viewer with permissions)
- Audit logging (register, login, failed login, password change)
- AES-256-GCM credential encryption helper (used by Phase 2)
- Dashboard API (all required stats, scoped to the organization) and dashboard UI
- App shell: sidebar with all 14 sections, responsive mobile menu. Unbuilt sections show an honest "not built yet" placeholder with no fake controls.
- Account Settings: profile and change password
- Health check: `GET /health` (includes a DB check)

## Phase 8: Usage, costs and security
- **Actual vs estimated, kept separate:**
  - `telephony_cost_usd` / `actual_cost_usd` = the price Twilio billed for the call, summed across legs (browser + PSTN for human calls).
  - `ai_cost_usd` = OpenAI **estimate** from response.done token usage (and transcription usage) × list prices.
  - `estimated_cost_usd` = Twilio billed + OpenAI estimate.
- **OpenAI prices** come from developers.openai.com/api/docs/pricing (checked 2026-11-24): gpt-realtime-2.1, gpt-realtime-2.1-mini, gpt-4o-mini-transcribe. The owner can override them on the Usage page. Unknown models are never guessed.
- **Real-world finding:** Twilio returned `price: null` for calls more than an hour old, so its per-call price can take hours. The cost job first retries with backoff (about 2 min, rising to about 2 h). Then a **30-minute sweep** keeps checking for up to 7 days before marking a call "unavailable". Unknown prices stay NULL; they're never shown as $0.
- **Twilio reconciliation:** "Fetch from Twilio" stores Twilio's monthly usage records (`billing_records`). These are account-wide: a real check showed `calls-outbound` $1.20 for 10 minutes, matching this platform's calls (~10.7 min), plus $2.07 of `trunking-termination` that this platform doesn't create (probably another app on the same Twilio account).
- **Usage & Costs page:**
  - month picker; totals (total, Twilio billed, OpenAI estimate, calls, minutes)
  - daily cost chart (validated colours, hover tooltip, table view)
  - breakdowns by country, call type, campaign and token type
  - Twilio bill comparison, spending-limit settings, price table
- **Spending limits:**
  - monthly limit, alert threshold, and action (alert only, or block new AI calls and auto-pause campaigns)
  - alerts are logged once per month and level, sent as a live event, and shown as a banner on the dashboard
  - in-app only (no email provider)
- **Security:**
  - CSRF form-post guard
  - per-account login lockout
  - Content Security Policy on the web app
  - owner audit-log viewer
  - `npm audit` shows 0 vulnerabilities
  - the full review, including remaining risks, is in `SECURITY.md`
- **Known issue:** OpenAI marks `gpt-4o-mini-transcribe` as deprecated (it still works; a switch is planned).

## Phase 7: Live calls, history, recordings, transcripts
- **Live Calls:** every active call, updated live, with a running timer and status.
  - Controls: End call (all calls). Mute (the browser user's conference leg) and Hold (human calls only). View transcript/details.
  - The page explains why Mute/Hold don't apply to AI calls, and why Transfer isn't offered yet (there's no destination to transfer to). No fake controls.
- **Call History:**
  - Search by number; filter by mode, status, agent and date range; pagination.
  - CSV export (up to 10k rows) with a UTF-8 BOM, and spreadsheet-formula injection blocked. Audit-logged.
  - A detail drawer shows info, a plain-English error, estimated cost (if calculated), AI token usage, the recording player, the transcript and an event timeline.
- **Recordings:**
  - Off by default. The owner switches them on in Settings → Calling.
  - When on, AI calls are recorded on two channels (`record: true`, `recordingChannels: dual`), human calls record the whole conference, and the AI is told to announce the recording. The Dialer reminds the human to tell the other person.
  - Recordings are saved by the `/webhooks/twilio/recording` webhook.
  - The audio stays in Twilio and is **streamed through the authenticated API** (Range/seek supported, `Cache-Control: private, no-store`). Provider URLs and SIDs are never exposed.
  - Deleting (admin) removes the recording in Twilio too.
- **Transcripts:** Postgres full-text search across what was said, matching snippets, and .txt download.
- **Settings → Calling** (owner): recording on/off, and the account-wide limit on simultaneous AI calls (1–20).
- **Fix:** a database error after Twilio had already placed an AI call was reported as a Twilio failure, and a live call was marked failed. The Twilio request now has its own error handling.

## Phase 6: Bulk AI calling
- **New campaign wizard:**
  - Upload CSV/XLSX (parsed in the browser: phone/name columns are detected automatically) or paste numbers.
  - The server checks every number, converts it to E.164 (accepting `00` and local formats), and flags duplicates and Do Not Call numbers.
  - Preview table: valid numbers are pre-selected and any can be unticked.
  - Choose agent, campaign instructions (the contact's name is added automatically) and caller ID.
  - Set calling hours in the campaign's timezone (overnight windows work), how many calls run at once (1–10), retries (0–5) and the delay between retries.
  - The campaign is saved as a draft.
- **Starting a campaign:** the user ticks a consent / legal-authorisation box **and types the exact number of contacts**. Both are recorded with who confirmed and when.
- **Engine (worker):**
  - A BullMQ job scheduler ticks every 5s. Rows are locked (`FOR UPDATE SKIP LOCKED`) so several workers can run safely.
  - Each tick: calling-hours check, per-campaign concurrency limit, and the account-wide AI call limit. Hitting the account limit sends the contact back to the queue without using up an attempt.
  - Dial jobs use idempotent job ids and go through the same `placeAiCall` checks as manual AI calls, including a DNC check right before dialling.
  - Problems that won't fix themselves (invalid number, blocked country, DNC) are not retried.
  - Contacts stuck in "queued" are requeued, and contacts still "calling" after their call ended are reconciled.
- **Outcomes** come from Twilio status webhooks: answered, completed, no_answer, busy, failed, opted_out. Retries follow the configured delay. The campaign auto-completes when every contact is done.
- **Controls:** Start / Pause / Resume / Stop. Pause and Stop let calls already in progress finish. Only drafts can be deleted, and contacts can be removed before they're called.
- **Live progress** over WebSocket, with polling as a fallback.
- **Analytics:** total, attempted, answered, successful, failed, opted out, in progress, average duration. Total cost shows "—" until Phase 8.
- **Do Not Call:** whether the AI or a person adds a number, every running campaign drops it immediately. Removing a number is admin-only and audit-logged.
- **Contacts page:** search, paginate, add/edit/delete, consent status and source, DNC badge, call count. The Do Not Call tab lets you add numbers with a reason, see where each entry came from, and (admins only) remove entries.
- **Fixes along the way:**
  - The `00` international prefix was rejected as invalid; it's now accepted in the dialer, campaigns and contacts.
  - Updating a contact failed (parameter count mismatch).
  - The campaign-complete log write waited forever on its own row lock.
- **Dev:** `npm run dev:api:tunnel` now also starts the worker with the tunnel URL, because the worker places campaign calls.

## Phase 5: AI Agent management
- **AI Agents page:** a card per agent (voice, language, style/speed, max length, calls made) with these actions:
  - **Test call**, which opens AI Calling with that agent selected
  - Edit, Duplicate (the copy starts inactive), Activate/Deactivate
  - Delete, with confirmation. Delete is blocked while the agent is on a live call or used by a running/paused campaign. Past calls keep their history.
- **Editor fields:** name, description, instructions, greeting, voice, language (14 + "Match the caller"), conversation style, speaking speed (0.5–1.5×), max call length (0.5–60 min), conversation rules, call-ending instructions, active.
- **"What the AI is told" preview:** shows the exact instruction text sent to OpenAI, including the mandatory rules that are always added.
- **Language:** the agent's language is given to the AI by name, and it may switch if the caller prefers another language.
- **Validation and roles:** names must be unique per workspace (any capitalisation), and messages are plain English. Only owners/admins can edit agents; the agent role can use them.
- **Settings:** the owner can rename the workspace. Its name appears in new agents' greetings; the first workspace was named "Ai".

## Phase 4: AI-to-Human calling
- **Call path:** `POST /api/calls/ai` places the call through Twilio REST. When it's answered, `/webhooks/twilio/voice/ai` returns `<Connect><Stream>`, which feeds the bridge: Twilio μ-law ⇄ OpenAI Realtime (`gpt-realtime-2.1`, `audio/pcmu` both ways, so no re-encoding).
- **Pre-call checks:** OpenAI connected, agent active, DNC list, geo permissions, caller ID, an org-wide cap on simultaneous AI calls (`org_settings.max_concurrent_ai_calls`, default 2), idempotency key.
- **Interruptions:** when the person speaks over the AI (`input_audio_buffer.speech_started`), Twilio playback is cleared and the AI's turn is truncated at the point the person actually heard.
- **Rules the agent can't override:** say it's an AI, honour opt-outs immediately (DNC tool), keep voicemail short, never ask for financial or ID data.
- **Ending a call:** the AI's `end_call` tool, the agent's max duration timer, a Twilio `timeLimit` backstop, or Hang Up. If OpenAI disconnects mid-call, the call is hung up rather than left silent.
- **Transcripts:** both sides are stored in `call_transcripts` and shown live on the call screen.
- **Usage:** token usage per call goes into `usage_records` as an estimate. Cost is calculated in Phase 8.
- **Redeploys:** live AI calls are drained up to Railway's draining window.
- A starter agent, "General Assistant", is created automatically. Full agent management is Phase 5.
- **UI:** the AI Calling page and the Dialer's AI mode have an agent picker, optional per-call instructions, and a live transcript.

## Phase 3: Dialer and human-to-human calling
- **Call setup:** the browser (Twilio Voice SDK 2.18.5) joins a private Twilio **Conference**, and the recipient is dialed into it through the Participants API. A conference is used because Twilio documents Hold for conferences but not for a direct `<Dial>`.
- **Keypad:** Twilio doesn't document whether DTMF passes through conferences, so the server plays the digits straight onto the recipient's line (`<Play digits>`, then rejoins the conference). Key presses are batched (700 ms). **Must be verified on a real call** (e.g. an IVR).
- **Pre-call checks:**
  - number is valid and normalised to E.164
  - the account's real Geo Permissions (cached 10 min; cleared on re-check)
  - Do Not Call list
  - caller ID must be a Twilio-owned or verified number
  - one active call per user, plus an idempotency key and a 10 calls/min rate limit
- **Browser token:** short-lived (1h), outgoing calls only, auto-refreshed. The TwiML App is created automatically and its URLs are repaired when the public URL changes (the tunnel URL changes each run).
- **Webhooks:** `/webhooks/twilio/voice/client`, `/status`, `/client-status`, `/hold`. All check `X-Twilio-Signature` using a URL rebuilt from PUBLIC_API_URL. Each prepared call can be started once, and only by the user who prepared it. Status only moves forward, so late or duplicate webhooks are ignored.
- **Hold:** the recipient hears a spoken "please hold" loop (built-in TwiML; no external music files).
- **Dialer UI:**
  - Human/AI mode switch (AI shows that it arrives in Phase 4)
  - caller ID picker, country selector (US/AE/GB/PK first), live formatting and validation, contact search
  - keypad: types the number when idle, sends tones during a call
  - Call / Hang Up, Mute, Hold/Resume, timer
  - live status over WebSocket, with polling as a fallback
  - plain-English microphone and network errors
- **Local testing:** `npm run dev:api:tunnel` starts a free Cloudflare quick tunnel and runs the API with PUBLIC_API_URL set to it. Checked: the verify script passes through the tunnel, and a forged webhook gets 403.
- **Cost estimates** per call are left empty until Phase 8. Prices will not be invented.

## Phase 2 — Integrations & phone numbers
- Integrations page with OpenAI, Twilio, Database, Redis and "Additional providers" cards. Each shows Connected / Not Connected / Testing / Configuration Error.
- Save / Test Connection / Update / Disconnect (with a confirm step). Saving never marks a card connected; only a passing test does.
- Secrets are AES-256-GCM encrypted in `encrypted_credentials`. The browser only ever gets `••••last4`. Leaving a field empty keeps the saved value. Disconnecting deletes the credentials.
- Format validation: `sk-…`, `AC`+32 hex, 32-hex auth token, `SK…`, `AP…`, `proj_…`
- OpenAI test: `GET /v1/models/{model}` and lists the realtime models the key can use. Errors (bad key, no credit, no model access, rate limit, outage) are explained in plain English.
- Twilio test: fetches the account (status, Trial/Full) with the Auth Token, checks the API key separately if one is set, then syncs numbers automatically.
- Phone numbers: syncs Twilio-owned numbers and verified caller IDs. The default is the first US Twilio voice number. Numbers missing from Twilio are marked "released". Users can make another number default, or add external numbers / SIP endpoints, which can't be used as caller ID. The four number types are kept separate.
- Calling destinations: real Twilio Voice Geo Permissions check per country. Shows a warning for trial accounts.
- Setup wizard: 8 steps with what / where / why / how to check, and a completion %. Steps are only marked verified from real data. Steps for Phases 3, 4 and 6 show "Available after phase N".
- Only owner/admin can manage integrations and numbers (RBAC). Every action is audit-logged.

## Production deployment preparation (done early, at owner's request)
- `.railway/railway.ts` uses Railway Infrastructure as Code with services `api` and `worker` and a `redis` database. Secrets use `preserve()` and are never stored in git. The old `railway.json` format is deprecated and stops being read on 2026-12-01.
- `apps/web/vercel.json` and `next.config.ts`: monorepo install, security headers, and the build refuses to run in production without an https `API_URL`.
- Env templates: `apps/api/.env.production.example`, `apps/web/.env.production.example`, `apps/web/.env.example`
- Migrations run as Railway's pre-deploy step, with an advisory lock so concurrent runs are safe
- Supabase: session pooler connection, optional CA-cert verification, private `call-recordings` bucket (used from Phase 7)
- WebSocket server: one upgrade router; `/ws/events` uses a 60-second ticket; 25s heartbeat; 1012 close on redeploy
- Redis pub/sub event bus, so the worker and every API replica reach every browser
- Worker process (`dist/worker.js`): BullMQ queues, heartbeat shown in `/health`, finishes in-flight jobs before shutting down on SIGTERM. The campaign job processor arrives in Phase 6.
- `/health` reports db / redis / worker / version
- `scripts/verify-deployment.mjs`: read-only post-deploy smoke test
- Docs: `DEPLOYMENT.md`, `docs/TWILIO_WEBHOOKS.md`, `docs/OPENAI_REALTIME.md`

## Tests
`npm test` — 111 passing (13 new in Phase 8). Earlier: 98 (9 new in Phase 7). Earlier: 89 (15 new in Phase 6: validation, limits, consent and count gate, concurrency, calling hours, outcomes, retries, completion, pause/resume/stop, permanent failures, mid-campaign DNC, account-wide limit, opt-out, contacts and DNC). Earlier: 74 (10 new in Phase 5: agents). Earlier: 64 (10 new in Phase 4: REST call creation, OpenAI-required, DNC/inactive agent, concurrency cap, Twilio refusal, bad handshake signature, bad token, single-use token, the full bridge conversation, OpenAI-disconnect hang-up). Earlier: 52 (16 new in Phase 3: pre-call validation, geo/DNC blocks, idempotency, one-active-call rule, RBAC, token grants, TwiML App create/repair, forged/unsigned webhooks, single-use call start, forward-only status, failure explanation, cancel-before-answer, hold, keypad). Earlier: 36 (16 new in Phase 2: OpenAI/Twilio save, encryption, masking, test success/failure messages, number sync, default rules, geo permissions, setup %, RBAC). Earlier suites: auth, password hashing, validation, duplicate email, session invalidation, audit log, cross-org isolation, encryption, WebSocket ticket auth, per-org event isolation, unknown WS path, health, concurrent migrations.
The production build was also checked locally: `migrate.js` then `index.js` then `worker.js` ran with NODE_ENV=production; health reported all OK; SIGTERM shut both down cleanly. `verify-deployment.mjs` passed against the local stack.
Web: `tsc`, `eslint`, and `next build` all pass. Manual smoke test through the web proxy passed.

## Required credentials / integration status
| Integration | Needed in phase | Status |
|---|---|---|
| OpenAI API key | 2: enter on the Integrations page | ⏳ Waiting for owner |
| Twilio Account SID + Auth Token | 2: enter on the Integrations page | ⏳ Waiting for owner |
| Twilio API Key SID/Secret + TwiML App | 3 | Not created yet |
| Public HTTPS URL for Twilio webhooks (tunnel or deployed backend) | 3 | Not set up |
| Supabase project | 9 | Not needed yet (local Postgres) |
| Hosted Redis | 9 | Not needed yet (local Redis) |

## Known issues / notes
- **From the first real AI call, fixed:**
  - The AI greeted twice: the pick-up "hello" triggered a reply. Replies now stay off until the greeting has played.
  - It said "I'm an AI assistant" in every reply. It now says it once, in the greeting, and again only if asked.
- **Follow-up, from later test calls:** interruption logs showed only 1–3 interruptions per call, so short sounds/noise are unlikely to be the cause. The main suspect is the audio route via the Mac and Cloudflare tunnel; re-check after deploying to Railway.
- **Original report, from the first real AI call:** the caller said the AI's "voice is breaking". The cause is unconfirmed. Likely suspects: short sounds ("mhm", noise) counting as interruptions, or audio being routed via the Mac and Cloudflare tunnel instead of a server near Twilio. Interruptions are now logged (`ai.interrupted`, with how much audio was heard) so the next test can tell them apart.
- The greeting says "on behalf of Ai" because the workspace is named "Ai". This can be edited in AI Agents (Phase 5).
- **Fixed 2026-11-23:** the Twilio test read the Account resource with the API key. Standard keys get error 70004 there, so valid keys were reported as "rejected". It now checks the key by listing TwiML Apps.
- **Fixed:** saving an API key no longer resets the "countries checked" wizard step.
- Not yet verified on a real call: Hold (spoken hold loop) and keypad tones (server-side `<Play digits>`).
- WebSocket paths for Twilio media (`/twilio/media-stream`) and the Twilio webhooks are designed but not built (Phases 3–4).
- Behind the Vercel proxy, `req.ip` may be Vercel's IP. This needs checking after the first deploy; `TRUST_PROXY_HOPS=2` may be needed (see DEPLOYMENT.md).
- `railway config plan` hasn't been run yet, because it needs the owner's Railway login. The IaC file typechecks and evaluates locally to `redis`, `api`, `worker`.
- Supabase Auth is not used. The backend runs its own auth, so the database works on any Postgres, including Supabase.
- Sign-ups are open in dev (`ALLOW_SIGNUP=true`). Set it to `false` after creating the owner account.

## Deployment status
Not deployed. Follow DEPLOYMENT.md; every deploy step needs owner approval.
