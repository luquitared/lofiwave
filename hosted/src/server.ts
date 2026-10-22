/**
 * lofiwave hosted: sign in with Google, get your own machine (an E2B sandbox running lofiwave), use it here.
 * Our own routes live under /_lw/; every other path is the signed-in user's lofiwave, proxied (src/proxy.ts).
 */
import { join } from "node:path";
import { config, isLoopback } from "./config";
import { getUser, upsertUser, userCount, db, type UserRow } from "./db";
import { sessionCookie, clearSession, sessionUser, sameOrigin } from "./session";
import { startLogin, finishLogin, clearState } from "./google";
import { ensureMachine, machineState, forgetMachine, destroyMachine, startKeeper } from "./machines";
import { proxyHttp, proxySocket, wsData, type WsData } from "./proxy";
import { loginPage, startingPage, errorPage } from "./pages";

if (!config.e2bApiKey) { console.error("E2B_API_KEY is not set"); process.exit(1); }
if (config.devLogin && !isLoopback) { console.error("DEV_LOGIN=1 only works with HOST=127.0.0.1"); process.exit(1); }

const logo = Bun.file(join(import.meta.dir, "..", "..", "public", "logo.png"));
const redirect = (location: string, cookies: string[] = []) => {
  const h = new Headers({ location });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

/** May this email sign in? Existing users always; new ones if they're on the list and there's room. */
function admit(email: string): string | null {
  const known = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (known) return null;
  const domain = email.slice(email.indexOf("@"));
  if (config.allow.length && !config.allow.includes(email) && !config.allow.includes(domain)) return "This deployment is invite-only, and that account isn't on the list.";
  if (userCount() >= config.maxUsers) return "This deployment is full for now.";
  return null;
}

function signIn(email: string, name: string, sub: string | null): Response {
  const no = admit(email);
  if (no) return errorPage("Can't sign you in", no, 403);
  const u = upsertUser(email, name, sub);
  console.log(`[auth] ${email} signed in (user ${u.id})`);
  return redirect("/", [sessionCookie(u.id), clearState()]);
}

async function ours(req: Request, url: URL, u: UserRow | null): Promise<Response> {
  const p = url.pathname, m = req.method;
  if (p === "/_lw/logo.png") return new Response(logo, { headers: { "cache-control": "public, max-age=86400" } });
  if (p === "/_lw/login") return u ? redirect("/") : loginPage();
  if (p === "/_lw/logout") return redirect("/_lw/login", [clearSession()]);
  if (p === "/_lw/auth/google" && config.googleClientId) return startLogin();
  if (p === "/_lw/auth/callback") {
    try { const g = await finishLogin(req, url); return signIn(g.email, g.name, g.sub); }
    catch (e: any) { return errorPage("Sign-in failed", e.message ?? String(e)); }
  }
  if (p === "/_lw/auth/dev" && m === "POST" && config.devLogin && isLoopback) {
    const email = String((await req.formData()).get("email") ?? "").trim().toLowerCase();
    return email.includes("@") ? signIn(email, email.split("@")[0], null) : loginPage("Enter an email.");
  }
  if (!u) return Response.json({ error: "sign in first" }, { status: 401 });
  if (m !== "GET" && !sameOrigin(req)) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  // the machine: GET its state, POST to create it, POST reset to throw away a broken one and start over
  if (p === "/_lw/machine" && m === "GET") {
    const state = await machineState(u).catch(() => "running" as const);
    return Response.json({ state, error: u.machine_error });
  }
  if (p === "/_lw/machine" && m === "POST") { void ensureMachine(u.id); return Response.json({ ok: true }); }
  if (p === "/_lw/machine/reset" && m === "POST") {
    if (u.machine_status !== "ready") { await destroyMachine(u.id); void ensureMachine(u.id); }
    return Response.json({ ok: true });
  }
  if (p === "/_lw/me") return Response.json({ email: u.email, name: u.name, machine: u.machine_status, sandbox_id: u.sandbox_id });
  return Response.json({ error: "not found" }, { status: 404 });
}

const wantsHtml = (req: Request) => req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");

const server = Bun.serve<WsData, never>({
  port: config.port,
  hostname: config.host,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const id = sessionUser(req);
    const u = id ? getUser(id) ?? null : null;
    if (url.pathname.startsWith("/_lw/")) return ours(req, url, u);
    if (!u) return wantsHtml(req) ? redirect("/_lw/login") : Response.json({ error: "sign in first" }, { status: 401 });

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Cookies ride along on WebSockets from any site: only our own pages may open one.
      if (!sameOrigin(req) || !req.headers.get("origin")) return Response.json({ error: "cross-origin socket refused" }, { status: 403 });
      if (u.machine_status !== "ready") return Response.json({ error: "your machine isn't ready" }, { status: 503 });
      return srv.upgrade(req, { data: wsData(u, url) }) ? undefined : Response.json({ error: "websocket upgrade failed" }, { status: 400 });
    }
    if (!sameOrigin(req)) return Response.json({ error: "cross-origin request refused" }, { status: 403 });

    // A page load checks the machine still exists (a paused one is fine: the proxied request wakes it).
    if (u.machine_status === "ready" && wantsHtml(req) && (await machineState(u).catch(() => "running")) === "missing") {
      console.log(`[machines] user ${u.id}: sandbox ${u.sandbox_id} is gone; making a new one`);
      forgetMachine(u.id);
      return startingPage(u.email, null);
    }
    if (u.machine_status !== "ready") {
      return wantsHtml(req) ? startingPage(u.email, u.machine_status === "error" ? u.machine_error : null)
        : Response.json({ error: "your machine isn't ready" }, { status: 503 });
    }
    return proxyHttp(req, u);
  },
  websocket: proxySocket,
});

startKeeper();
console.log(`lofiwave hosted listening on http://${server.hostname}:${server.port} (public ${config.publicUrl}, template ${config.template})`);
