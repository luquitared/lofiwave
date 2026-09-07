/**
 * Starts and tracks managed processes ("runs"). Every process started through the
 * console — ad-hoc or from a workflow — is a row in `runs` with its own log file.
 */
import { join } from "node:path";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { db, now, hydrate, type ProcessTypeRow, type RunRow, type WorkflowRow } from "./db";
import { config, logDir } from "./config";
import { killTree, pidAlive } from "./procs";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** In-memory handles for runs started by this server process. */
type LiveEntry = { proc: Bun.Subprocess; timer?: ReturnType<typeof setTimeout>; killedBy?: string; done: Promise<void> };
const live = new Map<number, LiveEntry>();

export function getType(name: string): ProcessTypeRow {
  const t = db.query<ProcessTypeRow, [string]>("SELECT * FROM process_types WHERE name = ?").get(name);
  if (!t) throw new ApiError(404, `unknown process type "${name}"`);
  return t;
}

export function getRun(id: number): RunRow {
  const r = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
  if (!r) throw new ApiError(404, `run ${id} not found`);
  return r;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export type StartOptions = {
  typeName: string;
  cwd: string;
  prompt?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  trigger: string;
  workflow?: WorkflowRow | null;
  timeoutSec?: number;
};

export function buildCommand(type: ProcessTypeRow, opts: { cwd: string; prompt?: string; extraArgs?: string[] }) {
  const templateArgs: string[] = JSON.parse(type.args || "[]");
  const prompt = opts.prompt ?? "";
  const needsPrompt = templateArgs.some((a) => a.includes("{prompt}")) || type.command.includes("{prompt}");
  if (needsPrompt && !prompt.trim()) throw new ApiError(400, `process type "${type.name}" requires a prompt`);
  const vars = { prompt, cwd: opts.cwd };
  const args = [...templateArgs.map((a) => substitute(a, vars)), ...(opts.extraArgs ?? [])];
  return { command: substitute(type.command, vars), args };
}

export async function startRun(opts: StartOptions): Promise<RunRow> {
  const type = getType(opts.typeName);
  const cwd = opts.cwd?.trim();
  if (!cwd) throw new ApiError(400, "cwd is required");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ApiError(400, `cwd does not exist: ${cwd}`);
  const { command, args } = buildCommand(type, opts);
  const typeEnv: Record<string, string> = JSON.parse(type.env || "{}");
  const env = { ...typeEnv, ...(opts.env ?? {}) };
  const t = now();
  const timeoutSec = opts.timeoutSec ?? opts.workflow?.timeout_sec ?? 0;

  const ins = db.prepare(
    `INSERT INTO runs (workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger, status, started_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    opts.workflow?.id ?? null, opts.workflow?.name ?? null, type.name, cwd, command, JSON.stringify(args),
    opts.prompt ?? "", JSON.stringify(env), opts.trigger, t, JSON.stringify({ timeout_sec: timeoutSec }),
  );
  const id = Number(ins.lastInsertRowid);
  const logPath = join(logDir, `run-${id}.log`);
  db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(logPath, id);

  const sink = Bun.file(logPath).writer();
  const header = `# agent-console run ${id} | ${new Date(t).toISOString()} | cwd=${cwd}\n# $ ${[command, ...args].map(shellQuote).join(" ")}\n\n`;
  sink.write(header);
  sink.flush();

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd,
      env: { ...process.env, ...env, AGENT_CONSOLE_RUN_ID: String(id) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: any) {
    const msg = `failed to spawn "${command}": ${e?.message ?? e}`;
    sink.write(`\n${msg}\n`);
    await sink.end();
    db.prepare("UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ?").run(now(), msg, id);
    throw new ApiError(400, msg);
  }

  db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(proc.pid, id);
  if (opts.workflow) db.prepare("UPDATE workflows SET last_run_at = ? WHERE id = ?").run(t, opts.workflow.id);

  let markDone!: () => void;
  const entry: LiveEntry = { proc, done: new Promise<void>((res) => (markDone = res)) };
  live.set(id, entry);
  if (timeoutSec > 0) {
    entry.timer = setTimeout(() => {
      entry.killedBy = "timeout";
      sink.write(`\n# agent-console: timeout after ${timeoutSec}s, killing process tree\n`);
      killTree(proc.pid, true).catch(() => {});
    }, timeoutSec * 1000);
  }

  const pump = async (stream: ReadableStream<Uint8Array> | undefined | null) => {
    if (!stream) return;
    for await (const chunk of stream) { sink.write(chunk); sink.flush(); }
  };
  const io = Promise.all([pump(proc.stdout as any), pump(proc.stderr as any)]);

  (async () => {
    const code = await proc.exited;
    // Grandchildren may still hold the pipes open; don't wait on them forever.
    await Promise.race([io.catch(() => {}), Bun.sleep(3000)]);
    if (entry.timer) clearTimeout(entry.timer);
    const status = entry.killedBy === "timeout" ? "timeout" : entry.killedBy ? "killed" : code === 0 ? "success" : "failed";
    sink.write(`\n# agent-console: exited with code ${code} (${status})\n`);
    await sink.end();
    live.delete(id);
    db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ? WHERE id = ?")
      .run(status, now(), code, readTail(logPath, config.outputTailBytes), id);
    markDone();
  })();

  return getRun(id);
}

export async function killRun(id: number, force = false): Promise<RunRow> {
  const run = getRun(id);
  if (run.status !== "running" || !run.pid) throw new ApiError(409, `run ${id} is not running`);
  const entry = live.get(id);
  if (entry) entry.killedBy = "user";
  await killTree(run.pid, force);
  if (entry) {
    // Give the exit handler a moment to record the final status.
    await Promise.race([entry.done, Bun.sleep(force ? 2000 : 5000)]);
  } else {
    // Orphan from a previous server instance: we can't await exit, so poll briefly.
    for (let i = 0; i < 20 && pidAlive(run.pid); i++) await Bun.sleep(100);
    if (!pidAlive(run.pid)) {
      db.prepare("UPDATE runs SET status = 'killed', ended_at = ? WHERE id = ?").run(now(), id);
    }
  }
  return getRun(id);
}

export async function restartRun(id: number): Promise<RunRow> {
  const run = getRun(id);
  if (run.status === "running") await killRun(id, false);
  const wf = run.workflow_id
    ? db.query<WorkflowRow, [number]>("SELECT * FROM workflows WHERE id = ?").get(run.workflow_id)
    : null;
  const type = getType(run.type_name);
  const templateArgs: string[] = JSON.parse(type.args || "[]");
  const finalArgs: string[] = JSON.parse(run.args || "[]");
  const extraArgs = finalArgs.slice(templateArgs.length);
  const meta = JSON.parse(run.meta || "{}");
  return startRun({
    typeName: run.type_name, cwd: run.cwd, prompt: run.prompt, extraArgs,
    env: JSON.parse(run.env || "{}"), trigger: "restart", workflow: wf, timeoutSec: meta.timeout_sec ?? 0,
  });
}

export function readTail(path: string | null, bytes: number): string {
  if (!path || !existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** Read log bytes from `offset`; returns new data plus the new offset (for polling clients). */
export function readLogFrom(path: string | null, offset: number, maxBytes = 512 * 1024) {
  if (!path || !existsSync(path)) return { data: "", offset: 0, size: 0 };
  const size = statSync(path).size;
  const start = Math.min(Math.max(0, offset), size);
  const len = Math.min(size - start, maxBytes);
  if (len === 0) return { data: "", offset: start, size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { data: buf.toString("utf8"), offset: start + len, size };
  } finally { closeSync(fd); }
}

/** Called at startup and periodically: fix up runs whose process we no longer control. */
export function reconcileRuns() {
  const running = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running'").all();
  for (const r of running) {
    if (live.has(r.id)) continue;
    if (r.pid && pidAlive(r.pid)) {
      const meta = JSON.parse(r.meta || "{}");
      if (!meta.orphan) {
        meta.orphan = true;
        db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), r.id);
      }
      continue;
    }
    db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?")
      .run(now(), "process disappeared while the console was not running", readTail(r.log_path, config.outputTailBytes), r.id);
  }
}

export function isLive(id: number) { return live.has(id); }
export function liveRunIds() { return [...live.keys()]; }

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { hydrate };
