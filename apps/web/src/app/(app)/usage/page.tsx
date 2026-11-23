"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { api, formatDuration } from "@/lib/api";
import { flagOf } from "@/lib/countries";
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";

interface Summary {
  month: string;
  totals: { calls: number; seconds: number; telephony_usd: number; ai_usd: number; total_usd: number; pending_costs: number; incomplete_costs: number };
  byMode: { mode: string; calls: number; seconds: number; total_usd: number }[];
  byCountry: { country: string; calls: number; seconds: number; telephony_usd: number }[];
  byDay: { day: string; calls: number; total_usd: number }[];
  tokens: { unit: string; quantity: number; usd: number }[];
  campaigns: { id: string; name: string; calls: number; seconds: number; total_usd: number }[];
  twilioBilled: { category: string; amount_usd: number; fetched_at: string }[];
  spend: { limit_usd: number | null; threshold_pct: number; action: "alert" | "block"; spent: number; pct: number | null; overThreshold: boolean; overLimit: boolean };
}
interface Pricing {
  prices: Record<string, { usd: number; default: number; overridden: boolean; label: string }>;
  source: { url: string; checked: string };
  unit: string;
}

const usd = (n: number | null | undefined, digits = 2) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) }).format(n ?? 0);
const TOKEN_LABEL: Record<string, string> = {
  input_audio_tokens: "Audio heard by the AI",
  output_audio_tokens: "Audio spoken by the AI",
  input_text_tokens: "Text input (instructions)",
  output_text_tokens: "Text output",
  cached_tokens: "Cached input",
  transcribe_input_tokens: "Transcription audio",
  transcribe_output_tokens: "Transcription text",
};

function monthsBack(n: number) {
  const out: string[] = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

export default function UsagePage() {
  const session = useSession();
  const owner = can(session, "*");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<Summary | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Summary>(`/usage/summary?month=${month}`).then(setData).catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, [month]);
  useEffect(load, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMsg(null);
    try {
      setMsg({ tone: "success", text: await fn() });
      load();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!can(session, "usage:view")) return <Alert>Your role can&apos;t view usage and costs.</Alert>;

  return (
    <>
      <PageHeader
        title="Usage & Costs"
        description="What your calls cost. Twilio amounts are the real prices Twilio billed; OpenAI amounts are estimates from token usage and list prices."
        actions={
          <>
            <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              {monthsBack(12).map((m) => <option key={m} value={m}>{new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</option>)}
            </select>
            {owner && (
              <Button
                variant="secondary"
                loading={busy === "recalc"}
                onClick={() =>
                  act("recalc", async () => {
                    const r = await api<{ calls: number; priced: number; waitingForTwilio: number }>("/usage/recalculate", { method: "POST" });
                    return `Checked ${r.calls} call(s): ${r.priced} fully priced, ${r.waitingForTwilio} still waiting for Twilio's price.`;
                  })
                }
              >
                <RefreshCw className="size-4" /> Recalculate costs
              </Button>
            )}
          </>
        }
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!data ? <Spinner /> : <UsageBody data={data} owner={owner} busy={busy} act={act} month={month} onLimitsSaved={load} />}
    </>
  );
}

function UsageBody({ data, owner, busy, act, month, onLimitsSaved }: { data: Summary; owner: boolean; busy: string | null; act: (k: string, fn: () => Promise<string>) => void; month: string; onLimitsSaved: () => void }) {
  const t = data.totals;
  const s = data.spend;
  return (
    <div className="space-y-6">
      {s.limit_usd != null && (
        <Card className={clsx(s.overLimit ? "border-danger/50" : s.overThreshold ? "border-warning/50" : "")}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              {(s.overThreshold || s.overLimit) && <AlertTriangle className={clsx("size-4", s.overLimit ? "text-danger" : "text-warning")} aria-hidden />}
              This month: {usd(s.spent)} of {usd(s.limit_usd)} limit ({s.pct}%)
            </span>
            <span className="text-muted">
              {s.overLimit ? (s.action === "block" ? "Limit reached: new AI calls are blocked and campaigns paused." : "Limit reached (alert only; calls continue).") : `Alert at ${s.threshold_pct}%`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={s.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className={clsx("h-full rounded-full", s.overLimit ? "bg-danger" : s.overThreshold ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, s.pct ?? 0)}%` }} />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Total cost (est.)", usd(t.total_usd)],
          ["Twilio, billed", usd(t.telephony_usd)],
          ["OpenAI, estimated", usd(t.ai_usd)],
          ["Calls", String(t.calls)],
          ["Call time", formatDuration(t.seconds)],
        ].map(([label, value]) => (
          <Card key={label} className="p-4">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          </Card>
        ))}
      </div>
      {(t.pending_costs > 0 || t.incomplete_costs > 0) && (
        <p className="text-sm text-muted">
          {t.pending_costs > 0 && `${t.pending_costs} call(s) are waiting for Twilio's price. Twilio can take several hours to price a call, and the app keeps checking automatically, so Twilio amounts may be lower than final for now. `}
          {t.incomplete_costs > 0 && `${t.incomplete_costs} call(s) have no price from Twilio (often calls that never connected).`}
        </p>
      )}

      <DailyChart days={data.byDay} month={month} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <h2 className="px-5 pt-4 font-semibold">By destination country</h2>
          <SimpleTable
            head={["Country", "Calls", "Time", "Twilio billed"]}
            rows={data.byCountry.map((c) => [`${flagOf(c.country)} ${c.country}`, c.calls, formatDuration(c.seconds), usd(c.telephony_usd, 3)])}
            empty="No calls this month."
          />
        </Card>
        <Card className="p-0">
          <h2 className="px-5 pt-4 font-semibold">By call type</h2>
          <SimpleTable
            head={["Type", "Calls", "Time", "Total (est.)"]}
            rows={data.byMode.map((m) => [m.mode === "ai" ? "AI-to-Human" : "Human-to-Human", m.calls, formatDuration(m.seconds), usd(m.total_usd, 3)])}
            empty="No calls this month."
          />
        </Card>
        <Card className="p-0">
          <h2 className="px-5 pt-4 font-semibold">OpenAI usage</h2>
          <SimpleTable
            head={["What", "Tokens", "Estimated"]}
            rows={data.tokens.map((k) => [TOKEN_LABEL[k.unit] ?? k.unit, Math.round(k.quantity).toLocaleString(), usd(k.usd, 4)])}
            empty="No AI calls this month."
          />
        </Card>
        <Card className="p-0">
          <h2 className="px-5 pt-4 font-semibold">By campaign</h2>
          <SimpleTable
            head={["Campaign", "Calls", "Time", "Total (est.)"]}
            rows={data.campaigns.map((c) => [c.name, c.calls, formatDuration(c.seconds), usd(c.total_usd, 3)])}
            empty="No campaign calls this month."
          />
        </Card>
      </div>

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Twilio&apos;s own bill for this month</h2>
          <Button variant="secondary" loading={busy === "reconcile"} onClick={() => act("reconcile", async () => `Fetched ${(await api<{ categories: number }>(`/usage/reconcile?month=${month}`, { method: "POST" })).categories} billed categories from Twilio.`)}>
            <RefreshCw className="size-4" /> Fetch from Twilio
          </Button>
        </div>
        <p className="mb-3 text-sm text-muted">These are Twilio&apos;s official usage records for your <strong>whole Twilio account</strong>. If another app uses the same account, its usage is included here too, so this can be higher than the per-call totals above.</p>
        <SimpleTable
          head={["Category", "Billed"]}
          rows={data.twilioBilled.map((b) => [b.category, usd(b.amount_usd, 3)])}
          empty="Not fetched yet. Click “Fetch from Twilio”."
        />
      </Card>

      {owner && <LimitsCard spend={s} onSaved={onLimitsSaved} />}
      <PricingCard owner={owner} />
    </div>
  );
}

function SimpleTable({ head, rows, empty }: { head: string[]; rows: (string | number)[][]; empty: string }) {
  if (!rows.length) return <p className="px-5 py-4 text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr>{head.map((h, i) => <th key={h} className={clsx("px-5 py-2 font-medium", i > 0 && "text-right")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => <td key={j} className={clsx("px-5 py-2", j > 0 && "text-right tabular-nums")}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Daily cost columns: one series (no legend), ≤24px columns, 4px rounded tops, 2px gaps, hover tooltip, table view. */
function DailyChart({ days, month }: { days: Summary["byDay"]; month: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const start = new Date(`${month}-01T00:00:00Z`);
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const series = Array.from({ length: daysInMonth }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, "0")}`;
    return { day, n: i + 1, calls: byDay.get(day)?.calls ?? 0, usd: byDay.get(day)?.total_usd ?? 0 };
  });
  const max = Math.max(...series.map((d) => d.usd), 0);
  const niceMax = (() => {
    if (max <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= max)!;
  })();
  const H = 160;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Estimated cost per day</h2>
        <button className="text-sm text-primary hover:underline" onClick={() => setAsTable(!asTable)}>{asTable ? "Show chart" : "Show as table"}</button>
      </div>
      {asTable ? (
        <SimpleTable head={["Day", "Calls", "Estimated cost"]} rows={series.filter((d) => d.calls).map((d) => [d.day, d.calls, usd(d.usd, 3)])} empty="No calls this month." />
      ) : max === 0 ? (
        <p className="py-10 text-center text-sm text-muted">No costs recorded this month yet.</p>
      ) : (
        <div className="relative">
          <div className="flex">
            <div className="flex w-14 shrink-0 flex-col justify-between pr-2 text-right text-xs text-muted" style={{ height: H }}>
              <span>{usd(niceMax)}</span>
              <span>{usd(niceMax / 2)}</span>
              <span>$0</span>
            </div>
            <div className="relative flex-1" style={{ height: H }}>
              {[0, 0.5, 1].map((f) => <div key={f} className="absolute inset-x-0 border-t border-border/60" style={{ top: `${f * 100}%` }} />)}
              <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
                {series.map((d, i) => (
                  <div
                    key={d.day}
                    className="flex h-full flex-1 cursor-default items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={d.calls ? 0 : -1}
                    aria-label={`${d.day}: ${d.calls} calls, ${usd(d.usd, 3)}`}
                  >
                    <div
                      className={clsx("w-full max-w-6 rounded-t-[4px] bg-primary transition-opacity", hover !== null && hover !== i && "opacity-60")}
                      style={{ height: d.usd > 0 ? `max(2px, ${(d.usd / niceMax) * 100}%)` : 0 }}
                    />
                  </div>
                ))}
              </div>
              {hover !== null && series[hover].calls > 0 && (
                <div
                  className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
                  style={{ left: `${((hover + 0.5) / series.length) * 100}%` }}
                >
                  <div className="font-medium">{new Date(`${series[hover].day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}</div>
                  <div className="tabular-nums">{usd(series[hover].usd, 3)} · {series[hover].calls} call{series[hover].calls === 1 ? "" : "s"}</div>
                </div>
              )}
            </div>
          </div>
          <div className="ml-14 mt-1 flex justify-between text-xs text-muted">
            <span>1</span><span>{Math.ceil(daysInMonth / 2)}</span><span>{daysInMonth}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function LimitsCard({ spend, onSaved }: { spend: Summary["spend"]; onSaved: () => void }) {
  const [limit, setLimit] = useState(spend.limit_usd != null ? String(spend.limit_usd) : "");
  const [threshold, setThreshold] = useState(spend.threshold_pct);
  const [action, setAction] = useState(spend.action);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await api("/usage/limits", { method: "PUT", json: { monthlyLimitUsd: limit ? Number(limit) : null, alertThresholdPct: threshold, action } });
      setMsg({ tone: "success", text: "Spending limit saved." });
      onSaved();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Monthly spending limit</h2>
      <p className="mb-4 text-sm text-muted">Based on this platform&apos;s per-call costs (Twilio billed + OpenAI estimate), from the 1st of each month (UTC). You&apos;ll see an alert on the dashboard; there&apos;s no email yet.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Input name="limit" label="Limit (USD per month)" type="number" min={1} step="1" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" hint="Leave empty for no limit." />
        <label className="block space-y-1.5 text-sm">
          <span className="flex justify-between font-medium">Alert at <span className="tabular-nums">{threshold}%</span></span>
          <input type="range" min={10} max={100} step={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="mt-3 w-full accent-[var(--primary)]" />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">When the limit is reached</span>
          <select value={action} onChange={(e) => setAction(e.target.value as "alert" | "block")} className="w-full rounded-lg border border-border bg-surface px-3 py-2">
            <option value="alert">Alert only</option>
            <option value="block">Block new AI calls &amp; pause campaigns</option>
          </select>
        </label>
      </div>
      {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <Button className="mt-4" onClick={save} loading={saving}>Save limit</Button>
    </Card>
  );
}

function PricingCard({ owner }: { owner: boolean }) {
  const [p, setP] = useState<Pricing | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  useEffect(() => {
    api<Pricing>("/usage/pricing").then(setP).catch(() => {});
  }, []);
  if (!p) return null;
  async function save() {
    const overrides = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v === "" ? null : Number(v)]));
    try {
      const r = await api<Pricing>("/usage/pricing", { method: "PUT", json: { overrides } });
      setP({ ...p!, prices: r.prices });
      setEdits({});
      setMsg({ tone: "success", text: "Prices saved. Use “Recalculate costs” to apply them to earlier calls." });
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Prices used for OpenAI estimates</h2>
      <p className="mb-3 text-sm text-muted">
        {p.unit}. Defaults copied from{" "}
        <a className="inline-flex items-center gap-0.5 text-primary hover:underline" href={p.source.url} target="_blank" rel="noreferrer">OpenAI&apos;s pricing page <ExternalLink className="size-3" /></a>{" "}
        on {p.source.checked}. If OpenAI changes its prices{owner ? ", update them here" : ", the owner can update them"}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted"><tr><th className="py-2 font-medium">Item</th><th className="py-2 text-right font-medium">Default</th><th className="py-2 text-right font-medium">In use</th></tr></thead>
          <tbody>
            {Object.entries(p.prices).map(([key, v]) => (
              <tr key={key} className="border-t border-border">
                <td className="py-2">{v.label}</td>
                <td className="py-2 text-right tabular-nums text-muted">${v.default}</td>
                <td className="py-2 text-right">
                  {owner ? (
                    <input
                      aria-label={`Price for ${v.label}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={edits[key] ?? (v.overridden ? String(v.usd) : "")}
                      placeholder={String(v.default)}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                      className="w-24 rounded border border-border bg-surface px-2 py-1 text-right tabular-nums"
                    />
                  ) : (
                    <span className="tabular-nums">${v.usd}</span>
                  )}
                  {v.overridden && <Badge tone="info">custom</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {owner && Object.keys(edits).length > 0 && <Button className="mt-3" onClick={save}>Save prices</Button>}
    </Card>
  );
}
