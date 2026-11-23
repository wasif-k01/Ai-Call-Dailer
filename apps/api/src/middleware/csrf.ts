import type { NextFunction, Request, Response } from "express";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cross-site request forgery guard for the JSON API. A malicious page can make a browser submit
 * an HTML form (urlencoded / multipart / text-plain) without a CORS preflight, but it can't send
 * application/json. The dashboard only ever sends JSON (or no body), so those form types are refused.
 * This sits on top of the SameSite=Lax session cookie.
 */
export function rejectFormPosts(req: Request, res: Response, next: NextFunction) {
  if (MUTATING.has(req.method) && req.is(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"])) {
    return res.status(415).json({ error: { code: "unsupported_media_type", message: "This API only accepts JSON." } });
  }
  next();
}
