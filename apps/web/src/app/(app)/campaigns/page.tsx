"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { can, useSession } from "@/components/shell/session";
import { CAMPAIGN_STATUS, type Campaign } from "@/components/campaigns/status";

export default function CampaignsPage() {
  const session = useSession();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ campaigns: Campaign[] }>("/campaigns").then((r) => setCampaigns(r.campaigns)).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useRealtime((e) => {
    if (e.type === "campaign.progress") load();
  });

  if (error) return <Alert>{error}</Alert>;
  if (!campaigns) return <Spinner />;

  return (
    <>
      <PageHeader
        title="Bulk Campaigns"
        description="Upload a list of numbers and let an AI agent call them, within your calling hours and limits."
        actions={can(session, "campaigns:manage") && <Link href="/campaigns/new"><Button><Plus className="size-4" /> New campaign</Button></Link>}
      />
      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="size-8" />}
          title="No campaigns yet"
          description="Create a campaign from a CSV or Excel file, or paste numbers. Nothing is called until you confirm and press Start."
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => {
            const s = c.stats!;
            const done = s.total - s.remaining - s.in_progress;
            const pct = s.total ? Math.round((done / s.total) * 100) : 0;
            const st = CAMPAIGN_STATUS[c.status];
            return (
              <Link key={c.id} href={`/campaigns/${c.id}`} className="block">
                <Card className="transition hover:border-primary/50">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">{c.name}</h3>
                        <Badge tone={st?.tone}>{st?.label ?? c.status}</Badge>
                      </div>
                      <p className="text-sm text-muted">
                        {c.agent_name ?? "No agent"} · {s.total} contacts · {c.calling_hours_start}–{c.calling_hours_end} {c.timezone}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-medium tabular-nums">{pct}% done</div>
                      <div className="text-muted">{s.answered} answered · {s.in_progress} in progress</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
