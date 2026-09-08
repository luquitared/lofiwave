import { join, dirname, basename } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { config } from "./config";
import { db, now, hydrate, type ProcessTypeRow, type WorkflowRow, type RunRow, type SessionRow } from "./db";
import { listOsProcesses, cwdOf, killTree, type OsProcess } from "./procs";
import { ApiError, startRun, killRun, restartRun, getRun, getType, readLogFrom, isLive, buildCommand, screenOf, sendKeys, tmuxPath } from "./runner";
import { startScheduler, refreshNextRun, runWorkflow, computeNext } from "./scheduler";
import { validateCron } from "./cron";
import { renderDocs, apiIndex } from "./docs";

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

function sessionsOf(runId: number): SessionRow[] {
  return db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at").all(runId);
}
function getSession(runId: number, sessionId: string): SessionRow {
  const s = db.query<SessionRow, [number, string]>("SELECT * FROM sessions WHERE run_id = ? AND session_id = ?").get(runId, sessionId);
  if (!s) throw new ApiError(404, `session ${sessionId} not found on run ${runId}`);
  return s;
}

function getWorkflow(id: number): WorkflowRow {
  const w = db.query<WorkflowRow, [number]>("SELECT * FROM workflows WHERE id = ?").get(id);
  if (!w) throw new ApiError(404, `workflow ${id} not found`);
  return w;
}

// ---------------------------------------------------------------- process listing

type ConsoleProcess = OsProcess & { type: string | null; run_id: number | null; managed: boolean; child: boolean; workflow_name: string | null };

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
  const os = await listOsProcesses();
  const parentOf = new Map(os.map((p) => [p.pid, p.ppid]));
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
      if (/^ps -eo |powershell.*Win32_Process|agent-console\/src\/server\.ts/.test(p.cmd)) continue;
      type = detectors.find((d) => d.re.test(p.cmd))?.name ?? null;
    }
    if (!type) continue;
    if (filterType && type !== filterType) continue;
    if (filterKind && kindOf.get(type) !== filterKind) continue;
    out.push({ ...p, type, run_id: run?.id ?? null, managed: Boolean(run), child: Boolean(run && run.pid !== p.pid), workflow_name: run?.workflow_name ?? null });
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
  new Response(renderDocs(baseUrl(req), Boolean(config.authToken)), { headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" } }));

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
    tmux: tmuxPath(), host: config.host, port: config.port, data_dir: config.dataDir, auth_required: Boolean(config.authToken),
    uptime_ms: now() - startedAt, addresses, tailscale, server_time: now(),
  });
});

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
  const t = now();
  try {
    db.prepare(`INSERT INTO process_types (name, description, command, args, interactive_args, env, detect, builtin, kind, default_cwd, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`)
      .run(name, str(b.description, "description"), command, JSON.stringify(args), JSON.stringify(interactive_args), JSON.stringify(env), detect, kind, default_cwd, t, t);
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
  db.prepare("UPDATE process_types SET description=?, command=?, args=?, interactive_args=?, env=?, detect=?, kind=?, default_cwd=?, updated_at=? WHERE id=?")
    .run(description, command, JSON.stringify(args), JSON.stringify(interactive_args), JSON.stringify(env), detect, kind, default_cwd, now(), cur.id);
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
    trigger: "manual",
  });
  return json(runOut(run), 201);
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
route("GET", "/api/runs/:id/screen", async (_r, p, url) => json(await screenOf(getRun(Number(p.id)), int(url.searchParams.get("lines"), "lines", 200) || 200)));
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
  const t = now();
  db.prepare(
    `INSERT INTO sessions (run_id, session_id, agent, cwd, transcript_path, model, source, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
       transcript_path = CASE WHEN excluded.transcript_path != '' THEN excluded.transcript_path ELSE sessions.transcript_path END,
       model = CASE WHEN excluded.model != '' THEN excluded.model ELSE sessions.model END,
       source = CASE WHEN excluded.source != '' THEN excluded.source ELSE sessions.source END`,
  ).run(run.id, session_id, str(b.agent, "agent") || "claude", str(b.cwd, "cwd"), str(b.transcript_path, "transcript_path"),
    str(b.model, "model"), str(b.source, "source"), t);
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

// The raw transcript (Claude Code writes JSONL under ~/.claude/projects/...). Only paths under the home dir are served.
route("GET", "/api/runs/:id/sessions/:sid/transcript", (_r, p) => {
  const s = getSession(getRun(Number(p.id)).id, p.sid);
  if (!s.transcript_path) throw new ApiError(404, "no transcript path recorded for this session");
  if (!s.transcript_path.startsWith(homedir() + "/")) throw new ApiError(403, "transcript path is outside the home directory");
  if (!existsSync(s.transcript_path)) throw new ApiError(404, `transcript not found on disk: ${s.transcript_path}`);
  return new Response(Bun.file(s.transcript_path), { headers: { "content-type": "text/plain; charset=utf-8" } });
});

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

const PUBLIC_API = new Set(["/api", "/api/", "/api/docs"]);
function authorized(req: Request, url: URL): boolean {
  if (!config.authToken) return true;
  if (PUBLIC_API.has(url.pathname) && req.method === "GET") return true;
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ") && h.slice(7).trim() === config.authToken) return true;
  if (req.headers.get("x-auth-token") === config.authToken) return true;
  if (url.searchParams.get("token") === config.authToken) return true;
  return false;
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("not found", { status: 404 });
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/docs") return serveStatic("/docs.html");
    if (!url.pathname.startsWith("/api")) return serveStatic(url.pathname);
    if (!authorized(req, url)) return json({ error: "unauthorized" }, 401);
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
  },
});

startScheduler();
console.log(`agent-console listening on http://${server.hostname}:${server.port}  (data: ${config.dataDir}${config.authToken ? ", auth token required" : ""})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { console.log(`\n${sig} received, shutting down (managed processes keep running)`); server.stop(true); process.exit(0); });
}
