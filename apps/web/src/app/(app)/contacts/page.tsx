"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Ban, Contact, Plus, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string;
  email: string | null;
  company: string | null;
  consent_status: "unknown" | "granted" | "revoked";
  consent_source: string | null;
  notes: string | null;
  on_dnc: boolean;
  call_count: number;
}
interface DncRow {
  id: string;
  phone_e164: string;
  reason: string | null;
  source: string;
  created_at: string;
  added_by: string | null;
}

const fieldCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
const CONSENT = { unknown: ["neutral", "Unknown"], granted: ["success", "Consent given"], revoked: ["danger", "Revoked"] } as const;
const SOURCE: Record<string, string> = { manual: "Added manually", opt_out_during_call: "Asked during an AI call", import: "Imported", api: "API" };

export default function ContactsPage() {
  const [tab, setTab] = useState<"contacts" | "dnc">("contacts");
  return (
    <>
      <PageHeader title="Contacts" description="Everyone you've called or imported, plus the Do Not Call list." />
      <div className="mb-4 flex gap-1 rounded-lg bg-surface-2 p-1 sm:w-fit" role="tablist">
        {([["contacts", "Contacts"], ["dnc", "Do Not Call list"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={clsx("rounded-md px-4 py-1.5 text-sm font-medium", tab === k ? "bg-surface shadow-sm" : "text-muted hover:text-text")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "contacts" ? <ContactsTab /> : <DncTab />}
    </>
  );
}

function ContactsTab() {
  const session = useSession();
  const manage = can(session, "contacts:manage");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ contacts: ContactRow[]; total: number } | null>(null);
  const [editing, setEditing] = useState<ContactRow | "new" | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ contacts: ContactRow[]; total: number }>(`/contacts?q=${encodeURIComponent(q)}&page=${page}&pageSize=25`)
      .then(setData)
      .catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, [q, page]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function remove(c: ContactRow) {
    setConfirmDelete(null);
    try {
      await api(`/contacts/${c.id}`, { method: "DELETE" });
      setMsg({ tone: "success", text: "Contact deleted. Past calls stay in Call History." });
      load();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
          <input value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} placeholder="Search name, company, email or number" className={clsx(fieldCls, "pl-9")} aria-label="Search contacts" />
        </div>
        {manage && <Button onClick={() => setEditing("new")}><Plus className="size-4" /> Add contact</Button>}
      </div>
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!data ? (
        <Spinner />
      ) : data.contacts.length === 0 ? (
        <EmptyState icon={<Contact className="size-8" />} title={q ? "No matching contacts" : "No contacts yet"} description="Contacts are added automatically when you create a campaign, or you can add them here." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-2 py-3 font-medium">Number</th>
                <th className="px-2 py-3 font-medium">Company</th>
                <th className="px-2 py-3 font-medium">Consent</th>
                <th className="px-2 py-3 font-medium">Calls</th>
                <th className="px-2 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.contacts.map((c) => {
                const [tone, label] = CONSENT[c.consent_status];
                return (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="text-muted">—</span>}{c.email && <div className="text-xs text-muted">{c.email}</div>}</td>
                    <td className="px-2 py-2 font-mono">{c.phone_e164}</td>
                    <td className="px-2 py-2">{c.company ?? <span className="text-muted">—</span>}</td>
                    <td className="px-2 py-2"><Badge tone={tone}>{label}</Badge> {c.on_dnc && <Badge tone="danger">Do Not Call</Badge>}</td>
                    <td className="px-2 py-2 tabular-nums">{c.call_count}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      {manage && <Button variant="ghost" onClick={() => setEditing(c)}>Edit</Button>}
                      {manage && (confirmDelete === c.id ? (
                        <>
                          <Button variant="danger" onClick={() => remove(c)}>Delete</Button>
                          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                        </>
                      ) : (
                        <Button variant="ghost" onClick={() => setConfirmDelete(c.id)} aria-label="Delete contact"><Trash2 className="size-4" /></Button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.total > 25 && (
            <div className="flex items-center justify-between border-t border-border p-3 text-sm">
              <span className="text-muted">{data.total} contacts · page {page} of {Math.ceil(data.total / 25)}</span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </Card>
      )}
      {editing && (
        <ContactForm
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), setMsg({ tone: "success", text: "Contact saved." }), load())}
        />
      )}
    </>
  );
}

function ContactForm({ contact, onClose, onSaved }: { contact: ContactRow | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(["firstName", "lastName", "phone", "email", "company", "consentStatus", "consentSource", "notes"].map((k) => [k, String(fd.get(k) ?? "")]));
    setSaving(true);
    setError(null);
    try {
      if (contact) await api(`/contacts/${contact.id}`, { method: "PUT", json: { ...body, defaultCountry: "AE" } });
      else await api("/contacts", { method: "POST", json: { ...body, defaultCountry: "AE" } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.fields?.[0] ? `${err.fields[0].path}: ${err.fields[0].message}` : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={contact ? "Edit contact" : "Add contact"}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative h-full w-full max-w-md overflow-y-auto bg-surface p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{contact ? "Edit contact" : "Add contact"}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-text"><X className="size-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input name="firstName" label="First name" defaultValue={contact?.first_name ?? ""} />
            <Input name="lastName" label="Last name" defaultValue={contact?.last_name ?? ""} />
          </div>
          <Input name="phone" label="Phone number" required defaultValue={contact?.phone_e164 ?? ""} placeholder="+971 50 123 4567" hint="Numbers without + are treated as UAE." />
          <Input name="email" label="Email" type="email" defaultValue={contact?.email ?? ""} />
          <Input name="company" label="Company" defaultValue={contact?.company ?? ""} />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Consent to be called</span>
            <select name="consentStatus" defaultValue={contact?.consent_status ?? "unknown"} className={fieldCls}>
              <option value="unknown">Unknown</option>
              <option value="granted">Consent given</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
          <Input name="consentSource" label="How consent was given (optional)" defaultValue={contact?.consent_source ?? ""} placeholder="e.g. Signed up on website, 3 Nov" />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Notes</span>
            <textarea name="notes" rows={3} defaultValue={contact?.notes ?? ""} className={fieldCls} />
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" loading={saving}>Save</Button>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DncTab() {
  const session = useSession();
  const canAdd = can(session, "contacts:manage");
  const canRemove = can(session, "campaigns:manage");
  const [entries, setEntries] = useState<DncRow[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<{ entries: DncRow[] }>("/contacts/dnc").then((r) => setEntries(r.entries)).catch((e) => setMsg({ tone: "danger", text: e.message }));
  }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setAdding(true);
    setMsg(null);
    try {
      const r = await api<{ phone: string }>("/contacts/dnc", { method: "POST", json: { phone: fd.get("phone"), reason: fd.get("reason") || undefined, defaultCountry: "AE" } });
      form.reset();
      setMsg({ tone: "success", text: `${r.phone} will never be called. It was also removed from any running campaign.` });
      load();
    } catch (err) {
      setMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setAdding(false);
    }
  }

  async function remove(d: DncRow) {
    setConfirmRemove(null);
    try {
      await api(`/contacts/dnc/${d.id}`, { method: "DELETE" });
      setMsg({ tone: "success", text: `${d.phone_e164} removed from the Do Not Call list. Only do this if the person has asked to be contacted again.` });
      load();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }

  return (
    <>
      <Card className="mb-4">
        <p className="mb-3 text-sm text-muted">Numbers on this list are never called, by people or by AI. The AI adds anyone who asks not to be called, immediately and automatically.</p>
        {canAdd && (
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1"><Input name="phone" label="Phone number" required placeholder="+971 50 123 4567" /></div>
            <div className="min-w-56 flex-1"><Input name="reason" label="Reason (optional)" placeholder="e.g. Asked by email" /></div>
            <Button type="submit" loading={adding} className="mb-0.5"><Ban className="size-4" /> Add to list</Button>
          </form>
        )}
      </Card>
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!entries ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState icon={<Ban className="size-8" />} title="The Do Not Call list is empty" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-2 py-3 font-medium">How it was added</th>
                <th className="px-2 py-3 font-medium">Reason</th>
                <th className="px-2 py-3 font-medium">Added</th>
                <th className="px-2 py-3" />
              </tr>
            </thead>
            <tbody>
              {entries.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono">{d.phone_e164}</td>
                  <td className="px-2 py-2">{SOURCE[d.source] ?? d.source}</td>
                  <td className="px-2 py-2 text-muted">{d.reason ?? "—"}</td>
                  <td className="px-2 py-2 text-muted">{new Date(d.created_at).toLocaleDateString()}{d.added_by ? ` · ${d.added_by}` : ""}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
                    {canRemove && (confirmRemove === d.id ? (
                      <>
                        <Button variant="danger" onClick={() => remove(d)}>Remove</Button>
                        <Button variant="ghost" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button variant="ghost" onClick={() => setConfirmRemove(d.id)}>Remove</Button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
