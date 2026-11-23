# Development Progress — AI Cloud Calling Platform

_Last updated: 2026-11-23_

## Current phase: Phase 1 complete + production deployment prepared (not deployed) → Phase 2 next

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo inspection, architecture, project setup, database, authentication, dashboard | ✅ Done (tested) |
| 2 | Integrations & API Settings UI, setup wizard, OpenAI + Twilio connection, phone numbers | ⏳ Next |
| 3 | Unified Dialer + Human-to-Human calling (Twilio Voice JS SDK) | Pending |
| 4 | OpenAI Realtime voice + AI-to-Human calling | Pending |
| 5 | AI Agent management | Pending |
| 6 | Bulk campaigns, CSV/XLSX upload, BullMQ queue, DNC list | Pending |
| 7 | Live Calls, Call History, Recordings, Transcripts | Pending |
| 8 | Usage & cost tracking, security hardening | Pending |
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
`npm test` — 20 passing: auth, password hashing, validation, duplicate email, session invalidation, audit log, cross-org isolation, encryption, WebSocket ticket auth, per-org event isolation, unknown WS path, health, concurrent migrations.
The production build was also checked locally: `migrate.js` then `index.js` then `worker.js` ran with NODE_ENV=production; health reported all OK; SIGTERM shut both down cleanly. `verify-deployment.mjs` passed against the local stack.
Web: `tsc`, `eslint`, and `next build` all pass. Manual smoke test through the web proxy passed.

## Required credentials / integration status
| Integration | Needed in phase | Status |
|---|---|---|
| OpenAI API key | 2 (enter it in the UI) | Not connected |
| Twilio Account SID + Auth Token | 2 (enter them in the UI) | Not connected |
| Twilio API Key SID/Secret + TwiML App | 3 | Not created yet |
| Public HTTPS URL for Twilio webhooks (tunnel or deployed backend) | 3 | Not set up |
| Supabase project | 9 | Not needed yet (local Postgres) |
| Hosted Redis | 9 | Not needed yet (local Redis) |

## Known issues / notes
- WebSocket paths for Twilio media (`/twilio/media-stream`) and the Twilio webhooks are designed but not built (Phases 3–4).
- Behind the Vercel proxy, `req.ip` may be Vercel's IP. This needs checking after the first deploy; `TRUST_PROXY_HOPS=2` may be needed (see DEPLOYMENT.md).
- `railway config plan` hasn't been run yet, because it needs the owner's Railway login. The IaC file typechecks and evaluates locally to `redis`, `api`, `worker`.
- Supabase Auth is not used. The backend runs its own auth, so the database works on any Postgres, including Supabase.
- Sign-ups are open in dev (`ALLOW_SIGNUP=true`). Set it to `false` after creating the owner account.

## Deployment status
Not deployed. Follow DEPLOYMENT.md; every deploy step needs owner approval.
