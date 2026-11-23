import type { NextConfig } from "next";

// All browser → API traffic goes through this same-origin proxy, so the session
// cookie is first-party and no API secrets leak to client code.
// API_URL is read at BUILD time (rewrites are compiled), so it must be set in
// Vercel for the Production (and Preview) environment before building.
const API_URL = process.env.API_URL ?? "http://localhost:4000";

if (process.env.VERCEL_ENV === "production" && !process.env.API_URL) {
  throw new Error("API_URL must be set in Vercel → Settings → Environment Variables (e.g. https://api-xxxx.up.railway.app)");
}
if (process.env.VERCEL_ENV === "production" && !API_URL.startsWith("https://")) {
  throw new Error("API_URL must use https:// in production");
}

const isDev = process.env.NODE_ENV !== "production";

// Where the dashboard may load code from and connect to. Browser calling (Twilio Voice SDK)
// needs wss/https to Twilio, and live updates need wss to the API (a Railway or tunnel URL).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: https://*.twilio.com https://*.twiliocdn.com",
  "connect-src 'self' https: wss:" + (isDev ? " ws:" : ""),
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone is required for browser (Twilio Voice SDK) calling; everything else is off.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
