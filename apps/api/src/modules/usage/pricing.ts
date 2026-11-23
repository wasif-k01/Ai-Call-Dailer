import { query } from "../../db/pool.js";

/**
 * OpenAI list prices in USD per 1M tokens, copied from OpenAI's pricing page
 * (https://developers.openai.com/api/docs/pricing, checked 2026-11-24).
 * They are only used for ESTIMATES. The owner can override any of them on the Usage page.
 */
export const PRICE_SOURCE = { url: "https://developers.openai.com/api/docs/pricing", checked: "2026-11-24" };

export const DEFAULT_PRICES: Record<string, { usd: number; label: string }> = {
  "gpt-realtime-2.1:input_audio_tokens": { usd: 32, label: "gpt-realtime-2.1 audio input" },
  "gpt-realtime-2.1:output_audio_tokens": { usd: 64, label: "gpt-realtime-2.1 audio output" },
  "gpt-realtime-2.1:input_text_tokens": { usd: 4, label: "gpt-realtime-2.1 text input" },
  "gpt-realtime-2.1:output_text_tokens": { usd: 24, label: "gpt-realtime-2.1 text output" },
  "gpt-realtime-2.1:cached_tokens": { usd: 0.4, label: "gpt-realtime-2.1 cached input" },
  "gpt-realtime-2.1-mini:input_audio_tokens": { usd: 10, label: "gpt-realtime-2.1-mini audio input" },
  "gpt-realtime-2.1-mini:output_audio_tokens": { usd: 20, label: "gpt-realtime-2.1-mini audio output" },
  "gpt-realtime-2.1-mini:input_text_tokens": { usd: 0.6, label: "gpt-realtime-2.1-mini text input" },
  "gpt-realtime-2.1-mini:output_text_tokens": { usd: 2.4, label: "gpt-realtime-2.1-mini text output" },
  "gpt-realtime-2.1-mini:cached_tokens": { usd: 0.3, label: "gpt-realtime-2.1-mini cached input (audio rate)" },
  "gpt-4o-mini-transcribe:transcribe_input_tokens": { usd: 1.25, label: "gpt-4o-mini-transcribe audio input" },
  "gpt-4o-mini-transcribe:transcribe_output_tokens": { usd: 5, label: "gpt-4o-mini-transcribe output" },
};

export async function pricesFor(orgId: string) {
  const { rows } = await query("SELECT key, usd_per_unit::float AS usd FROM pricing_overrides WHERE org_id = $1", [orgId]);
  const overrides = new Map(rows.map((r) => [r.key, r.usd as number]));
  return Object.fromEntries(
    Object.entries(DEFAULT_PRICES).map(([key, d]) => [key, { ...d, default: d.usd, usd: overrides.get(key) ?? d.usd, overridden: overrides.has(key) }]),
  );
}

/**
 * Estimated OpenAI cost of one call. Cached tokens are billed at the cached rate, so they're
 * removed from the full-price input before applying the cached price.
 */
export function estimateAiCost(
  prices: Record<string, { usd: number }>,
  model: string,
  usage: Record<string, number>,
  transcribeModel?: string,
) {
  const p = (k: string) => prices[`${model}:${k}`]?.usd;
  if (p("input_audio_tokens") === undefined) return null; // unknown model: no guess
  const cached = usage.cached_tokens ?? 0;
  const inAudio = Math.max(0, (usage.input_audio_tokens ?? 0) - cached);
  let usd =
    inAudio * p("input_audio_tokens")! +
    (usage.output_audio_tokens ?? 0) * p("output_audio_tokens")! +
    (usage.input_text_tokens ?? 0) * (p("input_text_tokens") ?? 0) +
    (usage.output_text_tokens ?? 0) * (p("output_text_tokens") ?? 0) +
    cached * (p("cached_tokens") ?? 0);
  if (transcribeModel) {
    const t = (k: string) => prices[`${transcribeModel}:${k}`]?.usd ?? 0;
    usd += (usage.transcribe_input_tokens ?? 0) * t("transcribe_input_tokens") + (usage.transcribe_output_tokens ?? 0) * t("transcribe_output_tokens");
  }
  return usd / 1_000_000;
}
