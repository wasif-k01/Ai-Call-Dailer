export type Status = "not_connected" | "testing" | "connected" | "error";

export interface Integration {
  provider: string;
  status: Status;
  config: { [key: string]: string | string[] | null | undefined };
  secrets: Record<string, string>;
  lastTestedAt: string | null;
  lastError: string | null;
}

export interface IntegrationsResponse {
  openai: Integration;
  twilio: Integration;
  database: { status: Status; kind: string; host: string };
  redis: { status: Status };
  options: { realtimeModels: string[]; voices: string[] };
}

export interface SetupStep {
  key: string;
  title: string;
  phase: number;
  status: "verified" | "pending" | "not_available_yet";
  details: { [key: string]: string | string[] | null | undefined } | null;
}

export interface SetupResponse {
  steps: SetupStep[];
  completed: number;
  total: number;
  percent: number;
}
