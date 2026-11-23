import type { Request } from "express";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";

export async function audit(
  req: Request | null,
  action: string,
  opts: { orgId?: string; userId?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
) {
  try {
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, entity_type, entity_id, ip, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        opts.orgId ?? req?.user?.orgId ?? null,
        opts.userId ?? req?.user?.id ?? null,
        action,
        opts.entityType ?? null,
        opts.entityId ?? null,
        req?.ip ?? null,
        opts.metadata ?? {},
      ],
    );
  } catch (err) {
    logger.warn({ err, action }, "failed to write audit log");
  }
}
