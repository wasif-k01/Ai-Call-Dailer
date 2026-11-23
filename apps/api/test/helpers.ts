import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

export const app = createApp();

export async function resetDb() {
  await runMigrations(() => {});
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations','roles')`,
  );
  await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

let counter = 0;
/** Registers a fresh org owner and returns a supertest agent carrying the session cookie. */
export async function signUp(overrides: Partial<{ email: string; password: string }> = {}) {
  const agent = request.agent(app);
  const email = overrides.email ?? `owner${++counter}@example.com`;
  const password = overrides.password ?? "correct-horse-42";
  const res = await agent
    .post("/api/auth/register")
    .send({ fullName: "Test Owner", email, password, organizationName: "Test Org" });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, password };
}
