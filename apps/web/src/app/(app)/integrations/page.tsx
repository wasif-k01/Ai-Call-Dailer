"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { Alert, PageHeader, Spinner } from "@/components/ui";
import { useSession, can } from "@/components/shell/session";
import { SetupWizard } from "@/components/integrations/setup-wizard";
import { InfraCards, OpenAICard, TwilioCard } from "@/components/integrations/provider-cards";
import type { IntegrationsResponse, SetupResponse } from "@/components/integrations/types";

export default function IntegrationsPage() {
  const session = useSession();
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = can(session, "integrations:manage");

  const load = useCallback(() => {
    if (!allowed) return;
    Promise.all([api<IntegrationsResponse>("/integrations"), api<SetupResponse>("/setup")])
      .then(([i, s]) => (setData(i), setSetup(s), setError(null)))
      .catch((e) => setError(e.message));
  }, [allowed]);

  useEffect(load, [load]);

  if (!allowed) return <Alert>Only owners and admins can manage integrations.</Alert>;
  if (error) return <Alert>{error}</Alert>;
  if (!data || !setup) return <Spinner />;

  return (
    <>
      <PageHeader title="Integrations & API Settings" description="Connect your accounts here. You never need to edit code or files." />
      <SetupWizard setup={setup} />
      <div className="mb-4 flex items-start gap-2 text-sm text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p>Keys are encrypted before they’re stored and are never shown again in full: you’ll only see the last 4 characters. They never leave the server except to go to OpenAI or Twilio.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <OpenAICard data={data} onChange={load} />
        <TwilioCard data={data} onChange={load} />
        <InfraCards data={data} />
      </div>
    </>
  );
}
