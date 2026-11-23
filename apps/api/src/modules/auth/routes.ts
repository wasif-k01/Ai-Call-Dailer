import { Router } from "express";
import type { Response } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env, isProd } from "../../config/env.js";
import { query, withTransaction } from "../../db/pool.js";
import { badRequest, conflict, forbidden, unauthorized } from "../../lib/errors.js";
import { requireAuth, SESSION_COOKIE, signSession } from "../../middleware/auth.js";
import { audit } from "../audit/service.js";
import { redis } from "../../lib/redis.js";

const LOCK_MAX_FAILS = 10;
const LOCK_WINDOW_SEC = 15 * 60;
const failKey = (email: string) => `acp:loginfail:${email}`;

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many attempts. Please wait 15 minutes and try again." } },
});

const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200)
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const RegisterSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.email().max(200).transform((e) => e.toLowerCase()),
  password,
  organizationName: z.string().trim().min(2).max(100),
});

const LoginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}

/** Whether a new account can be created. The very first account is always allowed. */
async function signupAllowed() {
  if (env.ALLOW_SIGNUP) return true;
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  return rows[0].n === 0;
}

router.get("/signup-status", async (_req, res) => {
  res.json({ signupAllowed: await signupAllowed() });
});

router.post("/register", authLimiter, async (req, res) => {
  const body = RegisterSchema.parse(req.body);
  if (!(await signupAllowed())) throw forbidden("New sign-ups are disabled. Ask an administrator to invite you.");
  const existing = await query("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
  if (existing.rowCount) throw conflict("An account with this email already exists.");

  const hash = await bcrypt.hash(body.password, 12);
  const user = await withTransaction(async (c) => {
    const org = await c.query("INSERT INTO organizations(name) VALUES ($1) RETURNING id", [body.organizationName]);
    const orgId = org.rows[0].id;
    await c.query("INSERT INTO org_settings(org_id) VALUES ($1)", [orgId]);
    const u = await c.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id, token_version`,
      [orgId, body.email, hash, body.fullName],
    );
    await c.query("INSERT INTO profiles(user_id) VALUES ($1)", [u.rows[0].id]);
    return { id: u.rows[0].id, orgId, tv: u.rows[0].token_version };
  });
  setSessionCookie(res, signSession(user.id, user.tv));
  await audit(req, "auth.register", { orgId: user.orgId, userId: user.id });
  res.status(201).json({ ok: true });
});

router.post("/login", authLimiter, async (req, res) => {
  const body = LoginSchema.parse(req.body);
  // Lock the account (not just the IP) after repeated failures: stops slow, distributed guessing.
  const fails = Number(await redis().get(failKey(body.email)).catch(() => 0)) || 0;
  if (fails >= LOCK_MAX_FAILS) {
    await audit(req, "auth.login_locked", { metadata: { email: body.email } });
    throw forbidden("Too many failed sign-in attempts for this account. Wait 15 minutes and try again.");
  }
  const { rows } = await query(
    "SELECT id, org_id, password_hash, is_active, token_version FROM users WHERE lower(email) = $1",
    [body.email],
  );
  const u = rows[0];
  // Compare against a dummy hash when the user does not exist to keep timing uniform.
  const ok = await bcrypt.compare(body.password, u?.password_hash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
  if (!u || !ok) {
    await redis().multi().incr(failKey(body.email)).expire(failKey(body.email), LOCK_WINDOW_SEC).exec().catch(() => {});
    await audit(req, "auth.login_failed", { metadata: { email: body.email } });
    throw unauthorized("Incorrect email or password.");
  }
  if (!u.is_active) throw forbidden("This account has been disabled.");
  await redis().del(failKey(body.email)).catch(() => {});
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [u.id]);
  setSessionCookie(res, signSession(u.id, u.token_version));
  await audit(req, "auth.login", { orgId: u.org_id, userId: u.id });
  res.json({ ok: true });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const u = req.user!;
  const org = await query("SELECT name FROM organizations WHERE id = $1", [u.orgId]);
  res.json({
    user: { id: u.id, email: u.email, fullName: u.fullName, role: u.role, permissions: u.permissions },
    organization: { id: u.orgId, name: org.rows[0]?.name },
  });
});

const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

router.post("/change-password", requireAuth, authLimiter, async (req, res) => {
  const body = ChangePasswordSchema.parse(req.body);
  const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
  if (!(await bcrypt.compare(body.currentPassword, rows[0].password_hash))) throw badRequest("Current password is incorrect.");
  const hash = await bcrypt.hash(body.newPassword, 12);
  // Bumping token_version signs out every other session.
  const upd = await query(
    "UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2 RETURNING token_version",
    [hash, req.user!.id],
  );
  setSessionCookie(res, signSession(req.user!.id, upd.rows[0].token_version));
  await audit(req, "auth.password_changed");
  res.json({ ok: true });
});

export default router;
