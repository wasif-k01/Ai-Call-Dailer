"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Download, Mic, Trash2 } from "lucide-react";
import { api, formatDuration } from "@/lib/api";
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";
import { CallDetailDrawer } from "@/components/calls/call-detail";

interface Rec {
  id: string;
  duration_sec: number | null;
  created_at: string;
  call_id: string;
  mode: string;
  to_number: string;
  from_number: string;
  agent_name: string | null;
}

export default function RecordingsPage() {
  const session = useSession();
  const canDelete = can(session, "campaigns:manage");
  const [data, setData] = useState<{ recordings: Rec[]; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ recordings: Rec[]; total: number }>(`/recordings?page=${page}`).then(setData).catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, [page]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ settings: { recording_enabled: boolean } }>("/settings/calling").then((r) => setEnabled(r.settings.recording_enabled)).catch(() => {});
  }, []);

  async function remove(r: Rec) {
    setConfirm(null);
    try {
      await api(`/recordings/${r.id}`, { method: "DELETE" });
      setMsg({ tone: "success", text: "Recording deleted from Twilio and from this app." });
      load();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }

  return (
    <>
      <PageHeader title="Recordings" description="Recordings stay in your Twilio account and are only played through this app after you sign in; there are no public links." />
      {enabled === false && (
        <div className="mb-4"><Alert tone="info">Call recording is <strong>off</strong>. The owner can switch it on in <Link className="underline" href="/settings">Account Settings → Calling</Link>. Check the recording consent rules for the countries you call first.</Alert></div>
      )}
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!data ? (
        <Spinner />
      ) : data.recordings.length === 0 ? (
        <EmptyState icon={<Mic className="size-8" />} title="No recordings yet" description="Calls made while recording is switched on will appear here once they end." />
      ) : (
        <div className="space-y-3">
          {data.recordings.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center gap-4">
              <div className="min-w-48">
                <button className="font-mono hover:underline" onClick={() => setViewing(r.call_id)}>{r.to_number}</button>
                <div className="text-xs text-muted">{new Date(r.created_at).toLocaleString()} · {r.mode === "ai" ? `AI · ${r.agent_name ?? ""}` : "Human"} · {formatDuration(r.duration_sec)}</div>
              </div>
              <audio controls preload="none" src={`/api/recordings/${r.id}/audio`} className="min-w-64 flex-1" />
              <a href={`/api/recordings/${r.id}/audio?download=1`} title="Download"><Button variant="ghost" className="px-2"><Download className="size-4" /></Button></a>
              {canDelete && (confirm === r.id ? (
                <span className="flex gap-1"><Button variant="danger" onClick={() => remove(r)}>Delete</Button><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></span>
              ) : (
                <Button variant="ghost" className="px-2" onClick={() => setConfirm(r.id)} aria-label="Delete recording"><Trash2 className="size-4" /></Button>
              ))}
            </Card>
          ))}
          {data.total > 25 && (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button variant="secondary" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}
      {viewing && <CallDetailDrawer callId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
