import { Badge } from "@/components/ui";
import type { Status } from "./types";

const map: Record<Status, { tone: "success" | "danger" | "info" | "neutral"; label: string }> = {
  connected: { tone: "success", label: "Connected" },
  not_connected: { tone: "neutral", label: "Not Connected" },
  testing: { tone: "info", label: "Testing…" },
  error: { tone: "danger", label: "Configuration Error" },
};

export function StatusBadge({ status }: { status: Status }) {
  const s = map[status] ?? map.not_connected;
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
