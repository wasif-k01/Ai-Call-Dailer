"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Download, X } from "lucide-react";
import { api, formatDuration, formatUsd } from "@/lib/api";
import { Alert, Badge, Spinner } from "@/components/ui";

export interface CallRow {
  id: string;
  mode: "human" | "ai";
  status: string;
  from_number: string;
  to_number: string;
  to_country_iso: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  error_message: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  ai_cost_usd?: number | null;
  agent_name: string | null;
  campaign_name: string | null;
  user_name: string | null;
  recording_count: number;
  transcript_count: number;
  on_hold?: boolean | null;
  agent_muted?: boolean | null;
}

export const CALL_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }> = {
  initiated: { label: "Starting", tone: "info" },
  queued: { label: "Connecting", tone: "info" },
  ringing: { label: "Ringing", tone: "info" },
  in_progress: { label: "In progress", tone: "success" },
  completed: { label: "Completed", tone: "neutral" },
  busy: { label: "Busy", tone: "warning" },
  no_answer: { label: "No answer", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = CALL_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

interface Detail {
  call: CallRow & { ai_usage: Record<string, number> | null };
  events: { event_type: string; payload: Record<string, unknown>; created_at: string }[];
  transcript: { speaker: string; text: string; created_at: string }[];
  recordings: { id: string; duration_sec: number | null; channels: number | null; created_at: string }[];
}

const EVENT_LABEL: Record<string, string> = {
  "call.prepared": "Call prepared",
  "participant.created": "Dialling the recipient",
  "twilio.status": "Twilio status",
  "twilio.client_status": "Browser leg ended",
  "ai.stream_started": "AI connected to the call",
  "ai.tool_call": "AI action",
  "ai.hangup": "Call ended by AI / limit",
  "ai.interrupted": "Caller interrupted the AI",
  "ai.error": "AI error",
  "call.hold": "Put on hold",
  "call.unhold": "Taken off hold",
  "call.dtmf": "Keypad digits sent",
  "recording.completed": "Recording saved",
  "recording.failed": "Recording failed",
};

function describe(e: Detail["events"][number]) {
  const p = e.payload ?? {};
  if (e.event_type === "twilio.status" || e.event_type === "twilio.client_status") return String(p.CallStatus ?? "");
  if (e.event_type === "ai.tool_call") return String(p.name ?? "").replace("add_to_do_not_call", "added to Do Not Call").replace("end_call", "ended the call");
  if (e.event_type === "ai.hangup") return String(p.reason ?? "");
  if (e.event_type === "ai.interrupted") return `after ${p.heardMs} ms of speech`;
  if (e.event_type === "ai.error") return String(p.message ?? "");
  return "";
}

export function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/calls/${callId}/detail`).then(setD).catch((e) => setError(e.message));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callId, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Call details">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-semibold">Call details</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:text-text" aria-label="Close"><X className="size-5" /></button>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {error && <Alert>{error}</Alert>}
          {!d && !error && <Spinner />}
          {d && (
            <>
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-lg">{d.call.to_number}</span>
                  <StatusBadge status={d.call.status} />
                </div>
                <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
                  <dt className="text-muted">Call ID</dt><dd className="break-all font-mono text-xs">{d.call.id}</dd>
                  <dt className="text-muted">Mode</dt><dd>{d.call.mode === "ai" ? `AI-to-Human${d.call.agent_name ? ` · ${d.call.agent_name}` : ""}` : `Human-to-Human${d.call.user_name ? ` · ${d.call.user_name}` : ""}`}</dd>
                  {d.call.campaign_name && (<><dt className="text-muted">Campaign</dt><dd>{d.call.campaign_name}</dd></>)}
                  <dt className="text-muted">From</dt><dd className="font-mono">{d.call.from_number}</dd>
                  <dt className="text-muted">Started</dt><dd>{new Date(d.call.started_at).toLocaleString()}</dd>
                  <dt className="text-muted">Ended</dt><dd>{d.call.ended_at ? new Date(d.call.ended_at).toLocaleString() : "—"}</dd>
                  <dt className="text-muted">Duration</dt><dd>{d.call.duration_sec != null ? formatDuration(d.call.duration_sec) : "—"}</dd>
                  <dt className="text-muted">Estimated cost</dt>
                  <dd>
                    {d.call.estimated_cost_usd != null ? formatUsd(d.call.estimated_cost_usd) : "Not calculated yet"}
                    <span className="block text-xs text-muted">
                      Twilio: {d.call.actual_cost_usd != null ? `${formatUsd(d.call.actual_cost_usd)} billed` : "waiting for Twilio's price"}
                      {d.call.mode === "ai" && d.call.ai_cost_usd != null ? ` · OpenAI: ${formatUsd(d.call.ai_cost_usd)} estimated` : ""}
                    </span>
                  </dd>
                  {d.call.ai_usage && (<><dt className="text-muted">AI usage</dt><dd className="text-xs">{d.call.ai_usage.input_audio_tokens ?? 0} audio tokens in · {d.call.ai_usage.output_audio_tokens ?? 0} out</dd></>)}
                </dl>
                {d.call.error_message && <div className="mt-3"><Alert>{d.call.error_message}</Alert></div>}
              </section>

              {d.recordings.length > 0 && (
                <section>
                  <h3 className="mb-2 font-medium">Recording</h3>
                  {d.recordings.map((r) => (
                    <div key={r.id} className="space-y-1">
                      <audio controls preload="none" src={`/api/recordings/${r.id}/audio`} className="w-full" />
                      <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`/api/recordings/${r.id}/audio?download=1`}><Download className="size-3" /> Download</a>
                    </div>
                  ))}
                </section>
              )}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-medium">Transcript</h3>
                  {d.transcript.length > 0 && <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`/api/transcripts/${d.call.id}.txt`}><Download className="size-3" /> Download .txt</a>}
                </div>
                {d.transcript.length === 0 ? (
                  <p className="text-sm text-muted">{d.call.mode === "human" ? "Human calls aren't transcribed." : "No transcript for this call."}</p>
                ) : (
                  <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm">
                    {d.transcript.map((t, i) => (
                      <div key={i} className={clsx("flex", t.speaker === "ai" ? "justify-start" : "justify-end")}>
                        <div className={clsx("max-w-[85%] rounded-lg px-3 py-1.5", t.speaker === "ai" ? "bg-primary/15" : "bg-surface")}>
                          <span className="mr-1 text-xs font-medium text-muted">{t.speaker === "ai" ? "AI" : "Them"}:</span>{t.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {d.events.length > 0 && (
                <section>
                  <h3 className="mb-2 font-medium">Timeline</h3>
                  <ol className="space-y-1 border-l border-border pl-4 text-sm">
                    {d.events.map((e, i) => (
                      <li key={i}>
                        <span className="text-xs text-muted">{new Date(e.created_at).toLocaleTimeString()}</span>{" "}
                        {EVENT_LABEL[e.event_type] ?? e.event_type} <span className="text-muted">{describe(e)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
