"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Bot, Copy, Eye, Pencil, PhoneCall, Plus, Power, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  system_instructions: string;
  voice: string;
  language: string;
  speaking_speed: number;
  conversation_style: string;
  greeting_message: string;
  max_call_duration_sec: number;
  conversation_rules: string | null;
  call_ending_instructions: string | null;
  is_active: boolean;
  call_count: number;
}
interface Options {
  voices: string[];
  languages: Record<string, string>;
  styles: string[];
}

const fieldCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

const BLANK: Omit<Agent, "id" | "call_count"> = {
  name: "",
  description: "",
  system_instructions: "",
  voice: "marin",
  language: "auto",
  speaking_speed: 1,
  conversation_style: "friendly",
  greeting_message: "Hi! This is an AI assistant calling on behalf of …",
  max_call_duration_sec: 300,
  conversation_rules: "",
  call_ending_instructions: "When the conversation is finished, thank the person, say goodbye and end the call.",
  is_active: true,
};

export default function AgentsPage() {
  const session = useSession();
  const manage = can(session, "agents:manage");
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ agents: Agent[] }>("/agents").then((r) => setAgents(r.agents)).catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, []);
  useEffect(() => {
    load();
    api<Options>("/agents/options").then(setOptions).catch(() => {});
  }, [load]);

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

  const duplicate = (a: Agent) =>
    act(`dup-${a.id}`, async () => {
      const r = await api<{ agent: Agent }>(`/agents/${a.id}/duplicate`, { method: "POST" });
      return `Created "${r.agent.name}" (inactive until you switch it on).`;
    });
  const toggle = (a: Agent) =>
    act(`tog-${a.id}`, async () => {
      await api(`/agents/${a.id}/${a.is_active ? "deactivate" : "activate"}`, { method: "POST" });
      return `"${a.name}" is now ${a.is_active ? "inactive" : "active"}.`;
    });
  const remove = (a: Agent) =>
    act(`del-${a.id}`, async () => {
      setConfirmDelete(null);
      await api(`/agents/${a.id}`, { method: "DELETE" });
      return `Deleted "${a.name}". Its past calls stay in Call History.`;
    });
  const showPreview = async (a: Agent) => {
    try {
      const r = await api<{ instructions: string }>(`/agents/${a.id}/instructions-preview`);
      setPreview({ name: a.name, text: r.instructions });
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  };

  if (!agents || !options) return msg ? <Alert>{msg.text}</Alert> : <Spinner />;

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Each agent is a ready-made AI caller with its own instructions, voice and greeting. Pick one when you start an AI call or campaign."
        actions={manage && <Button onClick={() => setEditing("new")}><Plus className="size-4" /> Create Agent</Button>}
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {agents.length === 0 ? (
        <EmptyState icon={<Bot className="size-8" />} title="No agents yet" description="Create your first AI agent to start AI calls." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <Card key={a.id} className={clsx("flex flex-col", !a.is_active && "opacity-70")}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{a.name}</h3>
                  {a.description && <p className="line-clamp-2 text-sm text-muted">{a.description}</p>}
                </div>
                <Badge tone={a.is_active ? "success" : "neutral"}>{a.is_active ? "Active" : "Inactive"}</Badge>
              </div>
              <p className="mb-3 line-clamp-2 text-sm italic text-muted">“{a.greeting_message}”</p>
              <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted">Voice</dt><dd className="capitalize">{a.voice}</dd>
                <dt className="text-muted">Language</dt><dd>{options.languages[a.language] ?? a.language}</dd>
                <dt className="text-muted">Style · speed</dt><dd className="capitalize">{a.conversation_style} · {a.speaking_speed}×</dd>
                <dt className="text-muted">Max call</dt><dd>{Math.round(a.max_call_duration_sec / 60 * 10) / 10} min</dd>
                <dt className="text-muted">Calls made</dt><dd>{a.call_count}</dd>
              </dl>
              <div className="mt-auto flex flex-wrap gap-1 border-t border-border pt-3">
                {a.is_active && (
                  <Link href={`/ai-calling?agent=${a.id}`}><Button variant="secondary" className="px-3"><PhoneCall className="size-4" /> Test call</Button></Link>
                )}
                {manage && <Button variant="ghost" className="px-2" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}><Pencil className="size-4" /></Button>}
                <Button variant="ghost" className="px-2" onClick={() => showPreview(a)} aria-label={`See what ${a.name} is told`} title="See exactly what the AI is told"><Eye className="size-4" /></Button>
                {manage && (
                  <>
                    <Button variant="ghost" className="px-2" onClick={() => duplicate(a)} loading={busy === `dup-${a.id}`} aria-label={`Duplicate ${a.name}`} title="Duplicate"><Copy className="size-4" /></Button>
                    <Button variant="ghost" className="px-2" onClick={() => toggle(a)} loading={busy === `tog-${a.id}`} title={a.is_active ? "Deactivate" : "Activate"} aria-label={a.is_active ? "Deactivate" : "Activate"}><Power className="size-4" /></Button>
                    {confirmDelete === a.id ? (
                      <>
                        <Button variant="danger" className="px-3" onClick={() => remove(a)} loading={busy === `del-${a.id}`}>Delete</Button>
                        <Button variant="ghost" className="px-2" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button variant="ghost" className="px-2" onClick={() => setConfirmDelete(a.id)} aria-label={`Delete ${a.name}`} title="Delete"><Trash2 className="size-4" /></Button>
                    )}
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <AgentEditor
          agent={editing === "new" ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMsg({ tone: "success", text });
            load();
          }}
        />
      )}

      {preview && (
        <Drawer title={`What “${preview.name}” is told`} onClose={() => setPreview(null)}>
          <p className="mb-3 text-sm text-muted">This is the full instruction text sent to OpenAI at the start of every call with this agent. The mandatory rules at the end are always added and can&apos;t be removed.</p>
          <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-4 font-mono text-xs leading-relaxed">{preview.text}</pre>
        </Drawer>
      )}
    </>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:text-text" aria-label="Close"><X className="size-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function TextArea({ name, label, defaultValue, rows = 3, hint, error, required, maxLength }: { name: string; label: string; defaultValue?: string | null; rows?: number; hint?: string; error?: string; required?: boolean; maxLength?: number }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <textarea name={name} defaultValue={defaultValue ?? ""} rows={rows} required={required} maxLength={maxLength} className={clsx(fieldCls, error && "border-danger")} />
      {error ? <span className="text-xs text-danger">{error}</span> : hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

function AgentEditor({ agent, options, onClose, onSaved }: { agent: Agent | null; options: Options; onClose: () => void; onSaved: (msg: string) => void }) {
  const a = agent ?? { ...BLANK, id: "", call_count: 0 };
  const [speed, setSpeed] = useState(a.speaking_speed);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? "");
    const body = {
      name: s("name"),
      description: s("description") || null,
      systemInstructions: s("systemInstructions"),
      voice: s("voice"),
      language: s("language"),
      speakingSpeed: speed,
      conversationStyle: s("conversationStyle"),
      greetingMessage: s("greetingMessage"),
      maxCallDurationSec: Math.round(Number(s("maxMinutes")) * 60),
      conversationRules: s("conversationRules") || null,
      callEndingInstructions: s("callEndingInstructions") || null,
      isActive: fd.get("isActive") === "on",
    };
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      if (agent) await api(`/agents/${agent.id}`, { method: "PUT", json: body });
      else await api("/agents", { method: "POST", json: body });
      onSaved(agent ? `Saved "${body.name}".` : `Created "${body.name}".`);
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        const map = Object.fromEntries(err.fields.map((f) => [f.path === "maxCallDurationSec" ? "maxMinutes" : f.path, f.message]));
        setErrors(map);
      }
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer title={agent ? `Edit “${agent.name}”` : "Create Agent"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <Input name="name" label="Agent name" required defaultValue={a.name} maxLength={80} error={errors.name} placeholder="e.g. Appointment Reminder" />
        <Input name="description" label="Description (optional)" defaultValue={a.description ?? ""} maxLength={300} placeholder="What is this agent for?" />
        <TextArea
          name="systemInstructions"
          label="Instructions: what should the AI do?"
          rows={6}
          required
          maxLength={8000}
          defaultValue={a.system_instructions}
          error={errors.systemInstructions}
          hint="Write it like a briefing for a new staff member: who you are, why you're calling, what to find out, what to offer."
        />
        <TextArea
          name="greetingMessage"
          label="Greeting: the first thing the AI says"
          rows={2}
          required
          maxLength={500}
          defaultValue={a.greeting_message}
          error={errors.greetingMessage}
          hint="Include that it's an AI assistant and who it's calling for."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Voice</span>
            <select name="voice" defaultValue={a.voice} className={fieldCls}>
              {options.voices.map((v) => <option key={v} value={v}>{v}{v === "marin" || v === "cedar" ? " (recommended)" : ""}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Language</span>
            <select name="language" defaultValue={a.language} className={fieldCls}>
              {Object.entries(options.languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Conversation style</span>
            <select name="conversationStyle" defaultValue={a.conversation_style} className={clsx(fieldCls, "capitalize")}>
              {options.styles.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <Input
            name="maxMinutes"
            label="Maximum call length (minutes)"
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            required
            defaultValue={String(a.max_call_duration_sec / 60)}
            error={errors.maxMinutes}
            hint="The call is ended automatically after this. Max 60."
          />
        </div>
        <label className="block space-y-1.5">
          <span className="flex justify-between text-sm font-medium">Speaking speed <span className="tabular-nums text-muted">{speed.toFixed(2)}×</span></span>
          <input type="range" min={0.5} max={1.5} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-[var(--primary)]" aria-label="Speaking speed" />
          <span className="flex justify-between text-xs text-muted"><span>Slower</span><span>Normal</span><span>Faster</span></span>
        </label>
        <TextArea name="conversationRules" label="Conversation rules (optional)" rows={3} maxLength={4000} defaultValue={a.conversation_rules} hint="Things it must or must not do, e.g. “Never quote prices.”" />
        <TextArea name="callEndingInstructions" label="How to end the call (optional)" rows={2} maxLength={2000} defaultValue={a.call_ending_instructions} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={a.is_active} className="size-4 accent-[var(--primary)]" />
          Active (available for calls and campaigns)
        </label>
        <Alert tone="info">Always added, whatever you write here: the AI says it&apos;s an AI, honours “don&apos;t call me” requests, keeps voicemail short, and never asks for card, bank or ID details.</Alert>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2 border-t border-border pt-4">
          <Button type="submit" loading={saving}>{agent ? "Save changes" : "Create Agent"}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Drawer>
  );
}
