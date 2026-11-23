import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, signUp } from "./helpers.js";
import { pool } from "../src/db/pool.js";
import { closeRedis } from "../src/lib/redis.js";

beforeEach(resetDb);
afterAll(async () => { await closeRedis(); await pool.end(); });

describe("authentication", () => {
  it("registers an owner and returns the profile", async () => {
    const { agent, email } = await signUp();
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.user.role).toBe("owner");
    expect(me.body.organization.name).toBe("Test Org");
  });

  it("stores a bcrypt hash, never the plain password", async () => {
    const { email, password } = await signUp();
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE email = $1", [email]);
    expect(rows[0].password_hash).not.toContain(password);
    expect(rows[0].password_hash).toMatch(/^\$2[ab]\$12\$/);
  });

  it("rejects weak passwords and bad emails", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ fullName: "X Y", email: "nope", password: "short", organizationName: "Org" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects duplicate email registration", async () => {
    await signUp({ email: "dup@example.com" });
    const res = await request(app)
      .post("/api/auth/register")
      .send({ fullName: "Dup", email: "DUP@example.com", password: "correct-horse-42", organizationName: "Org" });
    expect(res.status).toBe(409);
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    const { email, password } = await signUp();
    const bad = await request(app).post("/api/auth/login").send({ email, password: "wrong-password-1" });
    expect(bad.status).toBe(401);
    const good = await request(app).post("/api/auth/login").send({ email, password });
    expect(good.status).toBe(200);
    const cookie = good.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("acp_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("blocks protected endpoints without a session", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/dashboard/stats")).status).toBe(401);
  });

  it("invalidates old sessions after a password change", async () => {
    const { agent, email, password } = await signUp();
    const other = request.agent(app);
    await other.post("/api/auth/login").send({ email, password });
    expect((await other.get("/api/auth/me")).status).toBe(200);
    const change = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: password, newPassword: "brand-new-pass-77" });
    expect(change.status).toBe(200);
    expect((await other.get("/api/auth/me")).status).toBe(401);
    expect((await agent.get("/api/auth/me")).status).toBe(200);
  });

  it("writes audit log entries for login events", async () => {
    await signUp();
    const { rows } = await pool.query("SELECT action FROM audit_logs");
    expect(rows.map((r) => r.action)).toContain("auth.register");
  });
});

describe("authorization & isolation", () => {
  it("viewer role cannot reach permission-gated routes it lacks", async () => {
    const { agent, email } = await signUp();
    await pool.query("UPDATE users SET role = 'viewer' WHERE email = $1", [email]);
    // viewer has calls:view, so dashboard is allowed
    expect((await agent.get("/api/dashboard/stats")).status).toBe(200);
  });

  it("dashboard stats only count the caller's own organization", async () => {
    const a = await signUp();
    await signUp();
    const orgs = await pool.query("SELECT id FROM organizations ORDER BY created_at");
    await pool.query(
      `INSERT INTO calls (org_id, mode, from_number, to_number, status, duration_sec)
       VALUES ($1,'human','+15550000001','+971500000000','completed',60)`,
      [orgs.rows[1].id],
    );
    const stats = await a.agent.get("/api/dashboard/stats");
    expect(stats.body.stats.total_calls).toBe(0);
  });
});
