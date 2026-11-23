import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export const SESSION_COOKIE = "acp_session";

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  fullName: string;
  role: string;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenPayload {
  sub: string;
  tv: number;
}

export function signSession(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: "12h",
    audience: "acp-web",
  });
}

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}

export async function loadUserFromToken(token: string): Promise<AuthUser | null> {
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { audience: "acp-web" }) as unknown as TokenPayload;
  } catch {
    return null;
  }
  const user = await loadUserFromId(payload.sub);
  return user && user.tokenVersion === payload.tv ? user : null;
}

export async function loadUserFromId(userId: string): Promise<(AuthUser & { tokenVersion: number }) | null> {
  const { rows } = await query(
    `SELECT u.id, u.org_id, u.email, u.full_name, u.role, u.is_active, u.token_version, r.permissions
       FROM users u JOIN roles r ON r.key = u.role WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u || !u.is_active) return null;
  return {
    id: u.id,
    orgId: u.org_id,
    email: u.email,
    fullName: u.full_name,
    role: u.role,
    permissions: u.permissions,
    tokenVersion: u.token_version,
  };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next(unauthorized());
  const user = await loadUserFromToken(token);
  if (!user) return next(unauthorized("Your session has expired. Please sign in again."));
  const { tokenVersion: _tv, ...authUser } = user as AuthUser & { tokenVersion?: number };
  req.user = authUser;
  next();
}

export function can(user: AuthUser, permission: string) {
  return user.permissions.includes("*") || user.permissions.includes(permission);
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user, permission)) return next(forbidden());
    next();
  };
}
