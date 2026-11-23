"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { FileText, Search } from "lucide-react";
import { api, formatDuration } from "@/lib/api";
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { CallDetailDrawer } from "@/components/calls/call-detail";

interface Row {
  id: string;
  to_number: string;
  started_at: string;
  duration_sec: number | null;
  agent_name: string | null;
  segments: number;
  snippet: string | null;
}

export default function TranscriptsPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ calls: Row[] }>(`/transcripts?q=${encodeURIComponent(q)}&page=${page}`).then((r) => setRows(r.calls)).catch((e) => setError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [q, page]);

  return (
    <>
      <PageHeader title="Transcripts" description="What was said on AI calls, word for word. Search for any word or phrase." />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
        <input
          aria-label="Search transcripts"
          value={q}
          onChange={(e) => (setQ(e.target.value), setPage(1))}
          placeholder="e.g. reschedule, price, not interested"
          className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      {error && <Alert>{error}</Alert>}
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState icon={<FileText className="size-8" />} title={q ? "No transcripts mention that" : "No transcripts yet"} description="AI calls are transcribed automatically. Human calls aren't transcribed." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setViewing(r.id)} className="block w-full text-left">
              <Card className={clsx("transition hover:border-primary/50")}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-mono">{r.to_number}</span>
                  <span className="text-muted">{new Date(r.started_at).toLocaleString()} · {r.agent_name ?? "AI"} · {formatDuration(r.duration_sec)} · {r.segments} lines</span>
                </div>
                {r.snippet && <p className="mt-1 line-clamp-2 text-sm text-muted">“{r.snippet}”</p>}
              </Card>
            </button>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button variant="secondary" disabled={rows.length < 25} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}
      {viewing && <CallDetailDrawer callId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
