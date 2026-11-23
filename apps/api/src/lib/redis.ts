import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Creates a Redis connection. BullMQ workers and pub/sub subscribers need
 * maxRetriesPerRequest: null, so every connection uses it for consistency.
 * `family: 0` lets ioredis resolve both IPv4 and IPv6 (Railway private networking is IPv6).
 */
export function createRedis(name: string, extra: RedisOptions = {}) {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    family: 0,
    lazyConnect: false,
    connectionName: `acp:${name}`,
    ...extra,
  });
  client.on("error", (err) => logger.warn({ err: err.message, conn: name }, "redis connection error"));
  return client;
}

let shared: Redis | null = null;
export function redis() {
  shared ??= createRedis("shared");
  return shared;
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await redis().ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis() {
  await shared?.quit().catch(() => {});
  shared = null;
}
