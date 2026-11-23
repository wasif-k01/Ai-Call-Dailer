import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import request from "supertest";
import { app, resetDb, signUp } from "./helpers.js";
import { pool } from "../src/db/pool.js";
import { closeRedis, redis } from "../src/lib/redis.js";
import { attachWebSockets } from "../src/realtime/ws-server.js";
import { publishEvent } from "../src/realtime/events.js";
import { runMigrations } from "../src/db/migrate.js";

let server: http.Server;
let ws: ReturnType<typeof attachWebSockets>;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  ws = attachWebSockets(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(resetDb);
afterAll(async () => {
  await ws.close();
  server.close();
  await closeRedis();
  await pool.end();
});

function connect(path: string) {
  return new Promise<{ socket: WebSocket; messages: unknown[] }>((resolve, reject) => {
    const socket = new WebSocket(base + path);
    const messages: unknown[] = [];
    socket.on("message", (m) => messages.push(JSON.parse(m.toString())));
    socket.on("open", () => setTimeout(() => resolve({ socket, messages }), 50));
    socket.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    socket.on("error", reject);
  });
}

async function ticketFor(agent: Awaited<ReturnType<typeof signUp>>["agent"]) {
  const res = await agent.post("/api/realtime/ticket");
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/^wss?:\/\/.+\/ws\/events$/);
  return res.body.ticket as string;
}

const waitFor = async (fn: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("realtime websocket", () => {
  it("requires a session to issue a ticket", async () => {
    expect((await request(app).post("/api/realtime/ticket")).status).toBe(401);
  });

  it("rejects connections without a valid ticket", async () => {
    await expect(connect("/ws/events?ticket=forged")).rejects.toThrow("401");
    await expect(connect("/ws/events")).rejects.toThrow("401");
  });

  it("returns 404 for unknown websocket paths", async () => {
    await expect(connect("/nope")).rejects.toThrow("404");
  });

  it("delivers events only to clients of the same organization", async () => {
    const a = await signUp();
    const b = await signUp();
    const ca = await connect(`/ws/events?ticket=${await ticketFor(a.agent)}`);
    const cb = await connect(`/ws/events?ticket=${await ticketFor(b.agent)}`);
    const orgA = (await a.agent.get("/api/auth/me")).body.organization.id;

    await publishEvent({ orgId: orgA, type: "call.updated", data: { callId: "c1", status: "ringing" } });
    await waitFor(() => ca.messages.length >= 2);
    expect(ca.messages[1]).toMatchObject({ type: "call.updated", data: { callId: "c1" } });
    expect(JSON.stringify(ca.messages[1])).not.toContain(orgA); // orgId is stripped
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.messages).toHaveLength(1); // only the "connected" greeting
    ca.socket.close();
    cb.socket.close();
  });
});

describe("health & migrations", () => {
  it("reports db, redis and worker status", async () => {
    await redis().del("acp:worker:heartbeat");
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ db: "ok", redis: "ok", worker: "no_heartbeat" });
  });

  it("migrations are idempotent and safe to run concurrently", async () => {
    await Promise.all([runMigrations(() => {}), runMigrations(() => {}), runMigrations(() => {})]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
