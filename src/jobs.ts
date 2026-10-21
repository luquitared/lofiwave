/**
 * Starting runs from the API with admission control, and the queue for ones that have to wait.
 *
 * When the machine is full (src/capacity.ts) an agent run is refused with 429, or with `queue: true` it becomes a
 * run with status `queued` that starts, oldest first, once a slot and the memory are there. The queue is just rows
 * in `runs`, so it survives a restart of the console.
 */
import { db, now, type RunRow } from "./db";
import { ApiError, startRun, getType, getRun, buildCommand, type StartOptions } from "./runner";
import { admissionBlocker, queuedRuns } from "./capacity";
import { existsSync, statSync } from "node:fs";
import { actor } from "./auth";

/** What a queued run is started with later (StartOptions minus the parts that only make sense now). */
type QueuedOpts = Omit<StartOptions, "workflow" | "meta" | "runId">;

/**
 * Start a run, or (agent types, machine full) refuse it with 429 or queue it. `prepare` runs once it is decided the
 * run will start or wait (not when it is refused): that is where the caller makes its folder and writes its files.
 */
export async function startJob(opts: StartOptions, o: { queue?: boolean; prepare?: () => void } = {}): Promise<RunRow> {
  if (getType(opts.typeName).kind === "agent") {
    // Runs already waiting go first: a new one only jumps in when nothing is queued.
    const waiting = queuedRuns();
    const blocked = admissionBlocker() ?? (waiting ? `${waiting} run${waiting === 1 ? " is" : "s are"} already queued` : null);
    if (blocked) {
      if (!o.queue) throw new ApiError(429, `machine is full: ${blocked}. Try again later, or pass "queue": true to start it when there is room.`);
      o.prepare?.();
      return enqueue(opts);
    }
  }
  o.prepare?.();
  return startRun(opts);
}

function enqueue(opts: StartOptions): RunRow {
  const type = getType(opts.typeName);
  const cwd = opts.cwd?.trim();
  if (!cwd) throw new ApiError(400, "cwd is required");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ApiError(400, `cwd does not exist: ${cwd}`);
  // Fail now on a bad request rather than when its turn comes.
  const { command, args } = buildCommand(type, opts);
  const { workflow: _w, meta: extra, runId: _r, ...rest } = opts;
  const queued: QueuedOpts = { ...rest, cwd };
  const meta: Record<string, any> = { ...(extra ?? {}), queued, queued_at: now() };
  const by = actor.getStore();
  if (by) meta.started_by = by;
  const ins = db.prepare(
    `INSERT INTO runs (type_name, cwd, command, args, prompt, env, trigger, status, started_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(type.name, cwd, command, JSON.stringify(args), opts.prompt ?? "", JSON.stringify(opts.env ?? {}), opts.trigger, now(), JSON.stringify(meta));
  kick();
  return getRun(Number(ins.lastInsertRowid));
}

let pumping = false;
/** Start the oldest queued run if there is room. One per call, so memory use of the last one shows before the next. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const next = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
    if (!next || admissionBlocker()) return;
    const { queued, ...meta } = JSON.parse(next.meta || "{}");
    try {
      await startRun({ ...(queued as QueuedOpts), meta, runId: next.id });
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 429 || e.status === 409)) return;   // full again, or cancelled meanwhile
      // Can't ever start (its folder went away, its type was deleted, ...): don't block the queue behind it.
      db.prepare("UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ? AND status = 'queued'").run(now(), `could not start from the queue: ${e?.message ?? e}`, next.id);
    }
  } finally { pumping = false; }
}

function kick() { setTimeout(() => pump().catch((e) => console.error("[queue]", e)), 0); }

export function startQueue(intervalMs = 3000) {
  setInterval(() => pump().catch((e) => console.error("[queue]", e)), intervalMs);
  kick();
}
