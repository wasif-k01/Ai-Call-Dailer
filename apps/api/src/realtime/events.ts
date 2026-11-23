import { redis } from "../lib/redis.js";

/** Channel all API replicas and workers share, so an event published anywhere reaches every browser. */
export const EVENTS_CHANNEL = "acp:events";

export interface RealtimeEvent {
  orgId: string;
  type: string; // e.g. call.updated, campaign.progress, transcript.segment
  data: Record<string, unknown>;
}

export async function publishEvent(event: RealtimeEvent) {
  await redis().publish(EVENTS_CHANNEL, JSON.stringify({ ...event, at: new Date().toISOString() }));
}
