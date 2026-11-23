"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Bot, Database, Phone, Server, Plug } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Card, Input } from "@/components/ui";
import { SecretInput } from "./secret-input";
import { StatusBadge } from "./status-badge";
import type { Integration, IntegrationsResponse, Status } from "./types";

type Msg = { tone: "success" | "danger"; text: string } | null;

function CardShell({ icon, title, subtitle, status, children }: { icon: ReactNode; title: string; subtitle: string; status: Status; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-surface-2 text-muted">{icon}</div>
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="text-sm text-muted">{subtitle}</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
      {children}
    </Card>
  );
}

/** Save / Test / Disconnect behaviour shared by the OpenAI and Twilio cards. */
function useIntegrationActions(provider: "openai" | "twilio", onChange: () => void) {
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>, toBody: (fd: FormData) => Record<string, unknown>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy("save");
    setMsg(null);
    setFieldErrors({});
    try {
      await api(`/integrations/${provider}`, { method: "PUT", json: toBody(new FormData(form)) });
      form.querySelectorAll<HTMLInputElement>("input[type=password], input[data-secret]").forEach((i) => (i.value = ""));
      setMsg({ tone: "success", text: "Saved. Now click Test Connection to verify it." });
      onChange();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFieldErrors(Object.fromEntries(err.fields.map((f) => [f.path, f.message])));
      setMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setTesting(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; message: string }>(`/integrations/${provider}/test`, { method: "POST" });
      setMsg({ tone: r.ok ? "success" : "danger", text: r.message });
    } catch (err) {
      setMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy(null);
      setTesting(false);
      onChange();
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      await api(`/integrations/${provider}`, { method: "DELETE" });
      setMsg({ tone: "success", text: "Disconnected. Saved credentials were deleted." });
      onChange();
    } catch (err) {
      setMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return { busy, msg, fieldErrors, testing, save, test, disconnect };
}

function Actions({ integ, a }: { integ: Integration; a: ReturnType<typeof useIntegrationActions> }) {
  const [confirming, setConfirming] = useState(false);
  const hasSaved = Object.keys(integ.secrets).length > 0;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button type="submit" loading={a.busy === "save"}>{hasSaved ? "Update Configuration" : "Save Configuration"}</Button>
      <Button type="button" variant="secondary" onClick={a.test} loading={a.busy === "test"} disabled={!hasSaved}>Test Connection</Button>
      {hasSaved &&
        (confirming ? (
          <>
            <Button type="button" variant="danger" onClick={() => (setConfirming(false), a.disconnect())} loading={a.busy === "disconnect"}>Yes, disconnect</Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>Disconnect</Button>
        ))}
    </div>
  );
}

function Footer({ integ, msg }: { integ: Integration; msg: Msg }) {
  return (
    <div className="mt-4 space-y-2">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!msg && integ.status === "error" && integ.lastError && <Alert>{integ.lastError}</Alert>}
      {integ.lastTestedAt && <p className="text-xs text-muted">Last tested {new Date(integ.lastTestedAt).toLocaleString()}</p>}
    </div>
  );
}

const selectCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export function OpenAICard({ data, onChange }: { data: IntegrationsResponse; onChange: () => void }) {
  const integ = data.openai;
  const a = useIntegrationActions("openai", onChange);
  const raw = integ.config.availableRealtimeModels;
  const available: string[] | null = Array.isArray(raw) ? raw : null;
  return (
    <CardShell icon={<Bot className="size-5" />} title="OpenAI" subtitle="Powers the AI voice on AI calls." status={a.testing ? "testing" : integ.status}>
      <form
        className="space-y-4"
        onSubmit={(e) =>
          a.save(e, (fd) => ({
            apiKey: (fd.get("apiKey") as string) || undefined,
            projectId: (fd.get("projectId") as string) || "",
            model: fd.get("model"),
            voice: fd.get("voice"),
          }))
        }
      >
        <SecretInput name="apiKey" label="API Key" saved={integ.secrets.api_key} hint="platform.openai.com → API keys → Create new secret key" error={a.fieldErrors.apiKey} />
        <Input name="projectId" label="Project ID (optional)" defaultValue={integ.config.projectId ?? ""} placeholder="proj_…" hint="Only needed if your key belongs to several projects." error={a.fieldErrors.projectId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Realtime Model</span>
            <select name="model" defaultValue={integ.config.model ?? data.options.realtimeModels[0]} className={selectCls}>
              {data.options.realtimeModels.map((m) => (
                <option key={m} value={m}>{m}{available && !available.includes(m) ? " (not available on this key)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Default Voice</span>
            <select name="voice" defaultValue={integ.config.voice ?? "marin"} className={selectCls}>
              {data.options.voices.map((v) => (
                <option key={v} value={v}>{v}{v === "marin" || v === "cedar" ? " (recommended)" : ""}</option>
              ))}
            </select>
          </label>
        </div>
        <Actions integ={integ} a={a} />
      </form>
      <Footer integ={integ} msg={a.msg} />
    </CardShell>
  );
}

export function TwilioCard({ data, onChange }: { data: IntegrationsResponse; onChange: () => void }) {
  const integ = data.twilio;
  const a = useIntegrationActions("twilio", onChange);
  return (
    <CardShell icon={<Phone className="size-5" />} title="Twilio" subtitle="Places the phone calls using your Twilio number." status={a.testing ? "testing" : integ.status}>
      {integ.status === "connected" && integ.config.accountName && (
        <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          Account: <strong>{integ.config.accountName}</strong> · {integ.config.accountType === "Trial" ? "Trial account" : "Full account"}
          {integ.config.accountType === "Trial" && (
            <p className="mt-1 text-warning">Trial accounts can only call numbers you have verified in Twilio. Upgrade in the Twilio Console to call anyone.</p>
          )}
        </div>
      )}
      <form
        className="space-y-4"
        onSubmit={(e) =>
          a.save(e, (fd) => ({
            accountSid: fd.get("accountSid"),
            authToken: (fd.get("authToken") as string) || undefined,
            apiKeySid: (fd.get("apiKeySid") as string) || "",
            apiKeySecret: (fd.get("apiKeySecret") as string) || undefined,
            twimlAppSid: (fd.get("twimlAppSid") as string) || "",
          }))
        }
      >
        <Input name="accountSid" label="Account SID" required defaultValue={integ.config.accountSid ?? ""} placeholder="AC…" className="font-mono" hint="console.twilio.com → Account Info" error={a.fieldErrors.accountSid} />
        <SecretInput name="authToken" label="Auth Token" saved={integ.secrets.auth_token} hint="Click “Show” next to Auth Token in the Twilio Console" error={a.fieldErrors.authToken} />
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Browser calling settings (needed in Phase 3)</summary>
          <div className="mt-3 space-y-4">
            <Input name="apiKeySid" label="API Key SID (optional)" defaultValue={integ.config.apiKeySid ?? ""} placeholder="SK…" className="font-mono" hint="Account → API keys & tokens → Create API key (Standard)" error={a.fieldErrors.apiKeySid} />
            <SecretInput name="apiKeySecret" label="API Key Secret (optional)" saved={integ.secrets.api_key_secret} hint="Shown only once when you create the key" error={a.fieldErrors.apiKeySecret} />
            <Input name="twimlAppSid" label="TwiML App SID (optional)" defaultValue={integ.config.twimlAppSid ?? ""} placeholder="AP…" className="font-mono" hint="Leave empty: the app will create this for you in Phase 3." error={a.fieldErrors.twimlAppSid} />
          </div>
        </details>
        <Actions integ={integ} a={a} />
      </form>
      <Footer integ={integ} msg={a.msg} />
    </CardShell>
  );
}

export function InfraCards({ data }: { data: IntegrationsResponse }) {
  return (
    <>
      <CardShell icon={<Database className="size-5" />} title="Database" subtitle={data.database.kind} status={data.database.status}>
        <p className="text-sm text-muted">
          {data.database.host === "local" ? "Running on this computer's PostgreSQL. " : ""}
          The database connection is set on the server (environment variables), not on this page, because the app needs the database to load this page at all.
          In production it points to Supabase. See DEPLOYMENT.md.
        </p>
      </CardShell>
      <CardShell icon={<Server className="size-5" />} title="Redis (job queue)" subtitle="Runs bulk campaigns and live updates in the background." status={data.redis.status}>
        <p className="text-sm text-muted">
          Set on the server (REDIS_URL). In production this is the Redis database inside your Railway project.
          {data.redis.status !== "connected" && " It isn't reachable right now, so bulk calling and live updates won't work until it is."}
        </p>
      </CardShell>
      <CardShell icon={<Plug className="size-5" />} title="Additional providers" subtitle="Other telephony providers" status="not_connected">
        <p className="text-sm text-muted">Twilio is the only telephony provider so far. The backend is organised so another provider can be added later as its own card here.</p>
      </CardShell>
    </>
  );
}
