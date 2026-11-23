"use client";

import { useState } from "react";
import clsx from "clsx";
import { CheckCircle2, ChevronDown, Circle, Clock } from "lucide-react";
import { Card } from "@/components/ui";
import type { SetupResponse } from "./types";

/** Plain-English help for each step: what, where, why, how to test. */
const HELP: Record<string, { what: string; where: string; why: string; test: string }> = {
  openai: {
    what: "An OpenAI API key (starts with sk-).",
    where: "platform.openai.com → API keys → Create new secret key. Billing must be set up under Settings → Billing.",
    why: "OpenAI powers the AI voice that talks to people on AI calls.",
    test: "Enter the key in the OpenAI card below, click Save, then Test Connection.",
  },
  twilio: {
    what: "Your Twilio Account SID (starts with AC) and Auth Token.",
    where: "console.twilio.com → the Account Info box on the home page (click “Show” next to Auth Token).",
    why: "Twilio places the actual phone calls using your phone number.",
    test: "Enter both in the Twilio card below, click Save, then Test Connection.",
  },
  phone_number: {
    what: "Nothing new: your existing US Twilio number.",
    where: "It's fetched automatically from your Twilio account when the connection test passes.",
    why: "It's the caller ID people see when you call them.",
    test: "Open Phone Numbers and check that your US number is marked Default.",
  },
  geo_permissions: {
    what: "Permission in Twilio to call each country (UAE, UK, Pakistan…).",
    where: "console.twilio.com → Voice → Settings → Geo permissions. Tick each country you'll call.",
    why: "Twilio blocks calls to countries that aren't ticked, to protect you from fraud.",
    test: "Open Phone Numbers → Calling destinations → Check permissions.",
  },
  openai_voice: {
    what: "A realtime model and a voice for the AI.",
    where: "Choose them in the OpenAI card below.",
    why: "This decides how the AI sounds on calls.",
    test: "Save and run Test Connection. The step completes when the test passes with a voice selected.",
  },
  test_human_call: {
    what: "A real call from the Dialer to your own phone.",
    where: "Dialer page (built in Phase 3).",
    why: "Proves browser calling works end to end.",
    test: "Completes automatically after a successful human call.",
  },
  test_ai_call: {
    what: "A real AI call to your own phone.",
    where: "AI Calling page (built in Phase 4).",
    why: "Proves the AI voice works over a real phone line.",
    test: "Completes automatically after a successful AI call.",
  },
  bulk_enabled: {
    what: "Confirm consent rules and switch on bulk calling.",
    where: "Bulk Campaigns page (built in Phase 6).",
    why: "Bulk calling stays off until you confirm you have consent to call the contacts.",
    test: "Completes when bulk calling is enabled.",
  },
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);

export function SetupWizard({ setup }: { setup: SetupResponse }) {
  const firstOpen = setup.steps.find((s) => s.status === "pending")?.key ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);

  return (
    <Card className="mb-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Setup wizard</h2>
          <p className="text-sm text-muted">Go at your own pace. Saved settings are kept, and a step only turns green after it has actually been checked.</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{setup.percent}%</div>
          <div className="text-xs text-muted">{setup.completed} of {setup.total} verified</div>
        </div>
      </div>
      <div className="mb-5 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={setup.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-success transition-all" style={{ width: `${setup.percent}%` }} />
      </div>
      <ol className="divide-y divide-border">
        {setup.steps.map((s, i) => {
          const h = HELP[s.key];
          const isOpen = open === s.key;
          return (
            <li key={s.key}>
              <button
                className="flex w-full items-center gap-3 py-3 text-left"
                onClick={() => setOpen(isOpen ? null : s.key)}
                aria-expanded={isOpen}
              >
                {s.status === "verified" ? (
                  <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Verified" />
                ) : s.status === "not_available_yet" ? (
                  <Clock className="size-5 shrink-0 text-muted" aria-label="Not available yet" />
                ) : (
                  <Circle className="size-5 shrink-0 text-muted" aria-label="Pending" />
                )}
                <span className={clsx("flex-1 text-sm", s.status === "verified" ? "text-text" : "font-medium")}>
                  Step {i + 1}: {s.title}
                </span>
                {s.status === "not_available_yet" && <span className="text-xs text-muted">Available after phase {s.phase}</span>}
                <ChevronDown className={clsx("size-4 text-muted transition", isOpen && "rotate-180")} />
              </button>
              {isOpen && h && (
                <dl className="mb-4 ml-8 grid gap-2 rounded-lg bg-surface-2 p-4 text-sm sm:grid-cols-[8rem_1fr]">
                  <dt className="text-muted">What you need</dt><dd>{h.what}</dd>
                  <dt className="text-muted">Where to get it</dt><dd>{h.where}</dd>
                  <dt className="text-muted">Why</dt><dd>{h.why}</dd>
                  <dt className="text-muted">How to check</dt><dd>{h.test}</dd>
                  {s.key === "phone_number" && s.details?.defaultNumber && (
                    <><dt className="text-muted">Default number</dt><dd className="font-mono">{s.details.defaultNumber}</dd></>
                  )}
                  {s.key === "geo_permissions" && s.details && (
                    <>
                      <dt className="text-muted">Last check</dt>
                      <dd>
                        Allowed: {list(s.details.enabled).join(", ") || "none"}
                        {list(s.details.disabled).length ? ` · Blocked: ${list(s.details.disabled).join(", ")}` : ""}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
