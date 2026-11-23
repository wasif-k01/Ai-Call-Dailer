import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: boolish.default(false),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** base64-encoded 32-byte key used for AES-256-GCM encryption of stored credentials */
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  /** Origin of the web dashboard, used for CORS */
  WEB_ORIGIN: z.string().default("http://localhost:3100"),
  /** Public HTTPS URL of this API, used to build Twilio webhook URLs */
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  ALLOW_SIGNUP: boolish.default(true),
  /** Run SQL migrations when the API boots. In production they run as Railway's pre-deploy step instead. */
  RUN_MIGRATIONS_ON_START: boolish.default(true),
  /** Optional PEM CA certificate (Supabase → Database → SSL). When set, the server certificate is verified. */
  DATABASE_CA_CERT: z.string().optional(),
  /** Number of reverse proxies in front of the API (Railway edge = 1). Used for client IP / rate limiting. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Supabase Storage for call recordings (Phase 7). Backend-only; never exposed to the browser. */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("call-recordings"),
  LOG_LEVEL: z.string().default("info"),
  /** OpenAI Realtime WebSocket endpoint (overridable only so tests can use a local fake). */
  OPENAI_REALTIME_URL: z.string().default("wss://api.openai.com/v1/realtime"),
  /** Model that transcribes what the person on the phone says. */
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Empty values count as "not set", so defaults and optional settings work
 *  (e.g. Railway variable references to an unset variable resolve to ""). */
export function cleanEnv(raw: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ""));
}

export function parseEnv(raw: NodeJS.ProcessEnv) {
  return EnvSchema.safeParse(cleanEnv(raw));
}

function load(): Env {
  const parsed = parseEnv(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // Never print values, only which variables are wrong.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === "production";
