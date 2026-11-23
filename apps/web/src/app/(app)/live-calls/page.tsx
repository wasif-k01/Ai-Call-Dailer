"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Eye, Mic, MicOff, Pause, Play, PhoneOff } from "lucide-react";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";
import { CallDetailDrawer, StatusBadge, type CallRow } from "@/components/calls/call-detail";

function since(iso: string | null, now: number) {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function LiveCallsPage() {
  const session = useSession();
  const control = can(session, "calls:make");
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api<{ calls: CallRow[] }>("/calls/live").then((r) => setCalls(r.calls)).catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, []);
  useEffect(load, [load]);
  const { connected } = useRealtime((e) => {
    if (e.type === "call.updated" || e.type === "campaign.progress") load();
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(load, connected ? 15_000 : 3_000);
    return () => (clearInterval(t), clearInterval(p));
  }, [connected, load]);

  async function act(key: string, path: string, json?: unknown) {
    setBusy(key);
    setMsg(null);
    try {
      await api(path, { method: "POST", json });
      load();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Live Calls" description={`Calls happening right now. ${connected ? "Updates live." : "Refreshing every few seconds."}`} />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!calls ? (
        <Spinner />
      ) : calls.length === 0 ? (
        <EmptyState icon={<Activity className="size-8" />} title="No calls in progress" description="Calls from the Dialer, AI Calling and campaigns appear here while they're active." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Call</th>
                <th className="px-2 py-3 font-medium">Caller → Recipient</th>
                <th className="px-2 py-3 font-medium">Mode</th>
                <th className="px-2 py-3 font-medium">Started</th>
                <th className="px-2 py-3 font-medium">Duration</th>
                <th className="px-2 py-3 font-medium">Status</th>
                <th className="px-2 py-3 font-medium">Controls</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const answered = c.status === "in_progress";
                return (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-mono text-xs" title={c.id}>{c.id.slice(0, 8)}</td>
                    <td className="px-2 py-2 font-mono">{c.from_number} → {c.to_number}</td>
                    <td className="px-2 py-2">{c.mode === "ai" ? `AI · ${c.agent_name ?? "agent"}` : `Human · ${c.user_name ?? ""}`}{c.campaign_name && <div className="text-xs text-muted">{c.campaign_name}</div>}</td>
                    <td className="px-2 py-2 text-muted">{new Date(c.started_at).toLocaleTimeString()}</td>
                    <td className="px-2 py-2 font-mono tabular-nums">{since(c.answered_at, now)}</td>
                    <td className="px-2 py-2"><StatusBadge status={c.status} />{c.on_hold && <span className="ml-1 text-xs text-warning">on hold</span>}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <div className="flex items-center gap-1">
                        {control && (
                          <Button variant="danger" className="px-2.5 py-1.5" onClick={() => act(`end-${c.id}`, `/calls/${c.id}/hangup`)} loading={busy === `end-${c.id}`} title="End call">
                            <PhoneOff className="size-4" />
                          </Button>
                        )}
                        {control && c.mode === "human" && (
                          <>
                            <Button variant="ghost" className="px-2" disabled={!answered} onClick={() => act(`mute-${c.id}`, `/calls/${c.id}/mute`, { muted: !c.agent_muted })} loading={busy === `mute-${c.id}`} title={c.agent_muted ? "Unmute the caller's microphone" : "Mute the caller's microphone"}>
                              {c.agent_muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                            </Button>
                            <Button variant="ghost" className="px-2" disabled={!answered} onClick={() => act(`hold-${c.id}`, `/calls/${c.id}/hold`, { hold: !c.on_hold })} loading={busy === `hold-${c.id}`} title={c.on_hold ? "Resume" : "Hold"}>
                              {c.on_hold ? <Play className="size-4" /> : <Pause className="size-4" />}
                            </Button>
                          </>
                        )}
                        <Button variant="ghost" className="px-2" onClick={() => setViewing(c.id)} title={c.mode === "ai" ? "View transcript" : "View details"}><Eye className="size-4" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <Card className="mt-6 text-sm text-muted">
        <h3 className="mb-1 font-medium text-text">Which controls are available</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>End call</strong>: works for every call.</li>
          <li><strong>Mute</strong> and <strong>Hold</strong>: human calls only. AI calls are run entirely by the server, so there&apos;s no microphone to mute and nothing to hold.</li>
          <li><strong>Transfer</strong> isn&apos;t available yet. Transferring needs a destination number or agent to send the call to, which this platform doesn&apos;t have. It will only be added once there&apos;s somewhere real to transfer to.</li>
        </ul>
      </Card>
      {viewing && <CallDetailDrawer callId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
