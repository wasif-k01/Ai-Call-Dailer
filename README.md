# AI Cloud Calling Platform

Human-to-human and AI-to-human calling from one dialer, plus bulk AI campaigns.
See [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md) for status.

## Local development

Requirements: Node 20+, PostgreSQL 14+, Redis.

```bash
npm install
createdb acp_dev && createdb acp_test
cp apps/api/.env.example apps/api/.env
# fill JWT_SECRET (openssl rand -base64 48) and CREDENTIALS_ENCRYPTION_KEY (openssl rand -base64 32)
npm run dev:api     # http://localhost:4000  (runs migrations on start)
npm run dev:worker  # background worker (BullMQ)
npm run dev:web     # http://localhost:3100
npm test            # API tests (uses acp_test, never calls real providers)
```

Open http://localhost:3100/register to create the owner account.

Secrets live only in `apps/api/.env` (git-ignored) or in the encrypted `encrypted_credentials` table.
They are never sent to the browser.

## Production

See [DEPLOYMENT.md](DEPLOYMENT.md): Vercel (web), Railway (api + worker + Redis via `.railway/railway.ts`), Supabase (Postgres + Storage).
