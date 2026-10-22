/**
 * The login cookie: `<user id>.<expiry>.<hmac>`, HttpOnly, SameSite=Lax (so it rides along on the redirect back
 * from Google), Secure when PUBLIC_URL is https. Its name stays clear of lofiwave's own `ac_session`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const COOKIE = "lwh_session";
const DAYS = 30;
const secure = config.publicUrl.startsWith("https://");
const sign = (s: string) => createHmac("sha256", config.sessionSecret).update(`session\0${s}`).digest("base64url");

export function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const setCookie = (name: string, value: string, maxAgeSec: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;

export function sessionCookie(userId: number): string {
  const payload = `${userId}.${Date.now() + DAYS * 86400_000}`;
  return setCookie(COOKIE, `${payload}.${sign(payload)}`, DAYS * 86400);
}
export const clearSession = () => setCookie(COOKIE, "", 0);

/** The signed-in user's id, or null. */
export function sessionUser(req: Request): number | null {
  const v = cookieOf(req, COOKIE);
  const m = v?.match(/^(\d+)\.(\d+)\.([\w-]+)$/);
  if (!m) return null;
  const want = Buffer.from(sign(`${m[1]}.${m[2]}`)), got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got) || Number(m[2]) < Date.now()) return null;
  return Number(m[1]);
}

/** A state-changing request must come from our own pages (the cookie is Lax, but say it outright). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.method === "GET" || req.method === "HEAD";
  try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
}
