/**
 * End to end against a running hosted server with DEV_LOGIN=1 and a real E2B key (it creates a real machine):
 *   BASE=http://127.0.0.1:7781 E2B_API_KEY=… bun run test/e2e.ts [--keep]
 * Signs in, creates the machine, loads lofiwave through the proxy, starts an interactive run, drives its terminal
 * over the proxied WebSocket, pauses the machine, and checks that a page load and a terminal both wake it.
 */
import { Sandbox } from "e2b";

const BASE = process.env.BASE || "http://127.0.0.1:7781";
const EMAIL = process.env.EMAIL || `e2e-${Date.now()}@example.com`;
const apiKey = process.env.E2B_API_KEY!;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
let failures = 0;
const check = (ok: boolean, what: string) => { log(ok ? "PASS" : "FAIL", what); if (!ok) failures++; };

// sign in
const r0 = await fetch(`${BASE}/_lw/auth/dev`, { method: "POST", body: new URLSearchParams({ email: EMAIL }), redirect: "manual", headers: { origin: BASE } });
const cookie = (r0.headers.getSetCookie().find((c) => c.startsWith("lwh_session=")) ?? "").split(";")[0];
check(r0.status === 302 && Boolean(cookie), `dev sign-in as ${EMAIL}`);
const H = { cookie, origin: BASE };
const get = (p: string, accept = "application/json") => fetch(BASE + p, { headers: { ...H, accept }, redirect: "manual" });

check((await fetch(`${BASE}/api/me`)).status === 401, "no cookie → 401");
check((await fetch(`${BASE}/`, { headers: { accept: "text/html" }, redirect: "manual" })).headers.get("location") === "/_lw/login", "no cookie, page → login");
check((await get("/", "text/html").then((r) => r.text())).includes("Starting your machine"), "first visit shows the starting page");

// create the machine
let t = Date.now();
await fetch(`${BASE}/_lw/machine`, { method: "POST", headers: H });
let state = "";
while (Date.now() - t < 180_000) {
  state = (await (await get("/_lw/machine")).json()).state;
  if (!["none", "creating"].includes(state)) break;
  await Bun.sleep(1500);
}
check(state === "running", `machine created (${state}) in ${Date.now() - t} ms`);
const me = await (await get("/_lw/me")).json();
log("machine", me.sandbox_id);

// lofiwave through the proxy, no token anywhere on our side
const page = await (await get("/", "text/html")).text();
check(page.includes("app.js"), "lofiwave UI served at /");
const lwMe = await (await get("/api/me")).json();
check(lwMe.name === "api", `lofiwave API authorized by the proxy (${JSON.stringify(lwMe)})`);
check((await fetch(`${BASE}/api/me`, { headers: { ...H, origin: "https://evil.example" } })).status === 403, "cross-origin request → 403");

// an interactive run: a ticker in tmux
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
await post("/api/process-types", { name: "ticker", kind: "agent", command: "bash", args: ["-c", "i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done"] });
const run = await post("/api/processes", { type: "ticker", cwd: "/home/user", interactive: true });
check(run.status === "running", `interactive run ${run.id} started`);

/** The run's terminal through our proxy: time to two ticks, and whether typed input echoes back. */
function term(origin = BASE, type?: string) {
  return new Promise<{ ok: boolean; ms: number; echoed: boolean; err?: string }>((resolve) => {
    const t0 = Date.now();
    let buf = "", done = false, sent = false;
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/runs/${run.id}/tty?cols=100&rows=30`, { headers: { cookie, origin } } as any);
    ws.binaryType = "arraybuffer";
    const end = (r: any) => { if (!done) { done = true; try { ws.close(); } catch {} resolve({ ms: Date.now() - t0, echoed: false, ...r }); } };
    ws.onopen = () => ws.send(JSON.stringify({ t: "r", cols: 100, rows: 30 }));
    ws.onmessage = (e) => {
      buf += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      const ticks = (buf.match(/tick \d+/g) ?? []).length;
      if (ticks >= 2 && type && !sent) { sent = true; ws.send(JSON.stringify({ t: "i", d: type })); }
      if (ticks >= 2 && (!type || buf.includes(type))) end({ ok: true, echoed: Boolean(type && buf.includes(type)) });
    };
    ws.onerror = () => end({ ok: false, err: "error" });
    ws.onclose = (e) => end({ ok: false, err: `closed ${e.code}` });
    setTimeout(() => end({ ok: false, err: "timeout" }), 30_000);
  });
}
const t1 = await term(BASE, "hello-from-e2e");
check(t1.ok && t1.echoed, `terminal through the proxy, typing echoes (${t1.ms} ms)`);
const t2 = await term("https://evil.example");
check(!t2.ok, `terminal from another origin refused (${t2.err})`);

// pause, then wake it with a page load and with a terminal
await Sandbox.pause(me.sandbox_id, { apiKey });
check((await Sandbox.getInfo(me.sandbox_id, { apiKey })).state === "paused", "machine paused");
t = Date.now();
const woke = await get("/api/me");
check(woke.status === 200, `API call wakes a paused machine (${Date.now() - t} ms)`);
await Sandbox.pause(me.sandbox_id, { apiKey });
const t3 = await term();
check(t3.ok, `terminal wakes a paused machine (${t3.ms} ms)`);
check((await Sandbox.getInfo(me.sandbox_id, { apiKey })).state === "running", "machine running again");

// the keeper extends a busy machine: our touch above pushed the end out by IDLE_SEC
const info = await Sandbox.getInfo(me.sandbox_id, { apiKey });
log("machine ends at", info.endAt, "now", new Date().toISOString());

if (!process.argv.includes("--keep")) { await Sandbox.kill(me.sandbox_id, { apiKey }); log("machine killed"); }
log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
