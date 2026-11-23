import { Queue } from "bullmq";
import { createRedis } from "../lib/redis.js";

/** Queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  campaignCalls: "campaign-calls",
  maintenance: "maintenance",
} as const;

let maintenanceQueue: Queue | null = null;
export function getMaintenanceQueue() {
  maintenanceQueue ??= new Queue(QUEUES.maintenance, { connection: createRedis("queue-maintenance") });
  return maintenanceQueue;
}

/** Redis key the worker refreshes every 20s (60s TTL); the API health check reads it. */
export const WORKER_HEARTBEAT_KEY = "acp:worker:heartbeat";
