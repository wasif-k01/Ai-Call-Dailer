import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { pool } from "./db/pool.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import authRoutes from "./modules/auth/routes.js";
import dashboardRoutes from "./modules/dashboard/routes.js";
import realtimeRoutes from "./realtime/routes.js";
import { redis, redisHealthy } from "./lib/redis.js";
import { WORKER_HEARTBEAT_KEY } from "./queues/index.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN.split(",").map((s) => s.trim()), credentials: true }));
  app.use(cookieParser());
  // Twilio webhooks post urlencoded bodies; the dashboard sends JSON.
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  if (env.NODE_ENV !== "test") app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  // Liveness/readiness for Railway. Fails (503) only when the database is unreachable,
  // so a Redis or worker hiccup is reported without taking the API offline.
  app.get("/health", async (_req, res) => {
    const db = await pool.query("SELECT 1").then(() => "ok", () => "error");
    const redisOk = await redisHealthy();
    const lastBeat = redisOk ? await redis().get(WORKER_HEARTBEAT_KEY).catch(() => null) : null;
    res.status(db === "ok" ? 200 : 503).json({
      status: db === "ok" && redisOk ? "ok" : "degraded",
      db,
      redis: redisOk ? "ok" : "error",
      worker: lastBeat ? "ok" : "no_heartbeat",
      workerLastSeen: lastBeat,
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    });
  });

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: env.NODE_ENV === "test" ? 10_000 : 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  api.use("/auth", authRoutes);
  api.use("/dashboard", dashboardRoutes);
  api.use("/realtime", realtimeRoutes);
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
