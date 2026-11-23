"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Card, Input, PageHeader } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";

export default function SettingsPage() {
  const session = useSession();
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [orgMsg, setOrgMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);

  async function renameOrg(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setOrgSaving(true);
    setOrgMsg(null);
    try {
      const name = String(new FormData(e.currentTarget).get("orgName"));
      await api("/settings/organization", { method: "PUT", json: { name } });
      setOrgMsg({ tone: "success", text: "Saved. Reload the page to see the new name in the sidebar. Update your agents' greetings if they mention the old name." });
    } catch (err) {
      const fieldMsg = err instanceof ApiError ? err.fields?.[0]?.message : undefined;
      setOrgMsg({ tone: "danger", text: fieldMsg ?? (err as Error).message });
    } finally {
      setOrgSaving(false);
    }
  }

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setLoading(true);
    setMsg(null);
    try {
      await api("/auth/change-password", { method: "POST", json: Object.fromEntries(new FormData(form)) });
      form.reset();
      setMsg({ tone: "success", text: "Password updated. Other sessions have been signed out." });
    } catch (err) {
      const fieldMsg = err instanceof ApiError ? err.fields?.[0]?.message : undefined;
      setMsg({ tone: "danger", text: fieldMsg ?? (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader title="Account Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 font-semibold">Profile</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Name</dt><dd>{session.user.fullName}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Email</dt><dd>{session.user.email}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Role</dt><dd className="capitalize">{session.user.role}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Workspace</dt><dd>{session.organization.name}</dd></div>
          </dl>
        </Card>
        {can(session, "*") && (
          <Card>
            <h2 className="mb-1 font-semibold">Company / workspace name</h2>
            <p className="mb-4 text-sm text-muted">Shown in the app. New AI agents use it in their greeting.</p>
            <form onSubmit={renameOrg} className="space-y-4">
              {orgMsg && <Alert tone={orgMsg.tone}>{orgMsg.text}</Alert>}
              <Input name="orgName" label="Name" required minLength={2} maxLength={100} defaultValue={session.organization.name} />
              <Button type="submit" loading={orgSaving}>Save name</Button>
            </form>
          </Card>
        )}
        {can(session, "*") && <CallingSettings />}
        <Card>
          <h2 className="mb-4 font-semibold">Change password</h2>
          <form onSubmit={changePassword} className="space-y-4">
            {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
            <Input name="currentPassword" type="password" label="Current password" required autoComplete="current-password" />
            <Input name="newPassword" type="password" label="New password" required autoComplete="new-password" hint="At least 10 characters, with a letter and a number." />
            <Button type="submit" loading={loading}>Update password</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

function CallingSettings() {
  const [settings, setSettings] = useState<{ recording_enabled: boolean; max_concurrent_ai_calls: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ settings: { recording_enabled: boolean; max_concurrent_ai_calls: number } }>("/settings/calling").then((r) => setSettings(r.settings)).catch(() => {});
  }, []);
  if (!settings) return null;
  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await api("/settings/calling", { method: "PUT", json: { recordingEnabled: settings!.recording_enabled, maxConcurrentAiCalls: settings!.max_concurrent_ai_calls } });
      setMsg({ tone: "success", text: "Saved. Applies to calls started from now on." });
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-4 font-semibold">Calling</h2>
      <div className="space-y-4">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={settings.recording_enabled} onChange={(e) => setSettings({ ...settings, recording_enabled: e.target.checked })} />
          <span>
            <span className="font-medium">Record calls</span>
            <span className="block text-muted">AI agents will say the call is recorded; for human calls, you must tell the person yourself. Many countries (including the UAE and UK) require consent to record. Check before switching this on.</span>
          </span>
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="flex justify-between font-medium">AI calls at the same time (whole account) <span className="tabular-nums">{settings.max_concurrent_ai_calls}</span></span>
          <input type="range" min={1} max={20} value={settings.max_concurrent_ai_calls} onChange={(e) => setSettings({ ...settings, max_concurrent_ai_calls: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
          <span className="text-xs text-muted">A safety cap across all campaigns and manual AI calls.</span>
        </label>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button onClick={save} loading={saving}>Save calling settings</Button>
      </div>
    </Card>
  );
}
