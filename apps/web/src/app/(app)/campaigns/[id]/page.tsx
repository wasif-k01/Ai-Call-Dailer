"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Pause, Play, ShieldCheck, Square, Trash2 } from "lucide-react";
import { api, formatDuration, formatUsd } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";
import { CAMPAIGN_STATUS, CONTACT_STATUS, type Campaign, type CampaignStats } from "@/components/campaigns/status";

interface ContactRow {
  id: string;
  phone_e164: string;
  display_name: string | null;
  status: string;
  attempts: number;
  final: boolean;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  duration_sec: number | null;
}

const FILTERS = ["all", "pending", "calling", "answered", "completed", "no_answer", "busy", "failed", "opted_out"] as const;

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const manage = can(session, "campaigns:manage");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<{ level: string; message: string; created_at: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([
        api<{ campaign: Campaign; stats: CampaignStats }>(`/campaigns/${id}`),
        api<{ contacts: ContactRow[]; total: number }>(`/campaigns/${id}/contacts?status=${filter}&page=${page}&pageSize=50`),
        api<{ logs: { level: string; message: string; created_at: string }[] }>(`/campaigns/${id}/logs`),
      ])
        .then(([c, list, l]) => {
          setCampaign(c.campaign);
          setStats(c.stats);
          setRows(list.contacts);
          setTotal(list.total);
          setLogs(l.logs);
        })
        .catch((e) => setError((e as Error).message)),
    [id, filter, page],
  );

  useEffect(() => {
    void load();
  }, [load]);
  const { connected } = useRealtime((e) => {
    if (e.type === "campaign.progress" && (e.data as { campaignId: string }).campaignId === id) load();
  });
  useEffect(() => {
    if (campaign?.status !== "running") return;
    const t = setInterval(load, connected ? 15_000 : 4_000);
    return () => clearInterval(t);
  }, [campaign?.status, connected, load]);

  async function act(action: "pause" | "resume" | "stop" | "delete") {
    setBusy(action);
    setError(null);
    try {
      if (action === "delete") {
        await api(`/campaigns/${id}`, { method: "DELETE" });
        return router.push("/campaigns");
      }
      await api(`/campaigns/${id}/${action}`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !campaign) return <Alert>{error}</Alert>;
  if (!campaign || !stats) return <Spinner />;
  const st = CAMPAIGN_STATUS[campaign.status];
  const done = stats.total - stats.remaining - stats.in_progress;
  const pct = stats.total ? Math.round((done / stats.total) * 100) : 0;

  const tiles = [
    ["Total Numbers", stats.total],
    ["Calls Attempted", stats.attempted],
    ["Answered", stats.answered],
    ["Successful", stats.successful],
    ["Failed / No answer", stats.failed],
    ["Opted Out", stats.opted_out],
    ["In progress", stats.in_progress],
    ["Average Duration", formatDuration(stats.avg_duration_sec)],
    ["Total Cost", stats.total_cost_usd == null ? "—" : formatUsd(stats.total_cost_usd)],
  ] as const;

  return (
    <>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" /> Campaigns</Link>
      <PageHeader
        title={campaign.name}
        description={`${campaign.agent_name ?? "No agent"} · calls ${campaign.calling_hours_start}–${campaign.calling_hours_end} ${campaign.timezone} · up to ${campaign.max_concurrent} at once · ${campaign.max_retries} retr${campaign.max_retries === 1 ? "y" : "ies"}`}
        actions={
          manage && (
            <>
              {campaign.status === "draft" && (
                <>
                  <Button onClick={() => setShowStart(true)}><Play className="size-4" /> Start Campaign</Button>
                  <Button variant="ghost" onClick={() => act("delete")} loading={busy === "delete"} aria-label="Delete draft"><Trash2 className="size-4" /></Button>
                </>
              )}
              {campaign.status === "running" && <Button variant="secondary" onClick={() => act("pause")} loading={busy === "pause"}><Pause className="size-4" /> Pause</Button>}
              {campaign.status === "paused" && <Button onClick={() => act("resume")} loading={busy === "resume"}><Play className="size-4" /> Resume</Button>}
              {(campaign.status === "running" || campaign.status === "paused") && (
                <Button variant="danger" onClick={() => act("stop")} loading={busy === "stop"}><Square className="size-4" /> Stop</Button>
              )}
            </>
          )
        }
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <Card className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={st?.tone}>{st?.label}</Badge>
            {campaign.status === "running" && <span className="text-sm text-muted">Calls start only within calling hours. Pause or Stop let calls in progress finish.</span>}
          </div>
          <span className="text-sm font-medium tabular-nums">{pct}% done · {stats.remaining} left</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        {campaign.consent_confirmed_at && (
          <p className="mt-3 flex items-center gap-1 text-xs text-muted"><ShieldCheck className="size-3.5 text-success" /> Consent confirmed {new Date(campaign.consent_confirmed_at).toLocaleString()}</p>
        )}
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map(([label, value]) => (
          <Card key={label} className="p-4">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card className="min-w-0 p-0">
          <div className="flex flex-wrap gap-1 border-b border-border p-3">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => (setFilter(f), setPage(1))}
                className={clsx("rounded-full px-3 py-1 text-xs", filter === f ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted hover:text-text")}
              >
                {f === "all" ? "All" : CONTACT_STATUS[f].label} {f === "all" ? stats.total : stats.by_status[f] ?? 0}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Attempts</th>
                  <th className="px-2 py-2 font-medium">Duration</th>
                  <th className="px-2 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = CONTACT_STATUS[r.status];
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-4 py-2"><div className="font-mono">{r.phone_e164}</div>{r.display_name && <div className="text-xs text-muted">{r.display_name}</div>}</td>
                      <td className="px-2 py-2"><Badge tone={s?.tone}>{s?.label ?? r.status}</Badge></td>
                      <td className="px-2 py-2 tabular-nums">{r.attempts}</td>
                      <td className="px-2 py-2 tabular-nums">{r.duration_sec ? formatDuration(r.duration_sec) : "—"}</td>
                      <td className="px-2 py-2 text-xs text-muted">
                        {r.last_error ?? (!r.final && r.next_attempt_at ? `Retry after ${new Date(r.next_attempt_at).toLocaleTimeString()}` : "")}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted">No contacts with this status.</td></tr>}
              </tbody>
            </table>
          </div>
          {total > 50 && (
            <div className="flex items-center justify-between border-t border-border p-3 text-sm">
              <span className="text-muted">Page {page} of {Math.ceil(total / 50)}</span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="mb-3 font-semibold">Activity</h3>
          <ul className="space-y-3 text-sm">
            {logs.map((l, i) => (
              <li key={i} className={clsx(l.level === "warn" && "text-warning", l.level === "error" && "text-danger")}>
                <div className="text-xs text-muted">{new Date(l.created_at).toLocaleString()}</div>
                {l.message}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {showStart && <StartDialog campaignId={id} total={stats.total} onClose={() => setShowStart(false)} onStarted={() => (setShowStart(false), load())} />}
    </>
  );
}

/** Consent + count confirmation before any automated call is placed. */
function StartDialog({ campaignId, total, onClose, onStarted }: { campaignId: string; total: number; onClose: () => void; onStarted: () => void }) {
  const [consent, setConsent] = useState(false);
  const [count, setCount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api(`/campaigns/${campaignId}/start`, { method: "POST", json: { consentConfirmed: consent, confirmContactCount: Number(count) } });
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Start campaign">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <Card className="relative w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold">Start calling {total} people?</h2>
        <p className="text-sm text-muted">The AI agent will start calling immediately (within the calling hours). Automated calls are regulated in most countries: only call people who have agreed to be contacted.</p>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I confirm I have each person&apos;s consent, and any legal authorisation required, to contact them with automated AI calls. People who ask not to be called will be added to the Do Not Call list.</span>
        </label>
        <Input name="count" label={`Type ${total} to confirm the number of contacts`} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2">
          <Button onClick={start} loading={busy} disabled={!consent || Number(count) !== total}><Play className="size-4" /> Start Campaign</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </Card>
    </div>
  );
}
