/**
 * Railway Infrastructure as Code for the AI Cloud Calling Platform backend.
 *
 *   api     Express API + WebSocket server (dashboard events, Twilio media streams)
 *   worker  BullMQ background worker (bulk campaigns, maintenance)
 *   redis   Railway-managed Redis (job queues + pub/sub between api and worker)
 *
 * The database is Supabase (not Railway), and the frontend is on Vercel.
 *
 * Secrets are NEVER written here. `preserve()` tells Railway to keep whatever
 * value was entered in the dashboard (Service → Variables), so this file is
 * safe to commit.
 *
 * Preview:  npx railway config plan
 * Apply:    npx railway config apply      (only after approval — see DEPLOYMENT.md)
 */
import { defineRailway, github, preserve, project, redis, service } from "railway/iac";

const REPO = "wasif-k01/Ai-Call-Dailer";
const BRANCH = "main";

// Both services build the same monorepo from its root (npm workspaces need the
// root package.json + lockfile), then run different entry points.
const BUILD = "npm ci --include=dev -w @acp/api --include-workspace-root && npm run build -w @acp/api";
// Only redeploy the backend when backend code changes, not on frontend-only commits.
const WATCH = ["/apps/api/**", "/package.json", "/package-lock.json", "/.nvmrc"];

export default defineRailway(() => {
  const cache = redis("redis");

  const api = service("api", {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "RAILPACK", buildCommand: BUILD, watchPatterns: WATCH },
    deploy: {
      startCommand: "node apps/api/dist/index.js",
      // Migrations run once per deploy, before the new version takes traffic.
      // A failed migration stops the deploy and the old version keeps serving.
      preDeployCommand: ["node apps/api/dist/db/migrate.js"],
      preDeployTimeoutSeconds: 300,
      healthcheckPath: "/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // Calls hold long-lived WebSockets (Twilio audio ⇄ OpenAI), so the service must never sleep.
      sleepApplication: false,
      // Give in-progress calls time to finish when a new version is deployed.
      drainingSeconds: 300,
      numReplicas: 1,
    },
    // Generated *.up.railway.app domain with HTTPS/WSS, routed to the app's PORT.
    networking: { serviceDomains: { api: {} } },
    env: {
      NODE_ENV: "production",
      RUN_MIGRATIONS_ON_START: "false",
      TRUST_PROXY_HOPS: "1",
      LOG_LEVEL: "info",
      REDIS_URL: cache.env.REDIS_URL,
      // ── set these in the Railway dashboard; preserved, never stored in git ──
      DATABASE_URL: preserve(), // Supabase session pooler (port 5432)
      DATABASE_SSL: preserve(),
      DATABASE_CA_CERT: preserve(),
      JWT_SECRET: preserve(),
      CREDENTIALS_ENCRYPTION_KEY: preserve(),
      WEB_ORIGIN: preserve(), // https://<your-app>.vercel.app
      PUBLIC_API_URL: preserve(), // https://<api>.up.railway.app (used for Twilio webhooks + wss)
      ALLOW_SIGNUP: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      SUPABASE_STORAGE_BUCKET: preserve(),
    },
  });

  const worker = service("worker", {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "RAILPACK", buildCommand: BUILD, watchPatterns: WATCH },
    deploy: {
      startCommand: "node apps/api/dist/worker.js",
      restartPolicyType: "ALWAYS",
      sleepApplication: false,
      drainingSeconds: 120, // lets in-flight jobs finish on redeploy
      numReplicas: 1,
    },
    // No public domain: the worker only talks to Redis, Postgres and provider APIs.
    env: {
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      REDIS_URL: cache.env.REDIS_URL,
      // Shared with the api service so there is a single place to change each secret.
      DATABASE_URL: api.env.DATABASE_URL,
      DATABASE_SSL: api.env.DATABASE_SSL,
      DATABASE_CA_CERT: api.env.DATABASE_CA_CERT,
      JWT_SECRET: api.env.JWT_SECRET,
      CREDENTIALS_ENCRYPTION_KEY: api.env.CREDENTIALS_ENCRYPTION_KEY,
      PUBLIC_API_URL: api.env.PUBLIC_API_URL,
      WEB_ORIGIN: api.env.WEB_ORIGIN,
      SUPABASE_URL: api.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: api.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_STORAGE_BUCKET: api.env.SUPABASE_STORAGE_BUCKET,
    },
  });

  return project("ai-cloud-calling", { resources: [cache, api, worker] });
});
