/**
 * Sign in with Google: the OAuth authorization-code flow with plain fetch. The user's identity comes from
 * Google's userinfo endpoint over the access token we just got from Google ourselves, so there's no ID token to
 * verify. Only verified emails are accepted.
 */
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { cookieOf, setCookie } from "./session";

const STATE_COOKIE = "lwh_oauth_state";
const redirectUri = () => `${config.publicUrl}/_lw/auth/callback`;

/** GET /_lw/auth/google → Google's consent page. */
export function startLogin(): Response {
  const state = randomBytes(16).toString("base64url");
  const q = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: "code",
    scope: "openid email profile", state, prompt: "select_account",
  });
  return new Response(null, { status: 302, headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, "set-cookie": setCookie(STATE_COOKIE, state, 600) } });
}

export type GoogleUser = { sub: string; email: string; name: string };

/** GET /_lw/auth/callback: the verified Google user, or throws with a message to show. */
export async function finishLogin(req: Request, url: URL): Promise<GoogleUser> {
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (url.searchParams.get("error")) throw new Error(`Google said: ${url.searchParams.get("error")}`);
  if (!code || !state || state !== cookieOf(req, STATE_COOKIE)) throw new Error("This sign-in link expired. Try again.");
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  const t = await tok.json() as { access_token?: string; error?: string };
  if (!t.access_token) throw new Error(`Google sign-in failed (${t.error ?? tok.status})`);
  const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } });
  const u = await ui.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!u.sub || !u.email) throw new Error("Google didn't return an email address");
  if (!u.email_verified) throw new Error("That Google account's email isn't verified");
  return { sub: u.sub, email: u.email.toLowerCase(), name: u.name ?? "" };
}

export const clearState = () => setCookie(STATE_COOKIE, "", 0);
