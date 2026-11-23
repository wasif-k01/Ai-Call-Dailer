/**
 * OpenAI connectivity checks. Uses plain HTTPS so it is trivial to mock in tests.
 * Docs (checked 2026-11-23): GET /v1/models/{model}, Authorization: Bearer, optional OpenAI-Project header.
 */
export const REALTIME_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;

export interface OpenAITestResult {
  ok: boolean;
  message: string;
  availableRealtimeModels?: string[];
}

function headers(apiKey: string, projectId?: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(projectId ? { "OpenAI-Project": projectId } : {}),
  };
}

/** Turns OpenAI HTTP errors into messages a non-technical person can act on. */
function explain(status: number, body: any, model: string): string {
  const code = body?.error?.code ?? "";
  if (status === 401) return "OpenAI rejected the API key. Check it was copied completely, or create a new key at platform.openai.com → API keys.";
  if (status === 403) return "This API key isn't allowed to use that project or model. Check the key's project permissions in OpenAI.";
  if (status === 404) return `Your OpenAI account doesn't have access to the model "${model}". Choose another model, or check your account's model access.`;
  if (status === 429 && code === "insufficient_quota") return "Your OpenAI account has no credit left. Add billing at platform.openai.com → Settings → Billing.";
  if (status === 429) return "OpenAI is rate-limiting requests right now. Wait a minute and test again.";
  if (status >= 500) return "OpenAI is having problems right now. Try again in a few minutes.";
  return `OpenAI returned an unexpected error (HTTP ${status}).`;
}

export async function testOpenAI(apiKey: string, model: string, projectId?: string): Promise<OpenAITestResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: headers(apiKey, projectId),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, message: "Couldn't reach OpenAI. Check the server's internet connection." };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, message: explain(res.status, body, model) };
  }
  // Best effort: list which realtime models this key can use, to help choose one.
  let availableRealtimeModels: string[] | undefined;
  try {
    const list = await fetch("https://api.openai.com/v1/models", { headers: headers(apiKey, projectId), signal: AbortSignal.timeout(15_000) });
    if (list.ok) {
      const data = (await list.json()) as { data?: { id: string }[] };
      availableRealtimeModels = (data.data ?? []).map((m) => m.id).filter((id) => /realtime|^gpt-live/.test(id)).sort();
    }
  } catch {
    /* optional */
  }
  return { ok: true, message: `Connected. The key can use ${model}.`, availableRealtimeModels };
}
