/**
 * Who is calling. Two ways in:
 *  - the API token (agents, scripts, the session hook): always works;
 *  - with PASSWORD set, people log in with a name and the shared password and get a signed session cookie.
 *    That makes the console multiplayer: runs record who started them, and everyone sees who else is online.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const COOKIE = "ac_session";
const SESSION_DAYS = 30;
/** Name shown for requests made with the API token. */
export const TOKEN_ACTOR = "api";

/** The identity of the request being handled (read by startRun to stamp runs with who started them). */
export const actor = new AsyncLocalStorage<string>();

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const tokenMatches = (t: string | null | undefined) => Boolean(t) && safeEq(t!, config.authToken);

// Changing the password (or the token) signs everyone out.
const key = createHash("sha256").update(`ac-session\0${config.authToken}\0${config.password}`).digest();
const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function cleanName(v: unknown): string {
  const n = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) : "";
  return n;
}

export function makeSession(name: string): { value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 86400;
  const payload = Buffer.from(JSON.stringify({ n: name, exp: Date.now() + maxAge * 1000 })).toString("base64url");
  return { value: `${payload}.${sign(payload)}`, maxAge };
}

function readSession(value: string | undefined): string | null {
  if (!value || !config.password) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  try {
    const { n, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof n === "string" && n && typeof exp === "number" && exp > Date.now() ? n : null;
  } catch { return null; }
}

export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
}

export function sessionCookie(req: Request, value: string, maxAge: number): string {
  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/**
 * The caller's name, or null when unauthenticated. A cookie-authenticated request that changes something must come
 * from this console's own pages (Origin = Host): SameSite already stops most cross-site requests, this closes the rest.
 */
export function identify(req: Request, url: URL): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ") && tokenMatches(h.slice(7).trim())) return TOKEN_ACTOR;
  if (tokenMatches(req.headers.get("x-auth-token"))) return TOKEN_ACTOR;
  if (tokenMatches(url.searchParams.get("token"))) return TOKEN_ACTOR;
  const name = readSession(cookieOf(req, COOKIE));
  if (!name) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (!origin) return null;
    try { if (new URL(origin).host !== req.headers.get("host")) return null; } catch { return null; }
  }
  return name;
}

export const passwordMatches = (p: unknown) => Boolean(config.password) && typeof p === "string" && safeEq(p, config.password);

// ---- login throttling: at most 10 failed attempts per address per 10 minutes.
const failures = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
export function loginBlocked(ip: string): boolean {
  const recent = (failures.get(ip) ?? []).filter((t) => t > Date.now() - WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= 10;
}
export function loginFailed(ip: string) { (failures.get(ip) ?? failures.set(ip, []).get(ip)!).push(Date.now()); }

// ---- presence: who has made a request recently.
const seen = new Map<string, number>();
const ONLINE_MS = 45_000;
export function touch(name: string) { if (name !== TOKEN_ACTOR) seen.set(name, Date.now()); }
export function online(): { name: string; last_seen: number }[] {
  const cutoff = Date.now() - ONLINE_MS;
  return [...seen].filter(([, t]) => t > cutoff).map(([name, last_seen]) => ({ name, last_seen })).sort((a, b) => a.name.localeCompare(b.name));
}
