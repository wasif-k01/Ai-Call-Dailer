import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { createRedis } from "../lib/redis.js";
import { loadUserFromTicket } from "./tickets.js";
import { EVENTS_CHANNEL } from "./events.js";
import { handleMediaStreamUpgrade, MEDIA_STREAM_PREFIX } from "../modules/ai/bridge.js";

interface Client extends WebSocket {
  orgId: string;
  isAlive: boolean;
}

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

/**
 * Single upgrade router for every WebSocket endpoint on the API:
 *   /ws/events            dashboard live updates (ticket-authenticated)
 *   /twilio/media-stream/<callId>   Twilio Media Streams audio for AI calls (Twilio-signed)
 */
export function attachWebSockets(server: Server) {
  const routes = new Map<string, UpgradeHandler>();
  const events = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<Client>();

  routes.set("/ws/events", async (req, socket, head, url) => {
    const user = await loadUserFromTicket(url.searchParams.get("ticket") ?? "");
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    events.handleUpgrade(req, socket, head, (ws) => {
      const client = ws as Client;
      client.orgId = user.orgId;
      client.isAlive = true;
      clients.add(client);
      client.on("pong", () => (client.isAlive = true));
      client.on("close", () => clients.delete(client));
      client.on("error", () => clients.delete(client));
      client.send(JSON.stringify({ type: "connected", data: {} }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://internal");
    const handler = url.pathname.startsWith(MEDIA_STREAM_PREFIX)
      ? (r: IncomingMessage, s: Duplex, h: Buffer) => handleMediaStreamUpgrade(r, s, h)
      : routes.get(url.pathname);
    if (!handler) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    Promise.resolve(handler(req, socket, head, url)).catch((err) => {
      logger.error({ err }, "websocket upgrade failed");
      socket.destroy();
    });
  });

  // Fan out events from Redis (published by any API replica or worker) to this replica's clients.
  const sub = createRedis("events-sub");
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on("message", (_channel, raw) => {
    let evt: { orgId?: string };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const { orgId, ...payload } = evt as { orgId: string };
    const msg = JSON.stringify(payload);
    for (const c of clients) if (c.orgId === orgId && c.readyState === c.OPEN) c.send(msg);
  });

  // Heartbeat keeps idle connections alive through proxies and reaps dead ones.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.isAlive) {
        c.terminate();
        clients.delete(c);
        continue;
      }
      c.isAlive = false;
      c.ping();
    }
  }, 25_000);

  return {
    routes,
    clientCount: () => clients.size,
    async close() {
      clearInterval(heartbeat);
      // 1012 = service restart: browsers reconnect to the new deployment.
      for (const c of clients) c.close(1012, "server restarting");
      await sub.quit().catch(() => {});
    },
  };
}

export function wsPublicUrl(path: string) {
  return env.PUBLIC_API_URL.replace(/^http/, "ws").replace(/\/$/, "") + path;
}


