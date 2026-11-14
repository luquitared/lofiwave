/**
 * Sign in with Google (OpenID Connect, authorization code with PKCE), for the accounts GOOGLE_ALLOWED lets in.
 *
 * Google only sends people back to redirect URIs registered on the OAuth client, exactly. A console reachable at its
 * own address registers `<its URL>/api/auth/google/callback`. Many consoles can instead share one registered URI, a
 * relay (`auth-relay/`, set as GOOGLE_REDIRECT_URI): the console puts its own callback in `state`, and the relay
 * forwards Google's answer there. The relay holds no secret. The code is exchanged here, with the client secret and
 * the PKCE verifier, so a code that reaches anywhere else is useless; `state` is tied to the browser that started.
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { cleanName } from "./auth";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
export const CALLBACK_PATH = "/api/auth/google/callback";
/** Ties a sign-in to the browser that started it. Lax: it has to come along on Google's redirect back. */
export const STATE_COOKIE = "ac_google";
const PENDING_MS = 10 * 60_000;

type Pending = { verifier: string; redirectUri: string; at: number };
const pending = new Map<string, Pending>();

const b64url = (b: Buffer) => b.toString("base64url");
export const googleLogin = () => Boolean(config.google.clientId && config.google.clientSecret && config.google.allowed.length);

/** This console's own callback, from the address the browser used (Host and X-Forwarded-Proto behind a proxy). */
const ownCallback = (base: string) => base + CALLBACK_PATH;

/** Start: where to send the browser, and the nonce to keep in its cookie. */
export function googleStart(base: string): { location: string; nonce: string } {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.at > PENDING_MS) pending.delete(k);
  const nonce = b64url(randomBytes(18));
  const verifier = b64url(randomBytes(32));
  const redirectUri = config.google.redirectUri || ownCallback(base);
  pending.set(nonce, { verifier, redirectUri, at: now });
  // `r` is read by the relay (where to forward); with a direct callback it is ignored.
  const state = b64url(Buffer.from(JSON.stringify({ n: nonce, r: ownCallback(base) })));
  const q = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
    state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", prompt: "select_account",
  });
  // A hint for Google's account picker when exactly one domain is allowed; the check that counts is below.
  const domains = config.google.allowed.filter((a) => !a.includes("@"));
  if (domains.length === 1 && domains.length === config.google.allowed.length) q.set("hd", domains[0]);
  return { location: `${AUTH_URL}?${q}`, nonce };
}

export class GoogleError extends Error {}

/** The person's lofiwave name, once Google's answer checks out: from this browser, a fresh code, an allowed account. */
export async function googleFinish(url: URL, cookieNonce: string | undefined): Promise<{ name: string; email: string }> {
  const err = url.searchParams.get("error");
  if (err) throw new GoogleError(err === "access_denied" ? "Sign-in was cancelled." : `Google said: ${err}`);
  let nonce = "";
  try { nonce = JSON.parse(Buffer.from(url.searchParams.get("state") ?? "", "base64url").toString()).n ?? ""; } catch {}
  const p = nonce ? pending.get(nonce) : undefined;
  if (!p || nonce !== cookieNonce || Date.now() - p.at > PENDING_MS) throw new GoogleError("This sign-in expired or was started in another browser. Try again.");
  pending.delete(nonce);
  const code = url.searchParams.get("code");
  if (!code) throw new GoogleError("Google sent no code back.");

  const res = await fetch(TOKEN_URL(), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: config.google.clientId, client_secret: config.google.clientSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const tok: any = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || typeof tok.id_token !== "string") throw new GoogleError(`Google didn't accept the sign-in (${tok.error_description || tok.error || res?.status || "no answer"}).`);

  // Straight from Google's token endpoint over TLS, for our client: OpenID Connect lets the claims be read as they are.
  let c: any = {};
  try { c = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString()); } catch {}
  if (c.aud !== config.google.clientId || !["accounts.google.com", "https://accounts.google.com"].includes(c.iss) || !(c.exp * 1000 > Date.now())) {
    throw new GoogleError("Google's answer didn't check out.");
  }
  const email = String(c.email ?? "").toLowerCase();
  if (!email || c.email_verified !== true) throw new GoogleError("That Google account has no verified email.");
  if (!allowed(email, typeof c.hd === "string" ? c.hd.toLowerCase() : "")) throw new GoogleError(`${email} can't sign in here.`);
  const name = cleanName(c.name) || cleanName(email.split("@")[0]);
  return { name, email };
}

/**
 * GOOGLE_ALLOWED: domains (`synjuku.ai`: Workspace accounts of that domain, checked on Google's `hd`, which a
 * personal account with a matching address doesn't have) and single addresses (`someone@gmail.com`).
 */
function allowed(email: string, hd: string): boolean {
  return config.google.allowed.some((a) => (a.includes("@") ? a === email : a === hd));
}
