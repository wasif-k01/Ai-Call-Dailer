"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Card, Input, PageHeader } from "@/components/ui";
import { useSession } from "@/components/shell/session";

export default function SettingsPage() {
  const session = useSession();
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

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
