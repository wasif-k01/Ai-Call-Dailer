# Production Deployment Guide

**Nothing here has been deployed.** Each step marked ⛔ **APPROVAL** is a point where the owner must say "go" before it runs.

## What runs where

```
 Browser ──HTTPS──▶ Vercel (apps/web, Next.js)
    │                  └─ /api/*  ──rewrite──▶ Railway "api"   (same-origin; session cookie stays first-party)
    │
    └──WSS (ticket)──────────────────────────▶ Railway "api"  /ws/events      dashboard live updates
                                                   ▲
 Twilio ──HTTPS webhooks───────────────────────────┤  /webhooks/twilio/*         (Phase 3+)
 Twilio ──WSS Media Streams (μ-law audio)──────────┤  /twilio/media-stream       (Phase 4)
                                                   │        ⇅ WSS
                                                   │   OpenAI Realtime (gpt-realtime-2.1)
                                                   │
                         Railway "worker" ◀─BullMQ─┼─▶ Railway "redis"  (queues + pub/sub)
                                                   │
                                     Supabase Postgres (session pooler) + Storage (recordings)
```

| Component | Host | Config file |
|---|---|---|
| Frontend | Vercel | `apps/web/vercel.json`, `apps/web/next.config.ts`, `apps/web/.env.production.example` |
| API + WebSockets | Railway service `api` | `.railway/railway.ts` |
| Background worker | Railway service `worker` | `.railway/railway.ts` |
| Redis | Railway database `redis` | `.railway/railway.ts` |
| Postgres + Storage | Supabase | `apps/api/migrations/*.sql`, `apps/api/.env.production.example` |

### Why these choices
- **Vercel can't host the backend.** Vercel functions are short-lived and can't hold a WebSocket open. A live call keeps two sockets open for its whole length (Twilio ⇄ API ⇄ OpenAI), so the API runs on Railway as an always-on process with `sleepApplication: false`.
- **The browser talks to Railway directly for WebSockets.** Vercel rewrites don't carry WebSocket traffic. The browser asks for a 60-second ticket through the normal `/api` proxy, then connects to `wss://<api>/ws/events?ticket=…`.
- **Twilio talks to Railway directly.** It never goes through Vercel. That's required for webhook signature checks and for streaming audio.
- **The API and the worker are separate services.** Campaign jobs can't slow down live call audio, and either one can be redeployed or scaled on its own.
- **Railway Infrastructure as Code (`.railway/railway.ts`).** Railway's older `railway.json` format stops being read on 2026-12-01, and new services can't use it.

## Before you start
- Accounts: GitHub (the repo is already there), Supabase, Railway, Vercel. Twilio and OpenAI are needed from Phase 3/4 onwards.
- Region: put everything in **US East**: Supabase `us-east-1`, Railway US East (Virginia). Twilio's default media edge and OpenAI are closest there, which keeps call audio latency low.
- Do the steps in order. Step 2 needs values from Step 1, and Step 3 needs the API URL from Step 2.

---

## Step 0 — Push the code to GitHub ⛔ APPROVAL
Railway and Vercel both deploy from GitHub.

```bash
npm test                        # 20 tests, uses local Postgres/Redis, no real provider calls
npm run build                   # api + web
git add -A && git commit -m "…" && git push origin main
```

Before pushing, check that `git status` shows no `.env` or `.env.local` files. Both are git-ignored, and only `*.example` templates should be committed.

## Step 1 — Supabase (database + file storage)
1. Go to https://supabase.com/dashboard, click **New project**, and choose region **East US (North Virginia)**. Generate a strong database password and save it in your password manager.
2. Click **Connect** (top bar), then **Session pooler**, and copy the URI.
   It looks like `postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
   - Use the **Session pooler (port 5432)**. Do **not** use the Transaction pooler (6543), because migrations need a session-level lock. Do **not** use the direct `db.<ref>.supabase.co` host: it's IPv6-only unless you buy the IPv4 add-on.
3. Optional but recommended: go to **Database → Settings → SSL Configuration** and download the certificate. Its contents become `DATABASE_CA_CERT`, which makes the API verify the database's identity.
4. Go to **Storage**, click **New bucket**, name it `call-recordings`, and leave **Public bucket OFF**. Recordings will only be served through short-lived signed URLs issued by the API (Phase 7).
5. Go to **Project Settings → API** and note the Project URL (`SUPABASE_URL`) and the `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`).
   - The service-role key goes on **Railway only**. It must never go into Vercel or any `NEXT_PUBLIC_*` variable.

You do **not** run SQL by hand. Migrations run automatically as Railway's pre-deploy step on every deploy (Step 2). After the first deploy, **Advisors → Security** should show RLS enabled on every table. The tables have no public policies on purpose: only the backend reads them.

## Step 2 — Railway (API, worker, Redis)
1. Install the CLI and sign in:
   ```bash
   brew install railway            # or: npm i -g @railway/cli
   railway login
   ```
2. In the Railway dashboard, create an **empty project**, connect your GitHub account, and give Railway access to `wasif-k01/Ai-Call-Dailer`. Then, from the repo root:
   ```bash
   railway link                    # choose the new project, environment "production"
   npx railway config plan         # READ-ONLY preview of what will be created
   ```
   Review the plan. It should create exactly one Redis database and two services, `api` and `worker`.
3. ⛔ **APPROVAL** — create the infrastructure:
   ```bash
   npx railway config apply
   ```
   The first deploy is **expected to fail its health check**, because the secret variables don't exist yet. That's fine.
4. Generate a public domain: go to **api → Settings → Networking**. If a `*.up.railway.app` domain isn't already listed, click **Generate Domain**. Copy it.
5. Set the variables: go to **api → Variables** and add each one from `apps/api/.env.production.example`:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Supabase session pooler URI (Step 1.2) |
   | `DATABASE_SSL` | `true` |
   | `DATABASE_CA_CERT` | PEM from Step 1.3 (or leave empty) |
   | `JWT_SECRET` | output of `openssl rand -base64 48` (a **new** value, not your local one) |
   | `CREDENTIALS_ENCRYPTION_KEY` | output of `openssl rand -base64 32`. **Back this up.** If it's lost, saved OpenAI/Twilio credentials can't be decrypted. |
   | `PUBLIC_API_URL` | `https://<the domain from step 4>` |
   | `WEB_ORIGIN` | your Vercel URL (fill in after Step 3; use a placeholder until then) |
   | `ALLOW_SIGNUP` | `true` (switch to `false` in Step 4) |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | from Step 1.5 / `call-recordings` |

   Mark the secrets as **sealed** in Railway (⋮ → Seal) so they can't be read back from the dashboard. The `worker` service references the `api` values automatically, so you don't enter anything twice.
6. ⛔ **APPROVAL** — redeploy both services: **api → Deployments → Redeploy**, then do the same for **worker**.
   The api deploy runs `node apps/api/dist/db/migrate.js` before starting. If a migration fails, the deploy stops and nothing changes.
7. Verify:
   ```bash
   node scripts/verify-deployment.mjs --api https://<api-domain>
   ```
   Expected result: database ✅, redis ✅, worker heartbeat ✅, websocket upgrade ✅ (401 without a ticket).

## Step 3 — Vercel (frontend)
1. Go to https://vercel.com/new, import `wasif-k01/Ai-Call-Dailer`, and set:
   - **Root Directory:** `apps/web`. Keep "Include files outside the root directory" **enabled**, because the install step uses the root lockfile.
   - Framework: Next.js (detected). The install and build commands come from `apps/web/vercel.json`.
2. Under **Environment Variables**, add `API_URL = https://<api-domain>` for **Production** and **Preview**.
   - It's read at **build** time. If you change it later, you must redeploy.
   - The build refuses to run in production if `API_URL` is missing or isn't `https://`.
3. ⛔ **APPROVAL** — click **Deploy**.
4. Go back to Railway, set **api → Variables → `WEB_ORIGIN`** to the Vercel production URL (for example `https://ai-cloud-calling.vercel.app`), and redeploy the api.
5. Verify the whole path:
   ```bash
   node scripts/verify-deployment.mjs --api https://<api-domain> --web https://<vercel-domain>
   ```

## Step 4 — Create the owner account and lock sign-ups
1. Open `https://<vercel-domain>/register` and create your owner account.
2. In Railway, set **api → Variables → `ALLOW_SIGNUP` = `false`** and redeploy. From then on, only the owner can add users.

## Step 5 — Connect OpenAI and Twilio (in the app, not in env vars)
Open **Integrations & API Settings** in the dashboard and follow the wizard (built in Phase 2).
For the Twilio console settings, see [docs/TWILIO_WEBHOOKS.md](docs/TWILIO_WEBHOOKS.md). For the voice/model setup, see [docs/OPENAI_REALTIME.md](docs/OPENAI_REALTIME.md).

---

## Production checklist
- [ ] `verify-deployment.mjs` passes against the production URLs
- [ ] Supabase Advisors show RLS enabled on all tables, and the `call-recordings` bucket is private
- [ ] `ALLOW_SIGNUP=false` once the owner exists
- [ ] Secrets are sealed in Railway, and the service-role key exists **only** on Railway
- [ ] A backup of `CREDENTIALS_ENCRYPTION_KEY` is in your password manager
- [ ] Twilio Geo Permissions are enabled only for the countries you actually call (US, AE, GB, PK, …)
- [ ] Supabase daily backups are on (the Pro plan includes point-in-time recovery)

## Operating notes
- **Deploying during live calls.** On redeploy, Railway sends SIGTERM and keeps the old instance running for `drainingSeconds` (300s for the api). Calls longer than that will be cut off, so deploy outside your calling hours.
- **Scaling.** Keep `api` at 1 replica until Phase 4 is done. Audio sessions are tied to the instance that holds the socket. Dashboard events already fan out across replicas through Redis pub/sub. The worker can be scaled freely, because BullMQ hands each job to only one worker.
- **Logs.** Both services log JSON to stdout, and secrets are redacted. View them in Railway → service → **Logs**.
- **Rollback.** Railway: service → Deployments → pick a previous deploy → **Redeploy**. Vercel: Deployments → **Promote to Production**. Migrations only ever add things, so an older API version keeps working against a newer schema.
- **Client IPs and rate limits.** Dashboard traffic arrives through Vercel's proxy, so the API may see Vercel's address instead of the user's. After the first deploy, look at `req.ip` in the Railway logs. If it's a Vercel address, set `TRUST_PROXY_HOPS=2`. This is an open item that needs checking against the live deployment.

## Infrastructure as Code workflow
`.railway/railway.ts` is the source of truth for the Railway services. When you change it:
```bash
npx railway config plan    # review
npx railway config apply   # ⛔ approval
```
Railway doesn't re-read this file on `git push`. Code changes deploy automatically on push to `main`; infrastructure changes need `config apply`.
