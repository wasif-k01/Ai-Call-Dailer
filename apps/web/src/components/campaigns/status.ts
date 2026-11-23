export const CONTACT_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }> = {
  pending: { label: "Pending", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  calling: { label: "Calling", tone: "info" },
  answered: { label: "Answered", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  no_answer: { label: "No Answer", tone: "warning" },
  busy: { label: "Busy", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  opted_out: { label: "Opted Out", tone: "neutral" },
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }> = {
  draft: { label: "Draft", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  paused: { label: "Paused", tone: "warning" },
  stopped: { label: "Stopped", tone: "danger" },
  completed: { label: "Completed", tone: "success" },
};

export interface CampaignStats {
  total: number;
  attempted: number;
  answered: number;
  successful: number;
  failed: number;
  opted_out: number;
  remaining: number;
  in_progress: number;
  avg_duration_sec: number;
  total_cost_usd: number | null;
  by_status: Record<string, number>;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  agent_name: string | null;
  from_number: string | null;
  instructions: string | null;
  calling_hours_start: string;
  calling_hours_end: string;
  timezone: string;
  max_concurrent: number;
  max_retries: number;
  retry_delay_min: number;
  consent_confirmed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
  created_at: string;
  stats?: CampaignStats;
}
