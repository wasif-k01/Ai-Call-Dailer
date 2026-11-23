import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { loadUserFromId, type AuthUser } from "../middleware/auth.js";

/**
 * Browsers cannot send the dashboard's session cookie to the API's own domain
 * (the cookie belongs to the Vercel domain), so they first fetch a 60-second,
 * single-purpose ticket through the same-origin proxy and pass it on connect.
 */
export function issueWsTicket(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { audience: "acp-ws", expiresIn: 60 });
}

export async function loadUserFromTicket(ticket: string): Promise<AuthUser | null> {
  try {
    const p = jwt.verify(ticket, env.JWT_SECRET, { audience: "acp-ws" }) as { sub: string };
    return await loadUserFromId(p.sub);
  } catch {
    return null;
  }
}
