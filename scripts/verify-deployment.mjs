#!/usr/bin/env node
/**
 * Post-deploy smoke test. Read-only: makes no calls, creates no data, needs no secrets.
 *
 *   node scripts/verify-deployment.mjs --api https://api-xxxx.up.railway.app --web https://your-app.vercel.app
 */
import http from "node:http";
import https from "node:https";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const API = args.api?.replace(/\/$/, "");
const WEB = args.web?.replace(/\/$/, "");
if (!API) {
  console.error("usage: node scripts/verify-deployment.mjs --api <https://api-url> [--web <https://web-url>]");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => (failures++, console.log(`  ❌ ${m}`));
const warn = (m) => console.log(`  ⚠️  ${m}`);

/** Sends a WebSocket upgrade with no ticket. A 401 proves the request reached our WS router through the edge. */
function probeUpgrade(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("verify-deployment!").toString("base64"),
      },
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("upgrade", (res, socket) => (socket.destroy(), resolve(101)));
    req.on("error", (e) => resolve(`error: ${e.message}`));
    req.setTimeout(10_000, () => (req.destroy(), resolve("timeout")));
    req.end();
  });
}

console.log(`\nAPI  ${API}`);
if (!API.startsWith("https://")) warn("API URL is not https — Twilio webhooks and media streams require HTTPS/WSS");
try {
  const res = await fetch(`${API}/health`);
  const h = await res.json();
  res.ok && h.db === "ok" ? ok("health: database reachable") : bad(`health: database ${h.db ?? res.status}`);
  h.redis === "ok" ? ok("health: redis reachable") : bad("health: redis unreachable (check REDIS_URL / Railway Redis)");
  h.worker === "ok" ? ok(`health: worker heartbeat (last ${h.workerLastSeen})`) : bad("health: no worker heartbeat (is the worker service running?)");
  ok(`version ${h.version}`);
} catch (e) {
  bad(`health endpoint unreachable: ${e.message}`);
}

const ws = await probeUpgrade(`${API}/ws/events`);
ws === 401 ? ok("websocket upgrade reaches the API (401 without ticket, as expected)") : bad(`websocket upgrade returned ${ws} (expected 401)`);

try {
  const res = await fetch(`${API}/api/auth/me`);
  res.status === 401 ? ok("protected endpoints reject anonymous requests") : bad(`/api/auth/me returned ${res.status} (expected 401)`);
} catch (e) {
  bad(`api request failed: ${e.message}`);
}

if (WEB) {
  console.log(`\nWEB  ${WEB}`);
  try {
    const page = await fetch(`${WEB}/login`);
    page.ok ? ok("login page loads") : bad(`login page returned ${page.status}`);
    const hsts = page.headers.get("strict-transport-security");
    hsts ? ok("security headers present") : warn("no HSTS header on web responses");
    const proxied = await fetch(`${WEB}/api/auth/signup-status`);
    const body = await proxied.json().catch(() => null);
    proxied.ok && body && "signupAllowed" in body
      ? ok(`Vercel → Railway proxy works (sign-ups ${body.signupAllowed ? "OPEN — disable after creating owner" : "closed"})`)
      : bad(`proxy /api/auth/signup-status returned ${proxied.status} — check API_URL in Vercel`);
    const cors = await fetch(`${API}/api/auth/signup-status`, { headers: { Origin: WEB } });
    cors.headers.get("access-control-allow-origin") === WEB ? ok("CORS allows the web origin") : warn("CORS does not list the web origin — check WEB_ORIGIN on Railway");
  } catch (e) {
    bad(`web checks failed: ${e.message}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);
