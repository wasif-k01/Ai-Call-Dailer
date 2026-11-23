"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText, History, Mic, Search } from "lucide-react";
import clsx from "clsx";
import { api, formatDuration } from "@/lib/api";
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { CallDetailDrawer, CALL_STATUS, StatusBadge, type CallRow } from "@/components/calls/call-detail";

const fieldCls = "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export default function CallHistoryPage() {
  const [filters, setFilters] = useState({ q: "", mode: "all", status: "all", agentId: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ calls: CallRow[]; total: number } | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && v !== "all" && p.set(k, v));
    return p;
  }, [filters]);

  const load = useCallback(() => {
    const p = new URLSearchParams(qs);
    p.set("page", String(page));
    api<{ calls: CallRow[]; total: number }>(`/calls?${p}`).then(setData).catch((e) => setError(e.message));
  }, [qs, page]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    api<{ agents: { id: string; name: string }[] }>("/agents").then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  const set = (k: keyof typeof filters, v: string) => (setFilters((f) => ({ ...f, [k]: v })), setPage(1));

  return (
    <>
      <PageHeader
        title="Call History"
        description="Every call made from this workspace."
        actions={<a href={`/api/calls/export.csv?${qs}`}><Button variant="secondary"><Download className="size-4" /> Export CSV</Button></a>}
      />
      <Card className="mb-4 flex flex-wrap items-end gap-2 p-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
          <input aria-label="Search by number" value={filters.q} onChange={(e) => set("q", e.target.value)} placeholder="Search number" className={clsx(fieldCls, "w-full pl-9")} />
        </div>
        <select aria-label="Mode" value={filters.mode} onChange={(e) => set("mode", e.target.value)} className={fieldCls}>
          <option value="all">All modes</option><option value="human">Human</option><option value="ai">AI</option>
        </select>
        <select aria-label="Status" value={filters.status} onChange={(e) => set("status", e.target.value)} className={fieldCls}>
          <option value="all">All statuses</option>
          {Object.entries(CALL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select aria-label="AI agent" value={filters.agentId} onChange={(e) => set("agentId", e.target.value)} className={fieldCls}>
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="text-xs text-muted">From<input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} className={clsx(fieldCls, "block")} /></label>
        <label className="text-xs text-muted">To<input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} className={clsx(fieldCls, "block")} /></label>
      </Card>
      {error && <Alert>{error}</Alert>}
      {!data ? (
        <Spinner />
      ) : data.calls.length === 0 ? (
        <EmptyState icon={<History className="size-8" />} title="No calls found" description="Try different filters." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-2 py-3 font-medium">To</th>
                <th className="px-2 py-3 font-medium">From</th>
                <th className="px-2 py-3 font-medium">Mode</th>
                <th className="px-2 py-3 font-medium">Status</th>
                <th className="px-2 py-3 font-medium">Duration</th>
                <th className="px-2 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.calls.map((c) => (
                <tr key={c.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2" onClick={() => setViewing(c.id)}>
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{new Date(c.started_at).toLocaleString()}</td>
                  <td className="px-2 py-2 font-mono">{c.to_number}</td>
                  <td className="px-2 py-2 font-mono text-muted">{c.from_number}</td>
                  <td className="px-2 py-2">{c.mode === "ai" ? `AI${c.agent_name ? ` · ${c.agent_name}` : ""}` : "Human"}{c.campaign_name && <div className="text-xs text-muted">{c.campaign_name}</div>}</td>
                  <td className="px-2 py-2"><StatusBadge status={c.status} /></td>
                  <td className="px-2 py-2 tabular-nums">{c.duration_sec != null ? formatDuration(c.duration_sec) : "—"}</td>
                  <td className="px-2 py-2 text-muted">
                    <span className="flex gap-1">
                      {c.recording_count > 0 && <Mic className="size-4" aria-label="Has recording" />}
                      {c.transcript_count > 0 && <FileText className="size-4" aria-label="Has transcript" />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-border p-3 text-sm">
            <span className="text-muted">{data.total} calls{data.total > 25 ? ` · page ${page} of ${Math.ceil(data.total / 25)}` : ""}</span>
            {data.total > 25 && (
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            )}
          </div>
        </Card>
      )}
      {viewing && <CallDetailDrawer callId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
