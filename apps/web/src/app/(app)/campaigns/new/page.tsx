"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Check, FileSpreadsheet, Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { countries } from "@/lib/countries";
import { Alert, Badge, Button, Card, Input, PageHeader } from "@/components/ui";
import { parseFile, parsePasted, type RawRow } from "@/components/campaigns/parse-list";

interface Result {
  index: number;
  input: string;
  name: string | null;
  e164: string | null;
  country: string | null;
  status: "valid" | "invalid" | "duplicate" | "dnc";
  reason?: string;
}
interface Agent {
  id: string;
  name: string;
  is_active: boolean;
}
interface NumberOption {
  id: string;
  e164: string;
  is_default: boolean;
  status: string;
  number_type: string;
}

const STEPS = ["Numbers", "Agent", "Schedule", "Review"] as const;
const fieldCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
const STATUS_BADGE = { valid: ["success", "Valid"], invalid: ["danger", "Invalid"], duplicate: ["warning", "Duplicate"], dnc: ["neutral", "Do Not Call"] } as const;

export default function NewCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [defaultCountry, setDefaultCountry] = useState("AE");
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [raw, setRaw] = useState<RawRow[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  // Steps 2–3
  const [agents, setAgents] = useState<Agent[]>([]);
  const [numbers, setNumbers] = useState<NumberOption[]>([]);
  const [form, setForm] = useState({
    name: "",
    agentId: "",
    fromNumberId: "",
    instructions: "",
    callingHoursStart: "09:00",
    callingHoursEnd: "18:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Dubai",
    maxConcurrent: 1,
    maxRetries: 1,
    retryDelayMin: 60,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api<{ agents: Agent[] }>("/agents").then((r) => {
      const active = r.agents.filter((a) => a.is_active);
      setAgents(active);
      setForm((f) => ({ ...f, agentId: f.agentId || active[0]?.id || "" }));
    });
    api<{ numbers: NumberOption[] }>("/phone-numbers").then((r) => {
      const usable = r.numbers.filter((n) => n.status === "active" && ["provider_owned", "verified_caller_id"].includes(n.number_type));
      setNumbers(usable);
      setForm((f) => ({ ...f, fromNumberId: f.fromNumberId || usable.find((n) => n.is_default)?.id || "" }));
    });
  }, []);

  const selected = useMemo(() => (results ?? []).filter((r) => r.status === "valid" && !excluded.has(r.index)), [results, excluded]);
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return [form.timezone];
    }
  }, [form.timezone]);

  async function loadFile(file: File) {
    setError(null);
    try {
      const rows = await parseFile(file);
      if (!rows.length) throw new Error("No phone numbers were found in that file.");
      setRaw(rows);
      setFileName(`${file.name} · ${rows.length} rows`);
      setPasted("");
      setResults(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function check() {
    const rows = raw.length ? raw : parsePasted(pasted);
    if (!rows.length) return setError("Upload a file or paste at least one number.");
    if (rows.length > 5000) return setError(`That's ${rows.length} rows. The limit is 5,000 per campaign; split the list into smaller campaigns.`);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ results: Result[] }>("/campaigns/validate", { method: "POST", json: { rows, defaultCountry } });
      setResults(r.results);
      setExcluded(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rows = selected.map((r) => ({ phone: r.e164!, name: r.name ?? undefined }));
      const r = await api<{ campaign: { id: string } }>("/campaigns", {
        method: "POST",
        json: { ...form, fromNumberId: form.fromNumberId || undefined, instructions: form.instructions || undefined, defaultCountry, rows },
      });
      router.push(`/campaigns/${r.campaign.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.fields?.length ? e.fields.map((f) => `${f.path}: ${f.message}`).join(" · ") : (e as Error).message);
      setBusy(false);
    }
  }

  const canNext = [selected.length > 0, !!form.agentId && form.name.trim().length >= 2, true, true][step];
  const summary = results && {
    valid: results.filter((r) => r.status === "valid").length,
    invalid: results.filter((r) => r.status === "invalid").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    dnc: results.filter((r) => r.status === "dnc").length,
  };

  return (
    <>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" /> Campaigns</Link>
      <PageHeader title="New campaign" description="Nothing is called until you review the campaign and press Start." />

      <ol className="mb-6 flex flex-wrap gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={clsx("flex items-center gap-2 rounded-full px-3 py-1", i === step ? "bg-primary text-primary-fg" : i < step ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
            {i < step ? <Check className="size-3.5" /> : <span className="tabular-nums">{i + 1}</span>} {s}
          </li>
        ))}
      </ol>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {step === 0 && (
        <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
          <Card className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Country for numbers without +code</span>
              <select className={fieldCls} value={defaultCountry} onChange={(e) => (setDefaultCountry(e.target.value), setResults(null))}>
                {countries().map((c) => <option key={c.iso} value={c.iso}>{c.flag} {c.name} ({c.dialCode})</option>)}
              </select>
            </label>
            <div
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-6 text-center text-sm hover:border-primary"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
              }}
            >
              <Upload className="size-6 text-muted" />
              <span className="font-medium">Upload CSV or Excel (.xlsx)</span>
              <span className="text-xs text-muted">Needs a column of phone numbers. A “name” column is used if present.</span>
              <input ref={fileInput} type="file" accept=".csv,.xlsx,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
            </div>
            {fileName && (
              <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <span className="flex items-center gap-2"><FileSpreadsheet className="size-4" /> {fileName}</span>
                <button className="text-muted hover:text-text" onClick={() => (setRaw([]), setFileName(null), setResults(null))}>Remove</button>
              </div>
            )}
            <div className="text-center text-xs text-muted">or</div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Paste numbers, one per line</span>
              <textarea
                className={clsx(fieldCls, "font-mono")}
                rows={6}
                value={pasted}
                disabled={!!fileName}
                onChange={(e) => (setPasted(e.target.value), setResults(null))}
                placeholder={"+971 50 123 4567\nSara Khan, 050 765 4321\n0044 20 7946 0958"}
              />
            </label>
            <Button className="w-full" onClick={check} loading={busy} disabled={!fileName && !pasted.trim()}>Check numbers</Button>
          </Card>

          <Card className="min-w-0 p-0">
            {!results ? (
              <p className="p-8 text-center text-sm text-muted">Numbers will appear here after checking: valid ones are selected; invalid, duplicate and Do Not Call numbers are left out.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border p-4 text-sm">
                  <Badge tone="success">{summary!.valid} valid</Badge>
                  <Badge tone="danger">{summary!.invalid} invalid</Badge>
                  <Badge tone="warning">{summary!.duplicate} duplicates</Badge>
                  <Badge>{summary!.dnc} on Do Not Call</Badge>
                  <span className="ml-auto font-medium">{selected.length} selected</span>
                </div>
                <div className="max-h-[28rem] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface text-left text-muted">
                      <tr>
                        <th className="w-10 px-4 py-2" />
                        <th className="px-2 py-2 font-medium">Name</th>
                        <th className="px-2 py-2 font-medium">As entered</th>
                        <th className="px-2 py-2 font-medium">Will call</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.slice(0, 1000).map((r) => {
                        const ok = r.status === "valid";
                        const [tone, label] = STATUS_BADGE[r.status];
                        return (
                          <tr key={r.index} className="border-t border-border">
                            <td className="px-4 py-1.5">
                              <input
                                type="checkbox"
                                className="size-4 accent-[var(--primary)]"
                                disabled={!ok}
                                checked={ok && !excluded.has(r.index)}
                                onChange={() => setExcluded((s) => { const n = new Set(s); if (n.has(r.index)) n.delete(r.index); else n.add(r.index); return n; })}
                                aria-label={`Include ${r.input}`}
                              />
                            </td>
                            <td className="px-2 py-1.5">{r.name ?? <span className="text-muted">—</span>}</td>
                            <td className="px-2 py-1.5 font-mono text-muted">{r.input}</td>
                            <td className="px-2 py-1.5 font-mono">{r.e164 ?? "—"}</td>
                            <td className="px-2 py-1.5"><Badge tone={tone}>{label}</Badge> {r.reason && !ok && <span className="text-xs text-muted">{r.reason}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {results.length > 1000 && <p className="p-3 text-center text-xs text-muted">Showing the first 1,000 rows. All {summary!.valid} valid numbers are included unless unticked.</p>}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {step === 1 && (
        <Card className="max-w-2xl space-y-4">
          <Input name="name" label="Campaign name" required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. November appointment reminders" maxLength={100} />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">AI agent</span>
            <select className={fieldCls} value={form.agentId} onChange={(e) => set("agentId", e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <span className="text-xs text-muted">Only active agents are listed. Create or edit agents on the <Link className="text-primary hover:underline" href="/agents">AI Agents</Link> page.</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Campaign instructions (optional)</span>
            <textarea className={fieldCls} rows={4} maxLength={2000} value={form.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="Added to the agent's instructions for every call in this campaign, e.g. “Tell them about the 20% weekend offer.” The contact's name is added automatically." />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Call from (caller ID)</span>
            <select className={fieldCls} value={form.fromNumberId} onChange={(e) => set("fromNumberId", e.target.value)}>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.e164}{n.is_default ? " (default)" : ""}</option>)}
            </select>
          </label>
        </Card>
      )}

      {step === 2 && (
        <Card className="max-w-2xl space-y-5">
          <div>
            <h3 className="mb-2 font-medium">Calling hours</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input name="start" label="From" type="time" value={form.callingHoursStart} onChange={(e) => set("callingHoursStart", e.target.value)} />
              <Input name="end" label="Until" type="time" value={form.callingHoursEnd} onChange={(e) => set("callingHoursEnd", e.target.value)} />
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Timezone</span>
                <select className={fieldCls} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                  {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-1 text-xs text-muted">No calls start outside these hours. Use the timezone of the people you&apos;re calling.</p>
          </div>
          <label className="block space-y-1.5">
            <span className="flex justify-between text-sm font-medium">Calls at the same time <span className="tabular-nums">{form.maxConcurrent}</span></span>
            <input type="range" min={1} max={10} value={form.maxConcurrent} onChange={(e) => set("maxConcurrent", Number(e.target.value))} className="w-full accent-[var(--primary)]" />
            <span className="text-xs text-muted">Maximum 10. Your account-wide AI call limit also applies (default 2), whichever is lower.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Retries if no answer / busy</span>
              <select className={fieldCls} value={form.maxRetries} onChange={(e) => set("maxRetries", Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "Don't retry" : `${n} time${n > 1 ? "s" : ""}`}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Wait before retrying</span>
              <select className={fieldCls} value={form.retryDelayMin} onChange={(e) => set("retryDelayMin", Number(e.target.value))}>
                {[15, 30, 60, 120, 240, 1440].map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : n === 1440 ? "1 day" : `${n / 60} hour${n > 60 ? "s" : ""}`}</option>)}
              </select>
            </label>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card className="max-w-2xl">
          <h3 className="mb-3 font-semibold">{form.name}</h3>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Contacts</dt><dd className="font-medium">{selected.length}</dd>
            <dt className="text-muted">AI agent</dt><dd>{agents.find((a) => a.id === form.agentId)?.name}</dd>
            <dt className="text-muted">Caller ID</dt><dd className="font-mono">{numbers.find((n) => n.id === form.fromNumberId)?.e164 ?? "Default"}</dd>
            <dt className="text-muted">Calling hours</dt><dd>{form.callingHoursStart}–{form.callingHoursEnd} ({form.timezone})</dd>
            <dt className="text-muted">At the same time</dt><dd>{form.maxConcurrent}</dd>
            <dt className="text-muted">Retries</dt><dd>{form.maxRetries ? `${form.maxRetries}, ${form.retryDelayMin} min apart` : "None"}</dd>
            {form.instructions && (<><dt className="text-muted">Instructions</dt><dd className="whitespace-pre-wrap">{form.instructions}</dd></>)}
          </dl>
          <Alert tone="info">Creating saves the campaign as a <strong>draft</strong>. You&apos;ll confirm consent and press Start on the next screen.</Alert>
        </Card>
      )}

      <div className="mt-6 flex gap-2">
        {step > 0 && <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={busy}>Back</Button>}
        {step < 3 ? (
          <Button onClick={() => setStep(step + 1)} disabled={!canNext}>Continue{step === 0 && selected.length ? ` with ${selected.length} numbers` : ""}</Button>
        ) : (
          <Button onClick={create} loading={busy}>Create campaign</Button>
        )}
      </div>
    </>
  );
}
