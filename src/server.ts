import type { ServerWebSocket } from "bun";
import { join, dirname, basename } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { config } from "./config";
import { db, now, hydrate, type ProcessTypeRow, type WorkflowRow, type RunRow, type SessionRow } from "./db";
import { listOsProcesses, cwdOf, killTree, type OsProcess } from "./procs";
import { ApiError, startRun, killRun, restartRun, getRun, getType, readLogFrom, isLive, buildCommand, screenOf, historyOf, sendKeys, tmuxPath, recordSession, resumeSession, resumeAgentSession, enableRemoteControl } from "./runner";
import { describeSession, sessionForPid, locateSession, type SessionInfo } from "./agents";
import { startScheduler, refreshNextRun, runWorkflow, computeNext } from "./scheduler";
import { validateCron } from "./cron";
import { renderDocs, apiIndex } from "./docs";
import { ttyFor, ttySocket, type TtyData } from "./tty";
import { chatFor, chatSocket, chatEarlier, chatBlob, chatSubagent, type ChatData } from "./chat";
import { actor, identify, touch, online, passwordMatches, cleanName, makeSession, sessionCookie, loginBlocked, loginFailed, TOKEN_ACTOR } from "./auth";

const PUBLIC_DIR = join(config.root, "public");
const startedAt = now();

// ---------------------------------------------------------------- helpers

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function body(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(400, "request body must be JSON"); }
}

function str(v: unknown, field: string, { required = false, def = "" } = {}): string {
  if (v === undefined || v === null) {
    if (required) throw new ApiError(400, `${field} is required`);
    return def;
  }
  if (typeof v !== "string") throw new ApiError(400, `${field} must be a string`);
  if (required && !v.trim()) throw new ApiError(400, `${field} is required`);
  return v;
}
function strArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return v.trim() ? splitArgs(v) : [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ApiError(400, `${field} must be an array of strings`);
  return v;
}
function strMap(v: unknown, field: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, `${field} must be an object of string values`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as any)) out[k] = String(val);
  return out;
}
function int(v: unknown, field: string, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, `${field} must be a non-negative integer`);
  return n;
}
function bool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  throw new ApiError(400, "expected a boolean");
}
/** Split a shell-ish string into args, honoring single/double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function parseKind(v: unknown, def: string): string {
  if (v === undefined || v === null || v === "") return def;
  if (v !== "agent" && v !== "app") throw new ApiError(400, `kind must be "agent" or "app"`);
  return v;
}

/** An app's UI address: http(s), may contain {host}, which the console's page replaces with the host it was opened on. */
function parseUrl(v: unknown): string {
  const s = str(v, "url").trim();
  if (s && !/^https?:\/\/[^\s]+$/.test(s)) throw new ApiError(400, "url must start with http:// or https:// (use {host} for this machine, e.g. http://{host}:3000)");
  return s;
}

function typeWithAvailability(t: ProcessTypeRow) {
  const h = hydrate(t);
  const cmd = t.command.includes("{") ? t.command.split(/\s|\{/)[0] : t.command;
  return { ...h, available: Boolean(Bun.which(cmd, { PATH: process.env.PATH })), resolved: Bun.which(cmd, { PATH: process.env.PATH }) };
}

function workflowOut(w: WorkflowRow) {
  return hydrate(w);
}

function runOut(r: RunRow, { withOutput = true } = {}) {
  const h = hydrate(r);
  const out: any = { ...h, duration_ms: (r.ended_at ?? now()) - r.started_at, live: isLive(r.id) };
  if (!withOutput) delete out.output;
  else out.sessions = sessionsOf(r.id);
  return out;
}

function sessionsOf(runId: number): (SessionRow & Omit<SessionInfo, "agent" | "session_id">)[] {
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId);
  return db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at").all(runId).map((s) => {
    const info = describeSession(s.agent, s.session_id, { cwd: s.cwd, transcript_path: s.transcript_path, model: s.model, pid: run?.status === "running" ? run.pid : null });
    return { ...s, ...info, agent: s.agent, session_id: s.session_id, cwd: s.cwd || info.cwd, model: s.model || info.model, transcript_path: s.transcript_path || info.transcript_path };
  });
}
/** Latest recorded session of a run (for the process list). */
function latestSessionOf(runId: number) { const all = sessionsOf(runId); return all.length ? all[all.length - 1] : null; }
function getSession(runId: number, sessionId: string): SessionRow {
  const s = db.query<SessionRow, [number, string]>("SELECT * FROM sessions WHERE run_id = ? AND session_id = ?").get(runId, sessionId);
  if (!s) throw new ApiError(404, `session ${sessionId} not found on run ${runId}`);
  return s;
}
/** A session id from a request: it ends up in a file path lookup and on a command line, so only id characters. */
function sessionIdOf(v: unknown): string {
  const id = str(v, "session_id", { required: true }).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.includes("..")) throw new ApiError(400, "session_id has unexpected characters");
  return id;
}

function getWorkflow(id: number): WorkflowRow {
  const w = db.query<WorkflowRow, [number]>("SELECT * FROM workflows WHERE id = ?").get(id);
  if (!w) throw new ApiError(404, `workflow ${id} not found`);
  return w;
}

// ---------------------------------------------------------------- process listing

/** `drivable`: this process is an interactive run of ours, so the console already has a terminal on it. */
type ConsoleProcess = OsProcess & { type: string | null; run_id: number | null; managed: boolean; child: boolean; drivable: boolean; parent_cmd: string; workflow_name: string | null; session: SessionInfo | null };

async function listConsoleProcesses(filterType?: string, filterKind?: string): Promise<ConsoleProcess[]> {
  const allTypes = db.query<ProcessTypeRow, []>("SELECT * FROM process_types").all();
  const kindOf = new Map(allTypes.map((t) => [t.name, t.kind]));
  const types = allTypes.filter((t) => t.detect);
  const detectors = types.map((t) => {
    try { return { name: t.name, re: new RegExp(t.detect) }; } catch { return null; }
  }).filter(Boolean) as { name: string; re: RegExp }[];
  const runningRuns = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running' AND pid IS NOT NULL").all();
  const byPid = new Map(runningRuns.map((r) => [r.pid as number, r]));
  const self = process.pid;
  const os = (await listOsProcesses()).filter((p) => !/^tmux(\s|$)/.test(p.cmd));
  const parentOf = new Map(os.map((p) => [p.pid, p.ppid]));
  const cmdOf = new Map(os.map((p) => [p.pid, p.cmd]));
  /** Walk up the tree: is this pid a descendant of a managed run? */
  const owningRun = (pid: number): RunRow | null => {
    let cur = pid;
    for (let i = 0; i < 64 && cur > 1; i++) {
      const r = byPid.get(cur);
      if (r) return r;
      const pp = parentOf.get(cur);
      if (pp === undefined || pp === cur) break;
      cur = pp;
    }
    return null;
  };
  const out: ConsoleProcess[] = [];
  for (const p of os) {
    if (p.pid === self) continue;
    const run = owningRun(p.pid);
    let type = run?.type_name ?? null;
    if (!type) {
      // Skip the `ps`/powershell we spawned and anything mentioning this server.
      if (/^ps -eo |powershell.*Win32_Process|(?:agent-console|lofiwave)\/src\/server\.ts/.test(p.cmd)) continue;
      type = detectors.find((d) => d.re.test(p.cmd))?.name ?? null;
    }
    if (!type) continue;
    if (filterType && type !== filterType) continue;
    if (filterKind && kindOf.get(type) !== filterKind) continue;
    const child = Boolean(run && run.pid !== p.pid);
    // What the agent calls this session: Claude's own registry knows every running claude (managed or not); codex only via our run record.
    const session = sessionForPid(p.pid) ?? (run && !child ? latestSessionOf(run.id) : null);
    out.push({ ...p, type, run_id: run?.id ?? null, managed: Boolean(run), child, drivable: Boolean(run && !child && JSON.parse(run.meta || "{}").interactive), parent_cmd: cmdOf.get(p.ppid) ?? "", workflow_name: run?.workflow_name ?? null, session });
  }
  await Promise.all(out.map(async (p) => {
    p.cwd = byPid.get(p.pid)?.cwd ?? (await cwdOf(p.pid));
  }));
  out.sort((a, b) => (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0));
  return out;
}

// ---------------------------------------------------------------- routes

type Handler = (req: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, pattern, keys, handler });
}

route("GET", "/api", (req) => json(apiIndex(baseUrl(req))));
route("GET", "/api/docs", (req) =>
  new Response(renderDocs(baseUrl(req), true), { headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" } }));

route("GET", "/api/health", () => json({ ok: true, uptime_ms: now() - startedAt }));

route("GET", "/api/system", async () => {
  const addresses: Record<string, string[]> = {};
  const nets = (await import("node:os")).networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) (addresses[name] ??= []).push(a.address);
  }
  let tailscale: any = null;
  if (Bun.which("tailscale")) {
    try {
      const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
      const txt = await new Response(p.stdout).text();
      await p.exited;
      const s = JSON.parse(txt);
      tailscale = { state: s.BackendState, ips: s.TailscaleIPs ?? [], dns_name: s.Self?.DNSName?.replace(/\.$/, "") ?? null };
    } catch { tailscale = { state: "unknown" }; }
  }
  return json({
    hostname: hostname(), platform: process.platform, pid: process.pid, bun: Bun.version,
    tmux: tmuxPath(), host: config.host, port: config.port, data_dir: config.dataDir, auth_required: true,
    uptime_ms: now() - startedAt, addresses, tailscale, server_time: now(),
  });
});

// ---- people (with PASSWORD set: name + shared password login, and who's online)
route("GET", "/api/auth", () => json({ password_login: Boolean(config.password) }));

route("POST", "/api/login", async (req) => {
  const ip = clientIp(req);
  if (!config.password) throw new ApiError(400, "password login is off (set PASSWORD); use the API token");
  if (loginBlocked(ip)) throw new ApiError(429, "too many failed attempts; try again in a few minutes");
  const b = await body(req);
  const name = cleanName(b.name);
  if (!name) throw new ApiError(400, "name is required");
  if (name === TOKEN_ACTOR) throw new ApiError(400, `"${TOKEN_ACTOR}" is reserved; pick another name`);
  if (!passwordMatches(b.password)) { loginFailed(ip); throw new ApiError(401, "wrong password"); }
  const { value, maxAge } = makeSession(name);
  touch(name);
  const res = json({ ok: true, name });
  res.headers.set("set-cookie", sessionCookie(req, value, maxAge));
  return res;
});

route("POST", "/api/logout", (req) => {
  const res = json({ ok: true });
  res.headers.set("set-cookie", sessionCookie(req, "", 0));
  return res;
});

route("GET", "/api/me", () => json({ name: actor.getStore() ?? null, password_login: Boolean(config.password), online: online() }));

// ---- paths (recent working directories + filesystem completion, for the UI's path picker)
route("GET", "/api/paths", async (_r, _p, url) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(int(url.searchParams.get("limit"), "limit", 20), 100);
  const home = homedir();
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const seen = new Map<string, { path: string; source: string; last_used: number }>();
  const add = (path: string | null, source: string, last_used: number) => {
    if (!path) return;
    const cur = seen.get(path);
    if (!cur || cur.last_used < last_used || (cur.source === "process" && source !== "process")) seen.set(path, { path, source, last_used });
  };
  for (const r of db.query<{ cwd: string; t: number }, []>("SELECT cwd, MAX(started_at) t FROM runs GROUP BY cwd ORDER BY t DESC LIMIT 200").all()) add(r.cwd, "run", r.t);
  for (const w of db.query<{ cwd: string; t: number }, []>("SELECT cwd, COALESCE(last_run_at, updated_at) t FROM workflows").all()) add(w.cwd, "workflow", w.t);
  for (const p of await listConsoleProcesses()) add(p.cwd, "process", 0);
  const needle = expand(q).toLowerCase();
  let known = [...seen.values()].filter((e) => !needle || e.path.toLowerCase().includes(needle) || fuzzy(needle, e.path.toLowerCase()));
  known.sort((a, b) => b.last_used - a.last_used);
  known = known.slice(0, limit);

  // Filesystem completion: when the query looks like a path, list matching directories.
  const fs: { path: string; source: string; last_used: number }[] = [];
  if (q.startsWith("/") || q.startsWith("~") || q.startsWith(".")) {
    const full = expand(q);
    const endsWithSep = full.endsWith("/");
    const dir = endsWithSep ? full : dirname(full);
    const prefix = endsWithSep ? "" : basename(full).toLowerCase();
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && (prefix ? e.name.toLowerCase().startsWith(prefix) : !e.name.startsWith(".")))
        .map((e) => join(dir, e.name)).sort();
      for (const p of entries.slice(0, limit)) if (!seen.has(p) || !known.some((k) => k.path === p)) fs.push({ path: p, source: "fs", last_used: 0 });
    } catch { /* not a directory or unreadable */ }
  }
  return json({ paths: [...known, ...fs].slice(0, Math.max(limit, known.length + Math.min(fs.length, limit))), home });
});

/** Subsequence match ("robi2" matches "/home/x/robot/i2rt"). */
function fuzzy(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

// ---- process types
route("GET", "/api/process-types", () =>
  json(db.query<ProcessTypeRow, []>("SELECT * FROM process_types ORDER BY builtin DESC, name").all().map(typeWithAvailability)));

route("GET", "/api/process-types/:name", (_r, p) => json(typeWithAvailability(getType(p.name))));

route("POST", "/api/process-types", async (req) => {
  const b = await body(req);
  const name = str(b.name, "name", { required: true }).trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new ApiError(400, "name may only contain letters, digits, _ . -");
  const command = str(b.command, "command", { required: true });
  const args = strArray(b.args, "args");
  const env = strMap(b.env, "env");
  const detect = str(b.detect, "detect");
  if (detect) { try { new RegExp(detect); } catch (e: any) { throw new ApiError(400, `detect is not a valid regex: ${e.message}`); } }
  const kind = parseKind(b.kind, "app");
  const default_cwd = str(b.default_cwd, "default_cwd").trim();
  const interactive_args = strArray(b.interactive_args, "interactive_args");
  const resume_args = strArray(b.resume_args, "resume_args");
  const url = parseUrl(b.url);
  const t = now();
  try {
    db.prepare(`INSERT INTO process_types (name, description, command, args, interactive_args, resume_args, env, detect, builtin, kind, default_cwd, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)`)
      .run(name, str(b.description, "description"), command, JSON.stringify(args), JSON.stringify(interactive_args), JSON.stringify(resume_args), JSON.stringify(env), detect, kind, default_cwd, url, t, t);
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) throw new ApiError(409, `process type "${name}" already exists`);
    throw e;
  }
  return json(typeWithAvailability(getType(name)), 201);
});

route("PUT", "/api/process-types/:name", async (req, p) => {
  const cur = getType(p.name);
  const b = await body(req);
  const command = b.command === undefined ? cur.command : str(b.command, "command", { required: true });
  const args = b.args === undefined ? JSON.parse(cur.args) : strArray(b.args, "args");
  const env = b.env === undefined ? JSON.parse(cur.env) : strMap(b.env, "env");
  const detect = b.detect === undefined ? cur.detect : str(b.detect, "detect");
  if (detect) { try { new RegExp(detect); } catch (e: any) { throw new ApiError(400, `detect is not a valid regex: ${e.message}`); } }
  const description = b.description === undefined ? cur.description : str(b.description, "description");
  const kind = b.kind === undefined ? cur.kind : parseKind(b.kind, cur.kind);
  const default_cwd = b.default_cwd === undefined ? cur.default_cwd : str(b.default_cwd, "default_cwd").trim();
  const interactive_args = b.interactive_args === undefined ? JSON.parse(cur.interactive_args || "[]") : strArray(b.interactive_args, "interactive_args");
  const resume_args = b.resume_args === undefined ? JSON.parse(cur.resume_args || "[]") : strArray(b.resume_args, "resume_args");
  const url = b.url === undefined ? cur.url : parseUrl(b.url);
  db.prepare("UPDATE process_types SET description=?, command=?, args=?, interactive_args=?, resume_args=?, env=?, detect=?, kind=?, default_cwd=?, url=?, updated_at=? WHERE id=?")
    .run(description, command, JSON.stringify(args), JSON.stringify(interactive_args), JSON.stringify(resume_args), JSON.stringify(env), detect, kind, default_cwd, url, now(), cur.id);
  return json(typeWithAvailability(getType(p.name)));
});

route("DELETE", "/api/process-types/:name", (_r, p) => {
  const cur = getType(p.name);
  if (cur.builtin) throw new ApiError(400, "built-in process types cannot be deleted (you can edit them)");
  const used = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM workflows WHERE type_name = ?").get(p.name)!.n;
  if (used) throw new ApiError(409, `process type is used by ${used} workflow(s)`);
  db.prepare("DELETE FROM process_types WHERE id = ?").run(cur.id);
  return json({ ok: true });
});

// ---- processes (live view)
route("GET", "/api/processes", async (_r, _p, url) =>
  json(await listConsoleProcesses(url.searchParams.get("type") ?? undefined, url.searchParams.get("kind") ?? undefined)));

route("POST", "/api/processes", async (req) => {
  const b = await body(req);
  const typeName = str(b.type, "type", { required: true });
  const run = await startRun({
    typeName,
    cwd: str(b.cwd, "cwd") || getType(typeName).default_cwd,
    prompt: str(b.prompt, "prompt"),
    extraArgs: strArray(b.extra_args, "extra_args"),
    env: strMap(b.env, "env"),
    timeoutSec: int(b.timeout_sec, "timeout_sec", 0),
    interactive: bool(b.interactive, false),
    terminal: str(b.terminal, "terminal"),
    trigger: "manual",
  });
  return json(runOut(run), 201);
});

// ---- console (the session-first working view): everything live, in one call
route("GET", "/api/console", async () => {
  const running = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC").all();
  const withSessions = (r: RunRow) => ({ ...runOut(r, { withOutput: false }), sessions: sessionsOf(r.id) });
  // live: interactive runs — the ones with a tmux pane you can actually type into.
  const live = running.filter((r) => JSON.parse(r.meta || "{}").interactive).map(withSessions);
  // headless: running but not drivable (a scheduled workflow, `claude -p`); shown so the view accounts for all activity.
  const headless = running.filter((r) => !JSON.parse(r.meta || "{}").interactive).map(withSessions);
  const liveRunIds = new Set(live.map((r) => r.id));
  // adoptable: agent processes on this machine the console cannot drive (started in a terminal, or a headless run).
  const adoptable = (await listConsoleProcesses(undefined, "agent")).filter((p) => !p.child && !(p.run_id && liveRunIds.has(p.run_id)));
  return json({ live, headless, adoptable });
});

route("POST", "/api/processes/preview", async (req) => {
  const b = await body(req);
  const type = getType(str(b.type, "type", { required: true }));
  const interactive = bool(b.interactive, false);
  const { command, args } = buildCommand(type, { cwd: str(b.cwd, "cwd") || type.default_cwd || ".", prompt: str(b.prompt, "prompt"), extraArgs: strArray(b.extra_args, "extra_args"), interactive });
  return json({ command, args, interactive, tmux: interactive ? tmuxPath() : undefined });
});

route("DELETE", "/api/processes/:pid", async (_r, p, url) => {
  const pid = Number(p.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new ApiError(400, "invalid pid");
  if (pid === process.pid) throw new ApiError(400, "refusing to kill the console itself");
  const force = bool(url.searchParams.get("force"), false);
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE pid = ? AND status = 'running'").get(pid);
  if (run) return json({ ok: true, run: runOut(await killRun(run.id, force)) });
  try { await killTree(pid, force); } catch (e: any) {
    if (e?.code === "ESRCH") throw new ApiError(404, `no process with pid ${pid}`);
    if (e?.code === "EPERM") throw new ApiError(403, `not permitted to signal pid ${pid}`);
    throw e;
  }
  return json({ ok: true, pid, signal: force ? "SIGKILL" : "SIGTERM" });
});

// Turn on Remote Control in a running claude session: typed into its tmux pane, or (replace: true) by reopening it here.
route("POST", "/api/processes/:pid/remote-control", async (req, p) => {
  const pid = Number(p.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new ApiError(400, "invalid pid");
  const b = await body(req);
  const r = await enableRemoteControl(pid, { replace: bool(b.replace, false), terminal: str(b.terminal, "terminal") });
  return json({ ...r, run: r.run ? runOut(r.run) : undefined }, r.run ? 201 : 200);
});

// ---- workflows
function parseWorkflowBody(b: any, cur?: WorkflowRow) {
  const pick = <T,>(key: string, parse: (v: unknown) => T, def: T): T => (b[key] === undefined ? def : parse(b[key]));
  const name = pick("name", (v) => str(v, "name", { required: true }).trim(), cur?.name ?? "");
  if (!name) throw new ApiError(400, "name is required");
  const type_name = pick("type", (v) => str(v, "type", { required: true }), cur?.type_name ?? "");
  getType(type_name);
  const cwd = pick("cwd", (v) => str(v, "cwd"), cur?.cwd ?? "") || getType(type_name).default_cwd;
  if (!cwd) throw new ApiError(400, "cwd is required (the process type has no default_cwd)");
  const schedule = pick("schedule", (v) => str(v, "schedule").trim(), cur?.schedule ?? "");
  if (schedule) { const err = validateCron(schedule); if (err) throw new ApiError(400, `invalid schedule: ${err}`); }
  return {
    name, type_name, cwd, schedule,
    prompt: pick("prompt", (v) => str(v, "prompt"), cur?.prompt ?? ""),
    extra_args: pick("extra_args", (v) => strArray(v, "extra_args"), cur ? JSON.parse(cur.extra_args) : []),
    env: pick("env", (v) => strMap(v, "env"), cur ? JSON.parse(cur.env) : {}),
    enabled: pick("enabled", (v) => bool(v, true), cur ? cur.enabled === 1 : true),
    timeout_sec: pick("timeout_sec", (v) => int(v, "timeout_sec", 0), cur?.timeout_sec ?? 0),
    allow_overlap: pick("allow_overlap", (v) => bool(v, false), cur ? cur.allow_overlap === 1 : false),
  };
}

route("GET", "/api/workflows", () => json(db.query<WorkflowRow, []>("SELECT * FROM workflows ORDER BY name").all().map(workflowOut)));
route("GET", "/api/workflows/:id", (_r, p) => json(workflowOut(getWorkflow(Number(p.id)))));

route("POST", "/api/workflows", async (req) => {
  const w = parseWorkflowBody(await body(req));
  const t = now();
  let id: number;
  try {
    id = Number(db.prepare(
      `INSERT INTO workflows (name, type_name, cwd, prompt, extra_args, env, schedule, enabled, timeout_sec, allow_overlap, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(w.name, w.type_name, w.cwd, w.prompt, JSON.stringify(w.extra_args), JSON.stringify(w.env), w.schedule,
      w.enabled ? 1 : 0, w.timeout_sec, w.allow_overlap ? 1 : 0, w.enabled ? computeNext(w.schedule) : null, t, t).lastInsertRowid);
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) throw new ApiError(409, `workflow "${w.name}" already exists`);
    throw e;
  }
  return json(workflowOut(getWorkflow(id)), 201);
});

route("PUT", "/api/workflows/:id", async (req, p) => {
  const cur = getWorkflow(Number(p.id));
  const w = parseWorkflowBody(await body(req), cur);
  try {
    db.prepare(
      `UPDATE workflows SET name=?, type_name=?, cwd=?, prompt=?, extra_args=?, env=?, schedule=?, enabled=?, timeout_sec=?, allow_overlap=?, updated_at=? WHERE id=?`,
    ).run(w.name, w.type_name, w.cwd, w.prompt, JSON.stringify(w.extra_args), JSON.stringify(w.env), w.schedule,
      w.enabled ? 1 : 0, w.timeout_sec, w.allow_overlap ? 1 : 0, now(), cur.id);
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) throw new ApiError(409, `workflow "${w.name}" already exists`);
    throw e;
  }
  refreshNextRun(getWorkflow(cur.id));
  return json(workflowOut(getWorkflow(cur.id)));
});

route("DELETE", "/api/workflows/:id", (_r, p) => {
  const cur = getWorkflow(Number(p.id));
  db.prepare("DELETE FROM workflows WHERE id = ?").run(cur.id);
  return json({ ok: true });
});

route("POST", "/api/workflows/:id/run", async (_r, p) => json(runOut(await runWorkflow(getWorkflow(Number(p.id)), "manual")), 201));

// ---- runs
route("GET", "/api/runs", (_r, _p, url) => {
  const q = url.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (q.get("workflow_id")) { where.push("workflow_id = ?"); params.push(Number(q.get("workflow_id"))); }
  if (q.get("status")) { where.push("status = ?"); params.push(q.get("status")); }
  if (q.get("type")) { where.push("type_name = ?"); params.push(q.get("type")); }
  if (q.get("trigger")) { where.push("trigger = ?"); params.push(q.get("trigger")); }
  const limit = Math.min(int(q.get("limit"), "limit", 50), 500);
  const offset = int(q.get("offset"), "offset", 0);
  const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
  const rows = db.query<RunRow, any[]>(sql).all(...params, limit, offset);
  const total = db.query<{ n: number }, any[]>(`SELECT COUNT(*) n FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...params)!.n;
  return json({ total, limit, offset, runs: rows.map((r) => runOut(r, { withOutput: false })) });
});

route("GET", "/api/runs/:id", (_r, p) => json(runOut(getRun(Number(p.id)))));

route("GET", "/api/runs/:id/log", (_r, p, url) => {
  const run = getRun(Number(p.id));
  const offset = int(url.searchParams.get("offset"), "offset", 0);
  if (url.searchParams.get("raw") === "1") {
    return new Response(Bun.file(run.log_path ?? ""), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return json({ id: run.id, status: run.status, ...readLogFrom(run.log_path, offset) });
});

route("POST", "/api/runs/:id/kill", async (_r, p, url) => json(runOut(await killRun(Number(p.id), bool(url.searchParams.get("force"), false)))));
route("POST", "/api/runs/:id/restart", async (_r, p) => json(runOut(await restartRun(Number(p.id))), 201));

// ---- interactive runs (tmux): live screen + typing into it
route("GET", "/api/runs/:id/screen", async (_r, p, url) => json(await screenOf(getRun(Number(p.id)), int(url.searchParams.get("lines"), "lines", 200) || 200, int(url.searchParams.get("cols"), "cols", 0))));
route("GET", "/api/runs/:id/history", async (_r, p, url) => json(await historyOf(getRun(Number(p.id)), int(url.searchParams.get("lines"), "lines", 5000) || 5000)));
route("POST", "/api/runs/:id/keys", async (req, p) => {
  const b = await body(req);
  await sendKeys(getRun(Number(p.id)), str(b.text, "text"), strArray(b.keys, "keys"), bool(b.enter, true));
  return json({ ok: true });
});

// ---- sessions (reported by the agent's own hook; see scripts/claude-session-hook.sh)
route("GET", "/api/runs/:id/sessions", (_r, p) => json(sessionsOf(getRun(Number(p.id)).id)));

route("POST", "/api/runs/:id/sessions", async (req, p) => {
  const run = getRun(Number(p.id));
  const b = await body(req);
  const session_id = str(b.session_id, "session_id", { required: true }).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(session_id)) throw new ApiError(400, "session_id has unexpected characters");
  recordSession(run.id, { session_id, agent: str(b.agent, "agent") || "claude", cwd: str(b.cwd, "cwd"), transcript_path: str(b.transcript_path, "transcript_path"), model: str(b.model, "model"), source: str(b.source, "source") });
  return json(getSession(run.id, session_id), 201);
});

route("PUT", "/api/runs/:id/sessions/:sid", async (req, p) => {
  const run = getRun(Number(p.id));
  const s = getSession(run.id, p.sid);
  const b = await body(req);
  const ended = bool(b.ended, false);
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ?, model = CASE WHEN ? != '' THEN ? ELSE model END WHERE id = ?")
    .run(ended ? now() : s.ended_at, str(b.reason, "reason") || s.end_reason, str(b.model, "model"), str(b.model, "model"), s.id);
  return json(getSession(run.id, p.sid));
});

// Reopen a recorded session interactively (tmux, with the type's resume_args: claude gets --remote-control so it appears in the Claude app).
route("POST", "/api/runs/:id/sessions/:sid/resume", async (_r, p) => json(runOut(await resumeSession(Number(p.id), p.sid)), 201));
// Same, for a session the console did not start (e.g. a claude session seen on the Agents tab, or an id pasted in):
// {session_id, agent?, cwd?}. Without agent/cwd they come from the transcript on disk.
route("POST", "/api/sessions/resume", async (req) => {
  const b = await body(req);
  const session_id = sessionIdOf(b.session_id);
  let agent = str(b.agent, "agent"), cwd = str(b.cwd, "cwd");
  const found = !agent || !cwd ? locateSession(session_id, agent || undefined) : null;
  if (!agent) {
    if (!found) throw new ApiError(404, `no claude or codex session ${session_id} on this machine`);
    agent = found.agent;
  }
  cwd ||= found?.cwd ?? "";
  return json(runOut(await resumeAgentSession({ agent, sessionId: session_id, cwd, terminal: str(b.terminal, "terminal") })), 201);
});
// What a pasted session id points to (agent, folder, title), before resuming it. ?agent= narrows the search.
route("GET", "/api/sessions/:sid", (_r, p, url) => {
  const sid = sessionIdOf(p.sid);
  const found = locateSession(sid, url.searchParams.get("agent") || undefined);
  if (!found) throw new ApiError(404, `no claude or codex session ${sid} on this machine`);
  return json(found);
});

// The raw transcript (Claude Code writes JSONL under ~/.claude/projects/..., codex under ~/.codex/sessions/...). Only paths under the home dir are served.
route("GET", "/api/runs/:id/sessions/:sid/transcript", (_r, p) => {
  const s = sessionsOf(getRun(Number(p.id)).id).find((x) => x.session_id === p.sid);
  if (!s) throw new ApiError(404, `session ${p.sid} not found on run ${p.id}`);
  if (!s.transcript_path) throw new ApiError(404, "no transcript path recorded for this session");
  if (!s.transcript_path.startsWith(homedir() + "/")) throw new ApiError(403, "transcript path is outside the home directory");
  if (!existsSync(s.transcript_path)) throw new ApiError(404, `transcript not found on disk: ${s.transcript_path}`);
  return new Response(Bun.file(s.transcript_path), { headers: { "content-type": "text/plain; charset=utf-8" } });
});

// ---- chat view (read-only, from the transcript; the live updates come over the /chat WebSocket, see src/chat)
// GET …/chat?before=<ordinal>: the turns before what the browser has. GET …/chat/blob?ref=: an image or a long output.
// GET …/chat/subagent/:agent: a subagent's own conversation. The same three exist for any session by id.
for (const [prefix, kind] of [["/api/runs/:id", "run"], ["/api/sessions/:id", "session"]] as const) {
  route("GET", `${prefix}/chat`, (_r, p, url) => json(chatEarlier(kind, p.id, int(url.searchParams.get("before"), "before", Number.MAX_SAFE_INTEGER))));
  route("GET", `${prefix}/chat/blob`, (_r, p, url) => chatBlob(kind, p.id, str(url.searchParams.get("ref") ?? undefined, "ref", { required: true }), url.searchParams.get("agent") ?? ""));
  route("GET", `${prefix}/chat/subagent/:agent`, (_r, p) => json(chatSubagent(kind, p.id, p.agent)));
}

route("DELETE", "/api/runs/:id", async (_r, p) => {
  const run = getRun(Number(p.id));
  if (run.status === "running") throw new ApiError(409, "kill the run before deleting it");
  db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
  if (run.log_path) { try { await Bun.file(run.log_path).delete(); } catch { /* already gone */ } }
  return json({ ok: true });
});

// ---------------------------------------------------------------- server

function baseUrl(req: Request): string {
  const host = req.headers.get("host") ?? `${config.host}:${config.port}`;
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

const PUBLIC_API = new Set(["GET /api", "GET /api/", "GET /api/docs", "GET /api/auth", "POST /api/login", "POST /api/logout"]);

/** On every response: no framing (clickjacking a console that kills processes), and no Referer, since links can carry ?token=. */
function harden(res: Response): Response {
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("not found", { status: 404 });
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

/** The socket peer of each request, for login throttling. */
const peers = new WeakMap<Request, string>();
/** The client's address: the socket peer, or, behind a reverse proxy on this machine (Caddy), the X-Forwarded-For it set. */
function clientIp(req: Request): string {
  const peer = peers.get(req) ?? "";
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd && /^(127\.|::1$|::ffff:127\.)/.test(peer)) return fwd.split(",").at(-1)!.trim();
  return peer;
}

type WsData = TtyData | ChatData;
const isChat = (ws: ServerWebSocket<WsData>): ws is ServerWebSocket<ChatData> => (ws.data as ChatData).kind === "chat";

const server = Bun.serve<WsData>({
  hostname: config.host,
  port: config.port,
  async fetch(req, srv) {
    peers.set(req, srv.requestIP(req)?.address ?? "");
    const path = new URL(req.url).pathname;
    const ws = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const tty = ws && path.match(/^\/api\/runs\/(\d+)\/tty$/);
    const chat = ws && path.match(/^\/api\/(runs|sessions)\/([^/]+)\/chat$/);
    if (tty || chat) {
      const r = upgradeSocket(req, srv, (url, who) => tty ? ttyFor(Number(tty[1]), url, who) : chatFor(chat![1] === "runs" ? "run" : "session", decodeURIComponent(chat![2]), who));
      return r ? harden(r) : undefined;
    }
    return harden(await handle(req));
  },
  websocket: {
    open: (ws) => (isChat(ws) ? chatSocket.open(ws) : ttySocket.open(ws as ServerWebSocket<TtyData>)),
    message: (ws, msg) => (isChat(ws) ? chatSocket.message() : ttySocket.message(ws as ServerWebSocket<TtyData>, msg)),
    close: (ws) => (isChat(ws) ? chatSocket.close(ws) : ttySocket.close(ws as ServerWebSocket<TtyData>)),
  },
});

/**
 * The WebSockets: GET /api/runs/:id/tty, a live terminal on an interactive run (see src/tty.ts), and
 * GET /api/runs/:id/chat or /api/sessions/:sid/chat, the chat view's live feed (see src/chat). Returns a Response
 * only on failure.
 */
function upgradeSocket(req: Request, srv: Bun.Server<WsData>, make: (url: URL, who: string) => WsData): Response | undefined {
  const url = new URL(req.url);
  const who = identify(req, url);
  if (!who) return json({ error: "unauthorized" }, 401);
  // Browsers send Origin on every WebSocket and don't apply CORS to it: refuse other sites' pages outright.
  const origin = req.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== req.headers.get("host")) return json({ error: "cross-origin socket refused" }, 403); } catch { return json({ error: "bad origin" }, 403); } }
  touch(who);
  let data: WsData;
  try { data = make(url, who); } catch (e: any) { return json({ error: e.message }, e instanceof ApiError ? e.status : 500); }
  return srv.upgrade(req, { data }) ? undefined : json({ error: "websocket upgrade failed" }, 400);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/docs") return serveStatic("/docs.html");
  if (!url.pathname.startsWith("/api")) return serveStatic(url.pathname);
  const who = identify(req, url);
  if (!who && !PUBLIC_API.has(`${req.method} ${url.pathname}`)) return json({ error: "unauthorized" }, 401);
  if (who) touch(who);
  return who ? actor.run(who, () => dispatch(req, url)) : dispatch(req, url);
}

async function dispatch(req: Request, url: URL): Promise<Response> {
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.handler(req, params, url);
    }
    return json({ error: `no route for ${req.method} ${url.pathname}` }, 404);
  } catch (e: any) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error(`[api] ${req.method} ${url.pathname}`, e);
    return json({ error: e?.message ?? "internal error" }, 500);
  }
}

startScheduler();
console.log(`lofiwave listening on http://${server.hostname}:${server.port}  (data: ${config.dataDir})`);
if (config.tokenGenerated) {
  // First start: hand the person a link that logs the browser in (the UI keeps the token and drops it from the URL).
  // Only this once, since service logs may be readable by others; later starts just say where the token is.
  const host = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  console.log(`generated an access token (kept in ${config.tokenFile}); open:\n  http://${host}:${config.port}/#token=${config.authToken}`);
} else if (config.tokenFile) {
  console.log(`access token: ${config.tokenFile}`);
}
if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) console.log(`note: HOST=${config.host} — reachable from other machines on this network (token required)`);
if (config.password) console.log("password login: on (name + PASSWORD)");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { console.log(`\n${sig} received, shutting down (managed processes keep running)`); server.stop(true); process.exit(0); });
}
