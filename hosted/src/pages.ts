/** The few pages that are ours: sign-in, "starting your machine", and errors. Everything else is lofiwave's. */
import { config, isLoopback } from "./config";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, script = ""): Response {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/_lw/logo.png">
<style>
  :root { --bg: #f7f6f3; --fg: #1d1c1a; --muted: #6b6862; --card: #fff; --line: #e4e1da; --accent: #3b5bdb; --bad: #c92a2a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #ecebe7; --muted: #9a978f; --card: #1e1d1b; --line: #2e2d2a; --accent: #7c95f5; --bad: #ff8787; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  a { color: var(--accent); }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; text-align: center; }
  img { width: 56px; height: 56px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  p { color: var(--muted); margin: 8px 0; }
  .btn { display: inline-block; width: 100%; margin-top: 16px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--fg); color: var(--bg); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn.secondary { background: transparent; color: var(--fg); }
  input { width: 100%; margin-top: 12px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  .err { color: var(--bad); }
  .spin { width: 22px; height: 22px; margin: 16px auto 0; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: s 0.8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  small { color: var(--muted); }
</style></head>
<body><main><img src="/_lw/logo.png" alt=""><h1>${esc(title)}</h1>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function loginPage(error = ""): Response {
  const google = config.googleClientId ? `<a class="btn" href="/_lw/auth/google">Sign in with Google</a>` : "";
  const dev = config.devLogin && isLoopback
    ? `<form method="post" action="/_lw/auth/dev"><input name="email" type="email" placeholder="email (dev sign-in)" required><button class="btn secondary">Sign in (dev)</button></form>`
    : "";
  return page("lofiwave", `<p>Your own cloud machine for Claude Code and Codex, with a live terminal in the browser.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}${google}${dev}${!google && !dev ? `<p class="err">No sign-in method is set up (GOOGLE_CLIENT_ID).</p>` : ""}`);
}

/** Shown until the user's machine is ready: starts it, polls, then reloads into lofiwave. */
export function startingPage(email: string, error: string | null): Response {
  return page("Starting your machine", `<p>A cloud machine just for <b>${esc(email)}</b>. The first start takes a few seconds;
after that it sleeps when you're away and wakes in under a second.</p>
<div class="spin" id="spin"></div><p id="msg" class="${error ? "err" : ""}">${error ? esc(error) : ""}</p>
<button class="btn secondary" id="retry" hidden>Try again</button>
<p><small><a href="/_lw/logout">Sign out</a></small></p>`,
  `const msg = document.getElementById("msg"), spin = document.getElementById("spin"), retry = document.getElementById("retry");
async function go(reset) {
  retry.hidden = true; spin.hidden = false; msg.className = ""; msg.textContent = "";
  await fetch(reset ? "/_lw/machine/reset" : "/_lw/machine", { method: "POST" });
  for (;;) {
    const s = await (await fetch("/_lw/machine")).json();
    if (s.state === "running" || s.state === "paused") return location.reload();
    if (s.state === "error") { spin.hidden = true; msg.className = "err"; msg.textContent = s.error || "Something went wrong."; retry.hidden = false; return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
retry.onclick = () => go(true);
go(${error ? "true" : "false"});`);
}

export const errorPage = (title: string, msg: string, status = 400) => {
  const r = page(title, `<p class="err">${esc(msg)}</p><a class="btn secondary" href="/_lw/login">Back</a>`);
  return new Response(r.body, { status, headers: r.headers });
};
