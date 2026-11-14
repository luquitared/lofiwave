/**
 * lofiwave's Google sign-in relay: one redirect URI for Google, many consoles.
 *
 * Google only returns people to redirect URIs registered on the OAuth client. Register this Worker's
 * `/callback` once, set it as GOOGLE_REDIRECT_URI on each console, and every console can use the same
 * client without its own entry. A console puts its own callback in `state` (`{"n": nonce, "r": url}`,
 * base64url JSON); this forwards Google's answer (`code`, `state`, or `error`) there, unchanged.
 *
 * It holds no secret and keeps nothing. A code is only worth anything to the console that started the
 * sign-in (it has the client secret, the PKCE verifier and the browser's state cookie), and forwarding
 * goes only to `/api/auth/google/callback` on an origin that ALLOWED_ORIGINS lists:
 * comma-separated `scheme://host[:port]` patterns, where `*.` in front of a host means any subdomain
 * and `:*` any port (`https://*.example.com, http://localhost:*`).
 */
const CALLBACK_PATH = "/api/auth/google/callback";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return text(404, "lofiwave sign-in relay. Nothing here.");
    let target;
    try {
      const state = JSON.parse(atob((url.searchParams.get("state") ?? "").replace(/-/g, "+").replace(/_/g, "/")));
      target = new URL(state.r);
    } catch {
      return text(400, "This sign-in link is broken: it doesn't say which lofiwave started it. Start again from the console.");
    }
    if (target.pathname !== CALLBACK_PATH || target.username || target.password || !allowed(target, env.ALLOWED_ORIGINS ?? "")) {
      return text(403, `This relay doesn't sign people in to ${target.origin}. Add it to the relay's ALLOWED_ORIGINS.`);
    }
    target.search = url.search;
    target.hash = "";
    return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  },
};

export function allowed(target, spec) {
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return spec.split(",").map((s) => s.trim()).filter(Boolean).some((pattern) => {
    const m = pattern.match(/^(https?):\/\/(\*\.)?([^:/]+)(?::(\d+|\*))?\/?$/i);
    if (!m) return false;
    const [, scheme, any, host, p] = m;
    if (target.protocol !== `${scheme.toLowerCase()}:`) return false;
    const h = target.hostname.toLowerCase(), base = host.toLowerCase();
    if (any ? !(h.endsWith(`.${base}`)) : h !== base) return false;
    return p === "*" || port === (p ?? (scheme.toLowerCase() === "https" ? "443" : "80"));
  });
}

const text = (status, body) => new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
