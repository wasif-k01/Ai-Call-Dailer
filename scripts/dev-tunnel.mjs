#!/usr/bin/env node
/**
 * Local development with real Twilio calls.
 * Starts a free Cloudflare quick tunnel (no account needed) to the local API, then starts
 * the API and the background worker with PUBLIC_API_URL set to the tunnel's https:// address
 * so Twilio can reach them (the worker places bulk-campaign calls).
 * The address changes every run; the API updates the Twilio TwiML App automatically.
 *
 *   npm run dev:api:tunnel
 */
import { spawn } from "node:child_process";

const PORT = process.env.PORT ?? "4000";
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
let api = null;
let worker = null;

tunnel.on("error", () => {
  console.error("cloudflared is not installed. Install it with: brew install cloudflared");
  process.exit(1);
});

const onOutput = (buf) => {
  const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !api) {
    const url = m[0];
    console.log(`\n🌐 Public tunnel: ${url}\n   Twilio webhooks → ${url}/webhooks/twilio/…\n`);
    api = spawn("npm", ["run", "dev", "-w", "@acp/api"], {
      stdio: "inherit",
      env: { ...process.env, PUBLIC_API_URL: url, PORT },
    });
    api.on("exit", (code) => shutdown(code ?? 0));
    worker = spawn("npm", ["run", "dev:worker", "-w", "@acp/api"], {
      stdio: "inherit",
      env: { ...process.env, PUBLIC_API_URL: url },
    });
  }
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("exit", (code) => {
  console.error(`tunnel exited (${code})`);
  shutdown(1);
});

function shutdown(code) {
  tunnel.kill("SIGTERM");
  api?.kill("SIGTERM");
  worker?.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
