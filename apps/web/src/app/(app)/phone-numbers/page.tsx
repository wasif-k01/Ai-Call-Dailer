"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Globe2, PhoneCall, Plus, RefreshCw, Star, Trash2, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";

interface PhoneNumber {
  id: string;
  provider: string;
  number_type: "provider_owned" | "verified_caller_id" | "external" | "sip_endpoint";
  e164: string;
  friendly_name: string | null;
  country_iso: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  status: "active" | "unverified" | "released" | "error";
  is_default: boolean;
}

interface GeoPermission {
  isoCode: string;
  name: string;
  countryCodes: string[];
  lowRiskNumbersEnabled: boolean;
  highRiskSpecialNumbersEnabled: boolean;
  highRiskTollfraudNumbersEnabled: boolean;
}

const TYPE_INFO: Record<PhoneNumber["number_type"], { label: string; explain: string }> = {
  provider_owned: { label: "Twilio number", explain: "Bought in your Twilio account. Can be used as caller ID and receive calls." },
  verified_caller_id: { label: "Verified caller ID", explain: "A number you own elsewhere that Twilio verified. Can be shown as caller ID, but calls to it don't come into Twilio." },
  external: { label: "External number", explain: "Not verified in Twilio, so it can't be used as caller ID yet." },
  sip_endpoint: { label: "SIP endpoint", explain: "A SIP address, not a phone number. Not usable as caller ID." },
};

const DEFAULT_COUNTRIES = ["US", "AE", "GB", "PK"];
const flag = (iso: string | null) =>
  iso && /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🌐";

export default function PhoneNumbersPage() {
  const session = useSession();
  const manage = can(session, "numbers:manage");
  const [numbers, setNumbers] = useState<PhoneNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ numbers: PhoneNumber[] }>("/phone-numbers")
      .then((r) => setNumbers(r.numbers))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<string>) {
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

  const refresh = () =>
    run("refresh", async () => {
      const r = await api<{ count: number }>("/phone-numbers/sync", { method: "POST" });
      return `Refreshed from Twilio: ${r.count} number(s) found.`;
    });
  const makeDefault = (n: PhoneNumber) =>
    run(`default-${n.id}`, async () => {
      await api(`/phone-numbers/${n.id}/default`, { method: "POST" });
      return `${n.e164} is now the default outbound caller ID.`;
    });
  const remove = (n: PhoneNumber) =>
    run(`remove-${n.id}`, async () => {
      await api(`/phone-numbers/${n.id}`, { method: "DELETE" });
      return `${n.e164} removed from the list.`;
    });

  if (error) return <Alert>{error}</Alert>;
  if (!numbers) return <Spinner />;
  const twilioConnected = numbers.some((n) => n.provider === "twilio");

  return (
    <>
      <PageHeader
        title="Phone Numbers"
        description="The numbers you call from. The default number is used as caller ID unless you pick another in the Dialer."
        actions={manage && <Button variant="secondary" onClick={refresh} loading={busy === "refresh"}><RefreshCw className="size-4" /> Refresh from Twilio</Button>}
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {numbers.length === 0 ? (
        <EmptyState
          icon={<PhoneCall className="size-8" />}
          title="No numbers yet"
          description="Connect Twilio in Integrations & API Settings. Your existing Twilio numbers will appear here automatically."
          action={<Link href="/integrations"><Button>Connect Twilio</Button></Link>}
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Can do</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => {
                const usable = n.status === "active" && ["provider_owned", "verified_caller_id"].includes(n.number_type) && n.capabilities.voice;
                return (
                  <tr key={n.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-mono">
                        {n.e164}
                        {n.is_default && <Badge tone="info"><Star className="mr-1 size-3" />Default</Badge>}
                      </div>
                      {n.friendly_name && n.friendly_name !== n.e164 && <div className="text-xs text-muted">{n.friendly_name}</div>}
                    </td>
                    <td className="px-4 py-3">{flag(n.country_iso)} {n.country_iso ?? "—"}</td>
                    <td className="px-4 py-3" title={TYPE_INFO[n.number_type].explain}>{TYPE_INFO[n.number_type].label}</td>
                    <td className="px-4 py-3 text-muted">
                      {[n.capabilities.voice && "Voice", n.capabilities.sms && "SMS", n.capabilities.mms && "MMS"].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={n.status === "active" ? "success" : n.status === "released" ? "neutral" : "warning"}>
                        {n.status === "active" ? "Connected" : n.status === "released" ? "No longer in Twilio" : n.status === "unverified" ? "Not verified" : "Error"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {manage && !n.is_default && usable && (
                        <Button variant="ghost" onClick={() => makeDefault(n)} loading={busy === `default-${n.id}`}>Make default</Button>
                      )}
                      {manage && !n.is_default && !(n.number_type === "provider_owned" && n.status === "active") && (
                        <Button variant="ghost" onClick={() => remove(n)} loading={busy === `remove-${n.id}`} aria-label={`Remove ${n.e164}`}><Trash2 className="size-4" /></Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Destinations enabled={twilioConnected} />
        <div className="space-y-6">
          {manage && <AddNumber onAdded={load} />}
          <Card>
            <h2 className="mb-2 font-semibold">Adding another Twilio number</h2>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>In the Twilio Console go to <strong>Phone Numbers → Buy a number</strong> and buy it there (you’re billed by Twilio).</li>
              <li>Come back here and click <strong>Refresh from Twilio</strong>.</li>
            </ol>
            <p className="mt-3 text-sm text-muted">
              To show a number you already own (e.g. your mobile) as caller ID, verify it in Twilio under <strong>Phone Numbers → Verified Caller IDs</strong>, then Refresh.
              It will appear as a “Verified caller ID”.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Destinations({ enabled }: { enabled: boolean }) {
  const [countries, setCountries] = useState(DEFAULT_COUNTRIES.join(", "));
  const [result, setResult] = useState<{ permissions: GeoPermission[]; accountType: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function check(e?: FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const q = countries.split(/[,\s]+/).filter(Boolean).join(",");
      setResult(await api(`/phone-numbers/destinations?countries=${encodeURIComponent(q)}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Globe2 className="size-5 text-muted" />
        <h2 className="font-semibold">Calling destinations</h2>
      </div>
      <p className="mb-4 text-sm text-muted">
        Twilio only lets you call countries that are switched on under <strong>Voice → Settings → Geo permissions</strong>. This checks your real account settings.
      </p>
      <form onSubmit={check} className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Input name="countries" label="Country codes" value={countries} onChange={(e) => setCountries(e.target.value)} hint="Two-letter codes, e.g. US, AE, GB, PK, SA, IN" />
        </div>
        <Button type="submit" loading={loading} disabled={!enabled} className="mb-5">Check permissions</Button>
      </form>
      {!enabled && <p className="text-sm text-muted">Connect Twilio first.</p>}
      {error && <Alert>{error}</Alert>}
      {result && (
        <div className="space-y-3">
          {result.accountType === "Trial" && (
            <Alert tone="warning">Your Twilio account is a trial: you can only call numbers verified in Twilio, even in allowed countries.</Alert>
          )}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {result.permissions.map((p) => (
              <li key={p.isoCode} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>{flag(p.isoCode)} {p.name} <span className="text-muted">({p.countryCodes.join(", ")})</span></span>
                {p.lowRiskNumbersEnabled ? (
                  <span className="flex items-center gap-1 text-success"><CheckCircle2 className="size-4" /> Allowed</span>
                ) : (
                  <span className="flex items-center gap-1 text-danger"><XCircle className="size-4" /> Blocked</span>
                )}
              </li>
            ))}
          </ul>
          {result.permissions.some((p) => !p.lowRiskNumbersEnabled) && (
            <p className="text-sm text-muted">
              To allow a blocked country: Twilio Console → <strong>Voice → Settings → Geo permissions</strong> → tick the country → Save. Then check again here.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function AddNumber({ onAdded }: { onAdded: () => void }) {
  const [type, setType] = useState<"external" | "sip_endpoint">("external");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setLoading(true);
    setError(null);
    try {
      await api("/phone-numbers", { method: "POST", json: { numberType: type, value: fd.get("value"), friendlyName: fd.get("friendlyName") || undefined } });
      form.reset();
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError && err.fields?.[0] ? err.fields[0].message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Add a non-Twilio number or SIP endpoint</h2>
      <p className="mb-4 text-sm text-muted">For reference only. These can’t be used as caller ID until verified in Twilio.</p>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-2" role="radiogroup">
          {(["external", "sip_endpoint"] as const).map((t) => (
            <Button key={t} type="button" variant={type === t ? "primary" : "secondary"} onClick={() => setType(t)} aria-pressed={type === t}>
              {t === "external" ? "External number" : "SIP endpoint"}
            </Button>
          ))}
        </div>
        <Input name="value" label={type === "external" ? "Phone number" : "SIP address"} required placeholder={type === "external" ? "+971501234567" : "sip:agent@example.com"} />
        <Input name="friendlyName" label="Label (optional)" placeholder="e.g. Dubai office" />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="secondary" loading={loading}><Plus className="size-4" /> Add</Button>
      </form>
    </Card>
  );
}
