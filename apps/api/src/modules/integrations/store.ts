import { query, withTransaction } from "../../db/pool.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../lib/crypto.js";

export type Provider = "openai" | "twilio";
export type IntegrationStatus = "not_connected" | "testing" | "connected" | "error";

export interface IntegrationView {
  provider: string;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  /** e.g. { api_key: "••••abcd" } — safe for the browser, never the real value */
  secrets: Record<string, string>;
  lastTestedAt: string | null;
  lastError: string | null;
}

export async function getIntegration(orgId: string, provider: string): Promise<IntegrationView | null> {
  const { rows } = await query(
    `SELECT i.id, i.provider, i.status, i.config, i.last_tested_at, i.last_error,
            coalesce(json_object_agg(c.key_name, c.masked) FILTER (WHERE c.key_name IS NOT NULL), '{}') AS secrets
       FROM integrations i LEFT JOIN encrypted_credentials c ON c.integration_id = i.id
      WHERE i.org_id = $1 AND i.provider = $2
      GROUP BY i.id`,
    [orgId, provider],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    provider: r.provider,
    status: r.status,
    config: r.config,
    secrets: r.secrets,
    lastTestedAt: r.last_tested_at,
    lastError: r.last_error,
  };
}

/**
 * Saves non-secret config and (optionally) secrets. Secrets passed as undefined are left
 * unchanged, so the UI can update settings without re-entering keys.
 * Any change resets the status to "not_connected" until a new test passes.
 */
export async function saveIntegration(
  orgId: string,
  provider: Provider,
  config: Record<string, unknown>,
  secrets: Record<string, string | undefined>,
) {
  await withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO integrations (org_id, provider, config, status)
       VALUES ($1, $2, $3, 'not_connected')
       ON CONFLICT (org_id, provider)
       DO UPDATE SET config = integrations.config || EXCLUDED.config, status = 'not_connected',
                     last_error = NULL, updated_at = now()
       RETURNING id`,
      [orgId, provider, config],
    );
    const integrationId = rows[0].id;
    for (const [key, value] of Object.entries(secrets)) {
      if (value === undefined) continue;
      if (value === "") {
        await c.query("DELETE FROM encrypted_credentials WHERE integration_id = $1 AND key_name = $2", [integrationId, key]);
        continue;
      }
      const enc = encryptSecret(value);
      await c.query(
        `INSERT INTO encrypted_credentials (org_id, integration_id, key_name, ciphertext, iv, auth_tag, masked)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (integration_id, key_name)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
                       masked = EXCLUDED.masked, updated_at = now()`,
        [orgId, integrationId, key, enc.ciphertext, enc.iv, enc.authTag, maskSecret(value)],
      );
    }
  });
}

/** Server-side only. Never return the result of this function in an HTTP response. */
export async function getSecrets(orgId: string, provider: Provider): Promise<Record<string, string>> {
  const { rows } = await query(
    `SELECT c.key_name, c.ciphertext, c.iv, c.auth_tag
       FROM encrypted_credentials c JOIN integrations i ON i.id = c.integration_id
      WHERE i.org_id = $1 AND i.provider = $2`,
    [orgId, provider],
  );
  return Object.fromEntries(
    rows.map((r) => [r.key_name, decryptSecret({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag })]),
  );
}

export async function setStatus(orgId: string, provider: Provider, status: IntegrationStatus, error: string | null = null) {
  await query(
    `UPDATE integrations SET status = $3, last_error = $4,
            last_tested_at = CASE WHEN $3 IN ('connected','error') THEN now() ELSE last_tested_at END,
            updated_at = now()
      WHERE org_id = $1 AND provider = $2`,
    [orgId, provider, status, error],
  );
}

export async function mergeConfig(orgId: string, provider: Provider, patch: Record<string, unknown>) {
  await query(
    `UPDATE integrations SET config = config || $3, updated_at = now() WHERE org_id = $1 AND provider = $2`,
    [orgId, provider, patch],
  );
}

export async function disconnect(orgId: string, provider: Provider) {
  await withTransaction(async (c) => {
    await c.query(
      `DELETE FROM encrypted_credentials WHERE integration_id IN
         (SELECT id FROM integrations WHERE org_id = $1 AND provider = $2)`,
      [orgId, provider],
    );
    await c.query(
      `UPDATE integrations SET status = 'not_connected', last_error = NULL, updated_at = now()
        WHERE org_id = $1 AND provider = $2`,
      [orgId, provider],
    );
  });
}

export async function markSetupStep(orgId: string, step: string, details: Record<string, unknown> = {}) {
  await query(
    `INSERT INTO setup_progress (org_id, step, details) VALUES ($1,$2,$3)
     ON CONFLICT (org_id, step) DO UPDATE SET verified_at = now(), details = EXCLUDED.details`,
    [orgId, step, details],
  );
}

export async function clearSetupSteps(orgId: string, steps: string[]) {
  await query("DELETE FROM setup_progress WHERE org_id = $1 AND step = ANY($2)", [orgId, steps]);
}

/** Server-side only: decrypted Twilio credentials, or null when not configured. */
export async function twilioCredsFor(orgId: string) {
  const integ = await getIntegration(orgId, "twilio");
  const secrets = await getSecrets(orgId, "twilio");
  if (!integ?.config.accountSid || !secrets.auth_token) return null;
  return {
    accountSid: String(integ.config.accountSid),
    authToken: secrets.auth_token,
    apiKeySid: (integ.config.apiKeySid as string) || undefined,
    apiKeySecret: secrets.api_key_secret,
  };
}
