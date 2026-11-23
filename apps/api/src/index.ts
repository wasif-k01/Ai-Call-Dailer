import http from "node:http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { closeRedis } from "./lib/redis.js";
import { createApp } from "./app.js";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { attachWebSockets } from "./realtime/ws-server.js";
import { activeBridges } from "./modules/ai/bridge.js";

async function main() {
  if (env.RUN_MIGRATIONS_ON_START) await runMigrations((m) => logger.info(m));
  const server = http.createServer(createApp());
  // Keep-alive longer than common proxy idle timeouts to avoid spurious 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const ws = attachWebSockets(server);
  // Railway injects PORT; bind on all interfaces (incl. IPv6 for private networking).
  server.listen(env.PORT, "::", () => logger.info(`API listening on :${env.PORT}`));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    server.close(); // stop accepting new connections; in-flight requests finish
    // Let live AI calls finish (Railway keeps the old instance for drainingSeconds).
    const drainUntil = Date.now() + Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 0) * 1000 - 10_000;
    while (activeBridges.size > 0 && Date.now() < drainUntil) {
      logger.info(`waiting for ${activeBridges.size} active AI call(s) to finish`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    for (const b of activeBridges) await b.finish("server shutdown");
    await ws.close();
    await closeRedis();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
