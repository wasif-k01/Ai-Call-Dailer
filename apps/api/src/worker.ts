import { Worker, type Job } from "bullmq";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { closeRedis, createRedis, redis } from "./lib/redis.js";
import { pool } from "./db/pool.js";
import { QUEUES, WORKER_HEARTBEAT_KEY as HEARTBEAT_KEY } from "./queues/index.js";
import { Queue } from "bullmq";
import { dialCampaignContact, runCampaignTick } from "./modules/campaigns/engine.js";

/**
 * Background worker process (Railway service "worker").
 * Runs separately from the API so long-running campaign work never blocks HTTP or call audio.
 */

let dialQueue: Queue | null = null;
const enqueueDial = async (campaignContactId: string, attempt: number) => {
  dialQueue ??= new Queue(QUEUES.campaignCalls, { connection: createRedis("queue-dial") });
  // jobId makes enqueueing idempotent per contact attempt.
  await dialQueue.add("dial", { campaignContactId }, { jobId: `cc-${campaignContactId}-${attempt}`, removeOnComplete: 1000, removeOnFail: 1000 });
};

async function processCampaignCall(job: Job<{ campaignContactId: string }>) {
  return dialCampaignContact(job.data.campaignContactId);
}

async function processMaintenance(job: Job) {
  if (job.name === "ping") return { ok: true, at: new Date().toISOString() };
  if (job.name === "campaign-tick") return runCampaignTick(enqueueDial);
  throw new Error(`unknown maintenance job: ${job.name}`);
}

async function main() {
  await pool.query("SELECT 1");
  const workers = [
    new Worker(QUEUES.campaignCalls, processCampaignCall, {
      connection: createRedis("worker-campaign"),
      concurrency: 5, // upper bound per worker; per-campaign limits are enforced in Phase 6
    }),
    new Worker(QUEUES.maintenance, processMaintenance, { connection: createRedis("worker-maintenance"), concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on("failed", (job, err) => logger.warn({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"));
    w.on("error", (err) => logger.error({ queue: w.name, err: err.message }, "worker error"));
  }

  // Campaign scheduler: one tick every 5 seconds across all workers (BullMQ job scheduler).
  const maintenance = new Queue(QUEUES.maintenance, { connection: createRedis("queue-scheduler") });
  await maintenance.upsertJobScheduler("campaign-tick", { every: 5000 }, { name: "campaign-tick", opts: { removeOnComplete: true, removeOnFail: 100 } });

  // The API's /health reports whether a worker has checked in recently.
  const beat = () => redis().set(HEARTBEAT_KEY, new Date().toISOString(), "EX", 60).catch(() => {});
  await beat();
  const heartbeat = setInterval(beat, 20_000);
  logger.info({ queues: Object.values(QUEUES), env: env.NODE_ENV }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, draining worker`);
    clearInterval(heartbeat);
    await Promise.all(workers.map((w) => w.close())); // waits for in-flight jobs
    await maintenance.close();
    await dialQueue?.close();
    await closeRedis();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});


