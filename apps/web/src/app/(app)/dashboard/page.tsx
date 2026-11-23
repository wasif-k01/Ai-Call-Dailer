"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, Bot, CheckCircle2, Clock, DollarSign, Phone, PhoneOff, PlugZap, Sparkles, User } from "lucide-react";
import { api, formatDuration, formatUsd } from "@/lib/api";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";

interface Stats {
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  human_calls: number;
  ai_calls: number;
  active_calls: number;
  total_duration_sec: number;
  ai_usage_seconds: number;
  estimated_cost_usd: number;
}
interface RecentCall {
  id: string;
  mode: "human" | "ai";
  status: string;
  to_number: string;
  started_at: string;
  duration_sec: number | null;
  agent_name: string | null;
}
interface DashboardData {
  stats: Stats;
  recentActivity: RecentCall[];
  integrations: { provider: string; status: string }[];
  spend: { limit_usd: number | null; spent: number; pct: number | null; overThreshold: boolean; overLimit: boolean; action: string };
}

const statusTone = (s: string) =>
  s === "completed" ? "success" : ["failed", "busy", "no_answer", "canceled"].includes(s) ? "danger" : s === "in_progress" ? "info" : "neutral";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardData>("/dashboard/stats").then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const s = data.stats;
  const connected = (p: string) => data.integrations.some((i) => i.provider === p && i.status === "connected");

  const tiles = [
    { label: "Total Calls", value: s.total_calls, icon: Phone },
    { label: "Successful Calls", value: s.successful_calls, icon: CheckCircle2 },
    { label: "Failed Calls", value: s.failed_calls, icon: PhoneOff },
    { label: "Active Calls", value: s.active_calls, icon: Activity },
    { label: "Human Calls", value: s.human_calls, icon: User },
    { label: "AI Calls", value: s.ai_calls, icon: Sparkles },
    { label: "Total Call Duration", value: formatDuration(s.total_duration_sec), icon: Clock },
    { label: "Total AI Usage", value: formatDuration(s.ai_usage_seconds), icon: Bot },
    { label: "Estimated Calling Cost", value: formatUsd(s.estimated_cost_usd), icon: DollarSign, note: "Twilio billed + OpenAI estimate" },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="An overview of your calling activity." />

      {data.spend.overThreshold && (
        <div className="mb-6">
          <Alert tone={data.spend.overLimit ? "danger" : "warning"}>
            {data.spend.overLimit
              ? `This month's spending limit is reached: ${formatUsd(data.spend.spent)} of ${formatUsd(data.spend.limit_usd)}.${data.spend.action === "block" ? " New AI calls are blocked and campaigns are paused." : ""}`
              : `This month's spending is at ${data.spend.pct}% of your ${formatUsd(data.spend.limit_usd)} limit.`}{" "}
            <Link className="underline" href="/usage">See Usage &amp; Costs</Link>
          </Alert>
        </div>
      )}

      {(!connected("twilio") || !connected("openai")) && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 border-primary/30 bg-primary/5">
          <div className="flex items-start gap-3">
            <PlugZap className="mt-0.5 size-5 text-primary" />
            <div>
              <p className="font-medium">Finish setting up your calling platform</p>
              <p className="text-sm text-muted">
                Twilio: {connected("twilio") ? "connected" : "not connected"} · OpenAI: {connected("openai") ? "connected" : "not connected"}
              </p>
            </div>
          </div>
          <Link href="/integrations"><Button>Open setup wizard</Button></Link>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(({ label, value, icon: Icon, note }) => (
          <Card key={label}>
            <div className="flex items-center justify-between text-sm text-muted">
              {label}
              <Icon className="size-4" aria-hidden />
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
            {note && <div className="mt-1 text-xs text-muted">{note}</div>}
          </Card>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Recent Activity</h2>
      {data.recentActivity.length === 0 ? (
        <EmptyState icon={<Phone className="size-8" />} title="No calls yet" description="Calls you make from the Dialer or campaigns will appear here." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">To</th>
                <th className="px-4 py-3 font-medium">Mode</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {data.recentActivity.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono">{c.to_number}</td>
                  <td className="px-4 py-3">{c.mode === "ai" ? `AI${c.agent_name ? ` · ${c.agent_name}` : ""}` : "Human"}</td>
                  <td className="px-4 py-3"><Badge tone={statusTone(c.status)}>{c.status.replace("_", " ")}</Badge></td>
                  <td className="px-4 py-3 tabular-nums">{formatDuration(c.duration_sec)}</td>
                  <td className="px-4 py-3 text-muted">{new Date(c.started_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
