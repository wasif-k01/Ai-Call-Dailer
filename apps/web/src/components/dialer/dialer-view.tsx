"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Call as TwilioCall } from "@twilio/voice-sdk";
import { AsYouType, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { Bot, Delete, Grid3x3, Mic, MicOff, Pause, Phone, PhoneOff, Play, Search, User } from "lucide-react";
import { api, ApiError, formatDuration } from "@/lib/api";
import { countries, flagOf } from "@/lib/countries";
import { useRealtime, type RealtimeEvent } from "@/lib/realtime";
import { Alert, Badge, Button, Card, PageHeader } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";
import { explainSdkError, useTwilioDevice } from "@/components/dialer/use-twilio-device";

type Mode = "human" | "ai";
interface CallView {
  id: string;
  mode: Mode;
  status: "initiated" | "queued" | "ringing" | "in_progress" | "completed" | "busy" | "no_answer" | "failed" | "canceled";
  to_number: string;
  from_number: string;
  answered_at: string | null;
  duration_sec: number | null;
  error_message: string | null;
  on_hold: boolean | null;
}
interface NumberOption {
  id: string;
  e164: string;
  friendly_name: string | null;
  country_iso: string | null;
  number_type: string;
  status: string;
  is_default: boolean;
  capabilities: { voice?: boolean };
}
interface AgentOption {
  id: string;
  name: string;
  description: string | null;
  voice: string;
  is_active: boolean;
  max_call_duration_sec: number;
}
interface Segment {
  speaker: "ai" | "caller" | "agent" | "system";
  text: string;
}
interface ContactHit {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string;
  company: string | null;
}

const TERMINAL = ["completed", "busy", "no_answer", "failed", "canceled"];
const STATUS_LABEL: Record<CallView["status"], string> = {
  initiated: "Starting…",
  queued: "Connecting…",
  ringing: "Ringing…",
  in_progress: "Connected",
  completed: "Call ended",
  busy: "Busy",
  no_answer: "No answer",
  failed: "Call failed",
  canceled: "Call canceled",
};
const KEYS = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
] as const;

const selectCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export default function DialerView({ initialMode = "human" }: { initialMode?: Mode }) {
  const session = useSession();
  const allowed = can(session, "calls:make");
  const [mode, setMode] = useState<Mode>(initialMode);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [aiNotes, setAiNotes] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [country, setCountry] = useState<CountryCode>("AE");
  const [raw, setRaw] = useState("");
  const [numbers, setNumbers] = useState<NumberOption[] | null>(null);
  const [fromId, setFromId] = useState<string>("");
  const [call, setCall] = useState<CallView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [hasMedia, setHasMedia] = useState(false); // browser audio leg connected
  const [now, setNow] = useState(() => Date.now());
  const twilioCall = useRef<TwilioCall | null>(null);
  const dtmfBuffer = useRef("");
  const dtmfTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const device = useTwilioDevice();
  const currentCallId = useRef<string | null>(null);
  useEffect(() => {
    currentCallId.current = call?.id ?? null;
  }, [call?.id]);

  const active = !!call && !TERMINAL.includes(call.status);
  const allCountries = useMemo(() => countries(), []);

  // Caller IDs that Twilio will actually accept.
  useEffect(() => {
    api<{ numbers: NumberOption[] }>("/phone-numbers")
      .then((r) => {
        const usable = r.numbers.filter(
          (n) => n.status === "active" && ["provider_owned", "verified_caller_id"].includes(n.number_type) && n.capabilities.voice,
        );
        setNumbers(usable);
        setFromId((usable.find((n) => n.is_default) ?? usable[0])?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);

  // AI agents for AI-to-Human mode.
  useEffect(() => {
    if (mode !== "ai" || agents) return;
    api<{ agents: AgentOption[] }>("/agents")
      .then((r) => {
        setAgents(r.agents);
        setAgentId(r.agents.find((a) => a.is_active)?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, [mode, agents]);

  // Parse what was typed: "+…" overrides the country selector.
  const parsed = useMemo(() => {
    const value = raw.trim();
    if (!value) return null;
    const p = parsePhoneNumberFromString(value, value.startsWith("+") ? undefined : country);
    return p ? { e164: p.number, valid: p.isValid(), country: p.country } : { e164: "", valid: false, country: undefined };
  }, [raw, country]);
  const formatted = useMemo(() => (raw ? new AsYouType(raw.startsWith("+") ? undefined : country).input(raw) : ""), [raw, country]);

  /** Typing "+971…" switches the country selector to match. */
  function onNumberInput(value: string) {
    const clean = value.replace(/[^\d+]/g, "");
    setRaw(clean);
    if (clean.startsWith("+")) {
      const c = parsePhoneNumberFromString(clean)?.country;
      if (c && c !== country) setCountry(c);
    }
  }

  // Live status: WebSocket events, with polling as a safety net.
  const refreshCall = useCallback(async (id: string) => {
    try {
      const r = await api<{ call: CallView }>(`/calls/${id}`);
      setCall((c) => (c?.id === r.call.id ? r.call : c));
    } catch {
      /* transient */
    }
  }, []);
  const { connected: live } = useRealtime((e: RealtimeEvent) => {
    if (e.type === "transcript.segment") {
      const d = e.data as { callId: string; speaker: Segment["speaker"]; text: string };
      if (currentCallId.current === d.callId) setSegments((prev) => [...prev, { speaker: d.speaker, text: d.text }]);
      return;
    }
    if (e.type !== "call.updated") return;
    const data = e.data as unknown as CallView;
    setCall((c) => (c && c.id === data.id ? data : c));
  });
  useEffect(() => {
    if (!active || !call) return;
    const t = setInterval(() => refreshCall(call.id), live ? 10_000 : 2_500);
    return () => clearInterval(t);
  }, [active, call, live, refreshCall]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // When the call ends on the server, make sure the browser side is closed too.
  useEffect(() => {
    if (call && TERMINAL.includes(call.status) && twilioCall.current) {
      twilioCall.current.disconnect();
      twilioCall.current = null;
      setShowKeypad(false);
    }
  }, [call]);

  async function startCall() {
    if (!parsed?.valid) return setError("Enter a valid phone number first.");
    setBusy(true);
    setError(null);
    setMuted(false);
    setSegments([]);
    device.setError(null);
    if (mode === "ai") {
      try {
        const r = await api<{ call: CallView }>("/calls/ai", {
          method: "POST",
          json: {
            to: parsed.e164,
            defaultCountry: country,
            fromNumberId: fromId || undefined,
            agentId,
            instructions: aiNotes.trim() || undefined,
            idempotencyKey: crypto.randomUUID(),
          },
        });
        setCall(r.call);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      // Fetch the browser token first, so setup problems are reported before a call record exists.
      await device.ensureDevice();
      const r = await api<{ call: CallView }>("/calls/human", {
        method: "POST",
        json: { to: parsed.e164, defaultCountry: country, fromNumberId: fromId || undefined, idempotencyKey: crypto.randomUUID() },
      });
      setCall(r.call);
      const c = await device.connect(r.call.id);
      twilioCall.current = c;
      setHasMedia(true);
      c.on("disconnect", () => {
        twilioCall.current = null;
        setHasMedia(false);
        setTimeout(() => refreshCall(r.call.id), 800);
      });
      c.on("cancel", () => refreshCall(r.call.id));
      c.on("error", (e: { code?: number; message?: string }) => setError(explainSdkError(e)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : explainSdkError(err as { code?: number; message?: string }));
    } finally {
      setBusy(false);
    }
  }

  async function hangUp() {
    twilioCall.current?.disconnect();
    if (call) await api(`/calls/${call.id}/hangup`, { method: "POST" }).catch(() => {});
    if (call) setTimeout(() => refreshCall(call.id), 600);
  }

  function toggleMute() {
    if (!twilioCall.current) return;
    const next = !muted;
    twilioCall.current.mute(next);
    setMuted(next);
  }

  async function toggleHold() {
    if (!call) return;
    try {
      const r = await api<{ onHold: boolean }>(`/calls/${call.id}/hold`, { method: "POST", json: { hold: !call.on_hold } });
      setCall({ ...call, on_hold: r.onHold });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Keypad: while idle it types the number; during a call it sends tones (batched briefly). */
  function pressKey(k: string) {
    if (!active) return setRaw((v) => v + k);
    if (!call || call.status !== "in_progress") return;
    dtmfBuffer.current += k;
    clearTimeout(dtmfTimer.current);
    dtmfTimer.current = setTimeout(async () => {
      const digits = dtmfBuffer.current;
      dtmfBuffer.current = "";
      try {
        await api(`/calls/${call.id}/dtmf`, { method: "POST", json: { digits } });
      } catch (e) {
        setError((e as Error).message);
      }
    }, 700);
  }

  if (!allowed) return <Alert>Your role can view calls but not make them. Ask an owner or admin for access.</Alert>;

  const answeredFor = call?.answered_at ? (now - new Date(call.answered_at).getTime()) / 1000 : 0;
  const shownError = error ?? device.error;

  return (
    <>
      <PageHeader title={initialMode === "ai" ? "AI Calling" : "Dialer"} description="Call any number from your browser, or let an AI agent make the call." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <Card className="space-y-5">
          {/* Mode selector */}
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Calling mode">
            {([["human", "Human-to-Human", User], ["ai", "AI-to-Human", Bot]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                disabled={active}
                onClick={() => setMode(m)}
                className={clsx(
                  "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed",
                  mode === m ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
                )}
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>

          {mode === "ai" && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">AI agent</span>
                <select className={selectCls} value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={active || !agents}>
                  {agents?.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.is_active}>
                      {a.name} · voice {a.voice}{a.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted">Edit agents on the <Link className="text-primary hover:underline" href="/agents">AI Agents</Link> page.</span>
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Extra instructions for this call (optional)</span>
                <textarea
                  value={aiNotes}
                  onChange={(e) => setAiNotes(e.target.value)}
                  disabled={active}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. Confirm their appointment for Tuesday at 3pm."
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              <p className="text-xs text-muted">The AI always says it is an AI, and adds the person to your Do Not Call list if they ask.</p>
            </div>
          )}

          {/* Caller ID */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Call from (caller ID)</span>
            {numbers && numbers.length === 0 ? (
              <p className="text-sm text-muted">
                No usable caller ID. <Link className="text-primary hover:underline" href="/phone-numbers">Set one up on Phone Numbers</Link>.
              </p>
            ) : (
              <select className={selectCls} value={fromId} onChange={(e) => setFromId(e.target.value)} disabled={active || !numbers}>
                {numbers?.map((n) => (
                  <option key={n.id} value={n.id}>
                    {flagOf(n.country_iso ?? "")} {n.e164}
                    {n.is_default ? " (default)" : ""}
                    {n.number_type === "verified_caller_id" ? " · verified caller ID" : ""}
                  </option>
                ))}
              </select>
            )}
          </label>

          {/* Destination */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Number to call</span>
            <select
              aria-label="Country"
              className={selectCls}
              value={country}
              disabled={active}
              onChange={(e) => setCountry(e.target.value as CountryCode)}
            >
              {allCountries.map((c) => (
                <option key={c.iso} value={c.iso}>{c.flag} {c.dialCode} {c.name}</option>
              ))}
            </select>
            <div className="flex items-center rounded-lg border border-border bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <span className="select-none pl-3 font-mono text-lg text-muted">
                {raw.startsWith("+") ? "" : allCountries.find((c) => c.iso === country)?.dialCode}
              </span>
              <input
                aria-label="Phone number"
                inputMode="tel"
                autoComplete="off"
                value={formatted}
                disabled={active}
                onChange={(e) => onNumberInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !active && startCall()}
                placeholder="50 123 4567"
                className="w-full min-w-0 bg-transparent px-2 py-2.5 font-mono text-lg tracking-wide outline-none"
              />
            </div>
            <p className={clsx("text-xs", parsed && !parsed.valid ? "text-danger" : "text-muted")}>
              {parsed ? (parsed.valid ? `Will dial ${parsed.e164}` : "Not a valid number for this country yet") : "Type a local number, or start with + for any country."}
            </p>
          </div>

          <ContactSearch disabled={active} onPick={onNumberInput} />

          {/* Keypad */}
          {(!active || (showKeypad && call?.mode === "human")) && <Keypad onKey={pressKey} onBackspace={() => !active && setRaw((v) => v.slice(0, -1))} inCall={active} />}

          {!active ? (
            <Button
              className="w-full py-3 text-base"
              onClick={startCall}
              loading={busy}
              disabled={!parsed?.valid || !fromId || (mode === "ai" && !agentId)}
            >
              {mode === "ai" ? <Bot className="size-5" /> : <Phone className="size-5" />} {mode === "ai" ? "Start AI Call" : "Call"}
            </Button>
          ) : (
            <Button variant="danger" className="w-full py-3 text-base" onClick={hangUp}>
              <PhoneOff className="size-5" /> Hang Up
            </Button>
          )}
          {shownError && <Alert>{shownError}</Alert>}
        </Card>

        {/* Call panel */}
        <Card className="flex min-h-80 flex-col">
          {!call ? (
            <div className="m-auto max-w-sm text-center text-sm text-muted">
              <Phone className="mx-auto mb-3 size-8" />
              <p className="font-medium text-text">Ready to call</p>
              <p className="mt-1">
                {mode === "ai"
                  ? "The AI agent will call the number from your caller ID. You'll see the live transcript here."
                  : "Your browser will ask for microphone access the first time you call. Use headphones for the best sound."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <Badge tone={call.status === "in_progress" ? "success" : TERMINAL.includes(call.status) ? (call.status === "completed" ? "neutral" : "danger") : "info"}>
                  {call.on_hold && call.status === "in_progress" ? "On hold" : STATUS_LABEL[call.status]}
                </Badge>
                <span className="text-xs text-muted">{live ? "Live updates on" : "Updating…"}</span>
              </div>
              <div className="my-8 text-center">
                <div className="text-3xl font-semibold tracking-wide">{call.to_number}</div>
                <div className="mt-1 text-sm text-muted">from {call.from_number}{call.mode === "ai" ? " · AI call" : ""}</div>
                <div className="mt-6 font-mono text-4xl tabular-nums">
                  {call.status === "in_progress" ? formatClock(answeredFor) : call.duration_sec != null ? formatDuration(call.duration_sec) : "--:--"}
                </div>
              </div>
              {call.error_message && <Alert>{call.error_message}</Alert>}
              {call.mode === "ai" && <Transcript segments={segments} callId={call.id} />}
              {active && call.mode === "ai" && (
                <p className="mt-auto text-center text-xs text-muted">
                  The AI handles this call on the server, so Mute, Hold and Keypad don&apos;t apply. Use Hang Up to end it at any time.
                </p>
              )}
              {active && call.mode === "human" && (
                <div className="mt-auto grid grid-cols-3 gap-3">
                  <ControlButton onClick={toggleMute} active={muted} disabled={!hasMedia} icon={muted ? MicOff : Mic} label={muted ? "Unmute" : "Mute"} />
                  <ControlButton
                    onClick={toggleHold}
                    active={!!call.on_hold}
                    disabled={call.status !== "in_progress"}
                    icon={call.on_hold ? Play : Pause}
                    label={call.on_hold ? "Resume" : "Hold"}
                  />
                  <ControlButton onClick={() => setShowKeypad(!showKeypad)} active={showKeypad} disabled={call.status !== "in_progress"} icon={Grid3x3} label="Keypad" />
                </div>
              )}
              {!active && (
                <Button variant="secondary" className="mt-auto" onClick={() => setCall(null)}>New call</Button>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function ControlButton({ onClick, active, disabled, icon: Icon, label }: { onClick: () => void; active: boolean; disabled?: boolean; icon: typeof Mic; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx(
        "flex flex-col items-center gap-1 rounded-xl border px-3 py-3 text-sm transition disabled:cursor-not-allowed disabled:opacity-40",
        active ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-surface-2",
      )}
    >
      <Icon className="size-5" /> {label}
    </button>
  );
}

function Keypad({ onKey, onBackspace, inCall }: { onKey: (k: string) => void; onBackspace: () => void; inCall: boolean }) {
  return (
    <div>
      {inCall && <p className="mb-2 text-center text-xs text-muted">Key presses are sent to the other side (e.g. to choose a menu option).</p>}
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map(([k, sub]) => (
          <button
            key={k}
            onClick={() => onKey(k)}
            className="flex h-14 flex-col items-center justify-center rounded-xl bg-surface-2 transition hover:brightness-95 active:scale-95"
            aria-label={`Key ${k}`}
          >
            <span className="text-xl font-medium">{k}</span>
            {sub && <span className="text-[10px] tracking-widest text-muted">{sub}</span>}
          </button>
        ))}
      </div>
      {!inCall && (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" onClick={onBackspace} aria-label="Delete last digit"><Delete className="size-4" /></Button>
        </div>
      )}
    </div>
  );
}

function ContactSearch({ onPick, disabled }: { onPick: (e164: string) => void; disabled: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return; // results are hidden below 2 characters
    const t = setTimeout(() => {
      api<{ contacts: ContactHit[] }>(`/contacts/search?q=${encodeURIComponent(q)}`).then((r) => setHits(r.contacts)).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
      <input
        aria-label="Search contacts"
        value={q}
        disabled={disabled}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search contacts by name or number"
        className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      {q.trim().length >= 2 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No matching contacts. Contacts can be imported in Bulk Campaigns (Phase 6).</li>
          ) : (
            hits.map((h) => (
              <li key={h.id}>
                <button className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => (onPick(h.phone_e164), setQ(""))}>
                  <span>{[h.first_name, h.last_name].filter(Boolean).join(" ") || h.company || "Unnamed"}</span>
                  <span className="font-mono text-muted">{h.phone_e164}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function Transcript({ segments, callId }: { segments: Segment[]; callId: string }) {
  const [initial, setInitial] = useState<Segment[]>([]);
  const end = useRef<HTMLDivElement>(null);
  // Catch up on anything said before this page subscribed (or after a reload).
  useEffect(() => {
    api<{ segments: Segment[] }>(`/calls/${callId}/transcript`).then((r) => setInitial(r.segments)).catch(() => {});
  }, [callId]);
  const all = segments.length >= initial.length ? segments : initial;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [all.length]);
  return (
    <div className="mb-4 max-h-72 space-y-2 overflow-y-auto rounded-lg bg-surface-2 p-3 text-sm" aria-live="polite">
      {all.length === 0 ? (
        <p className="text-muted">The live transcript will appear here once the call is answered.</p>
      ) : (
        all.map((s, i) => (
          <div key={i} className={clsx("flex", s.speaker === "ai" ? "justify-start" : "justify-end")}>
            <div className={clsx("max-w-[85%] rounded-lg px-3 py-1.5", s.speaker === "ai" ? "bg-primary/15" : "bg-surface")}>
              <span className="mr-1 text-xs font-medium text-muted">{s.speaker === "ai" ? "AI" : "Them"}:</span>
              {s.text}
            </div>
          </div>
        ))
      )}
      <div ref={end} />
    </div>
  );
}
