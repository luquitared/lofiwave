/**
 * Watches, and the Watching tab: what agents are waiting on, and lofiwave doing the waiting for them.
 *
 * A **watch** belongs to a run: a condition (a process exits, a command succeeds, a file appears or changes, a time,
 * another run going idle or ending), optionally a progress reading (a command's last line, or a file's size), and a
 * message. lofiwave checks it every `every_sec`; when the condition is met, or the progress hasn't changed for
 * `stall_sec`, or it expires, it types the message into the run, once the agent is idle. Watches are rows in SQLite,
 * so they survive restarts of lofiwave and of the agent. Every check that matters (progress changes, stalls, stalls
 * clearing, deliveries) goes in `watch_events`, so we can tell if stall detection fires too often or too late
 * (`watchStats`).
 *
 * **Watching** (`watching()`) reads each running claude run's transcript for what it is waiting on: background shells,
 * background agents and monitors (and whether Claude was told they ended), a ScheduleWakeup and whether it came, and
 * the last thing the agent said. From that it flags the runs that need someone: waiting on a prompt, ended its turn
 * with a question, stopped on an API error, promised to report back with nothing to wake it, a missed wakeup, or a
 * background shell that has gone quiet or that Claude no longer tracks. See docs/watching.md.
 */
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { db, now, type RunRow } from "./db";
import { ApiError, getRun, activityOf, sendMessage, noteClaudeSession, idleKeepers } from "./runner";
import { claudeRegistry, claudeTranscriptPath } from "./agents";
import { readLines, transcriptMark, recordMessage } from "./messages";

db.exec(`
CREATE TABLE IF NOT EXISTS watches (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  label          TEXT NOT NULL DEFAULT '',
  until_kind     TEXT NOT NULL,              -- exit | cmd | file | at | run | none
  until_arg      TEXT NOT NULL DEFAULT '',   -- pid | shell command | path | Unix ms | "<run>:idle|done" | ''
  progress_kind  TEXT NOT NULL DEFAULT '',   -- '' | cmd | file
  progress_arg   TEXT NOT NULL DEFAULT '',
  every_sec      INTEGER NOT NULL,
  stall_sec      INTEGER NOT NULL DEFAULT 0, -- 0: no stall detection
  expires_at     INTEGER,
  message        TEXT NOT NULL DEFAULT '',   -- what to tell the agent, after lofiwave's own line
  status         TEXT NOT NULL DEFAULT 'active', -- active | delivering (fired, message not typed yet) | done | cancelled
  outcome        TEXT NOT NULL DEFAULT '',   -- met | expired | run_ended | cancelled | fired
  created_by     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  next_check_at  INTEGER NOT NULL,
  last_check_at  INTEGER,
  checks         INTEGER NOT NULL DEFAULT 0,
  check_error    TEXT NOT NULL DEFAULT '',
  baseline       TEXT NOT NULL DEFAULT '',   -- the file's signature when the watch was made (until_kind file)
  progress       TEXT NOT NULL DEFAULT '',   -- the last progress reading
  progress_at    INTEGER,                    -- when the reading last changed
  max_quiet_sec  INTEGER NOT NULL DEFAULT 0, -- the longest it went without changing (ended stretches)
  stalls         INTEGER NOT NULL DEFAULT 0,
  stalled_at     INTEGER,                    -- set while a stall is open (cleared when progress moves again)
  pending        TEXT NOT NULL DEFAULT '',   -- a message waiting for the agent to be free
  pending_at     INTEGER,
  delivered      INTEGER NOT NULL DEFAULT 0,
  last_message_id INTEGER,
  ended_at       INTEGER
);
CREATE INDEX IF NOT EXISTS watches_status_idx ON watches(status);
CREATE INDEX IF NOT EXISTS watches_run_idx ON watches(run_id);
-- What happened to each watch, for measuring it: created, progress (the reading changed: value, quiet_sec), stall
-- (quiet_sec, stall_sec), stall_cleared (stalled_for_sec: how long after the stall progress moved again), met,
-- expired, fired (by hand), delivered (waited_sec from firing), deliver_error, run_ended, cancelled, check_error.
CREATE TABLE IF NOT EXISTS watch_events (
  id       INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  run_id   INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS watch_events_watch_idx ON watch_events(watch_id, at);
CREATE INDEX IF NOT EXISTS watch_events_kind_idx ON watch_events(kind, at);
`);

export type WatchRow = {
  id: number; run_id: number; label: string; until_kind: string; until_arg: string; progress_kind: string; progress_arg: string;
  every_sec: number; stall_sec: number; expires_at: number | null; message: string; status: string; outcome: string;
  created_by: string; created_at: number; next_check_at: number; last_check_at: number | null; checks: number; check_error: string;
  baseline: string; progress: string; progress_at: number | null; max_quiet_sec: number; stalls: number; stalled_at: number | null;
  pending: string; pending_at: number | null; delivered: number; last_message_id: number | null; ended_at: number | null;
};
type Event = { kind: string; detail?: Record<string, unknown> };

const UNTIL_KINDS = ["exit", "cmd", "file", "at", "run", "none"];
const MIN_EVERY = 10, DEFAULT_EVERY = 60, DEFAULT_STALL = 30 * 60, DEFAULT_FOR = 24 * 3600, MAX_FOR = 7 * 24 * 3600;
/** A message held while the agent works is typed anyway after this long: Claude Code queues it for the turn's end. */
const HOLD_WHILE_WORKING_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 120_000;

function logEvent(w: { id: number; run_id: number }, e: Event, at = now()) {
  db.prepare("INSERT INTO watch_events (watch_id, run_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)").run(w.id, w.run_id, at, e.kind, JSON.stringify(e.detail ?? {}));
}
const getWatch = (id: number) => {
  const w = db.query<WatchRow, [number]>("SELECT * FROM watches WHERE id = ?").get(id);
  if (!w) throw new ApiError(404, `watch ${id} not found`);
  return w;
};
function update(id: number, set: Partial<WatchRow>) {
  const keys = Object.keys(set);
  if (!keys.length) return;
  db.prepare(`UPDATE watches SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (set as any)[k]), id);
}

// ---------------------------------------------------------------- making one

export type WatchInput = {
  run_id: number; label?: string;
  until_exit?: number; until_cmd?: string; until_file?: string; at?: number; until_run?: string;
  progress_cmd?: string; progress_file?: string;
  every_sec?: number; stall_sec?: number; for_sec?: number; message?: string;
};

function fileSig(path: string): string {
  try { const s = statSync(path); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return ""; }
}

export function createWatch(i: WatchInput, by = ""): WatchRow {
  const run = getRun(i.run_id);
  if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux && !(meta.e2b && meta.interactive)) throw new ApiError(400, `run ${run.id} is not interactive: a watch types its message into the session`);
  const given = [i.until_exit !== undefined, Boolean(i.until_cmd), Boolean(i.until_file), i.at !== undefined, Boolean(i.until_run)].filter(Boolean).length;
  if (given > 1) throw new ApiError(400, "give one condition: until_exit, until_cmd, until_file, at or until_run");
  let kind = "none", arg = "", baseline = "";
  if (i.until_exit !== undefined) {
    if (!Number.isInteger(i.until_exit) || i.until_exit <= 1) throw new ApiError(400, "until_exit must be a process id");
    kind = "exit"; arg = String(i.until_exit);
  } else if (i.until_cmd) { kind = "cmd"; arg = i.until_cmd; }
  else if (i.until_file) { kind = "file"; arg = i.until_file; baseline = fileSig(i.until_file); }
  else if (i.at !== undefined) {
    if (!Number.isFinite(i.at) || i.at <= 0) throw new ApiError(400, "at must be a time (Unix ms)");
    kind = "at"; arg = String(Math.round(i.at));
  } else if (i.until_run) {
    const m = /^(\d+)(?::(idle|done))?$/.exec(i.until_run.trim());
    if (!m) throw new ApiError(400, `until_run must be "<run id>", "<run id>:idle" or "<run id>:done"`);
    if (Number(m[1]) === run.id) throw new ApiError(400, "a run can't wait for itself");
    getRun(Number(m[1]));
    kind = "run"; arg = `${m[1]}:${m[2] ?? "idle"}`;
  }
  if (i.progress_cmd && i.progress_file) throw new ApiError(400, "give progress_cmd or progress_file, not both");
  const progressKind = i.progress_cmd ? "cmd" : i.progress_file ? "file" : "";
  if (kind === "none" && !progressKind) throw new ApiError(400, "a watch needs a condition (until_exit, until_cmd, until_file, at, until_run) or a progress reading to watch for stalls");
  const every = Math.max(MIN_EVERY, Math.round(i.every_sec ?? DEFAULT_EVERY));
  const stall = progressKind ? Math.max(0, Math.round(i.stall_sec ?? DEFAULT_STALL)) : 0;
  if (stall && stall < every * 2) throw new ApiError(400, `stall_sec (${stall}) should be at least twice every_sec (${every})`);
  const forSec = Math.min(MAX_FOR, Math.max(60, Math.round(i.for_sec ?? DEFAULT_FOR)));
  const t = now();
  const expires = kind === "at" ? Math.max(Number(arg) + 3600_000, t + forSec * 1000) : t + forSec * 1000;
  const r = db.prepare(
    `INSERT INTO watches (run_id, label, until_kind, until_arg, progress_kind, progress_arg, every_sec, stall_sec, expires_at, message, created_by, created_at, next_check_at, baseline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.id, (i.label ?? "").trim().slice(0, 200), kind, arg, progressKind, i.progress_cmd || i.progress_file || "", every, stall, expires, (i.message ?? "").trim(), by, t,
    Math.min(t + Math.min(every, 15) * 1000, kind === "at" ? Math.max(t, Number(arg)) : Infinity), baseline);
  const w = getWatch(Number(r.lastInsertRowid));
  logEvent(w, { kind: "created", detail: { until: describeUntil(w), progress: w.progress_kind ? `${w.progress_kind}: ${w.progress_arg}` : "", every_sec: every, stall_sec: stall, for_sec: forSec, by } }, t);
  kick();
  return w;
}

export function describeUntil(w: Pick<WatchRow, "until_kind" | "until_arg" | "baseline">): string {
  switch (w.until_kind) {
    case "exit": return `process ${w.until_arg} exits`;
    case "cmd": return `\`${w.until_arg}\` succeeds`;
    case "file": return w.baseline ? `${w.until_arg} changes` : `${w.until_arg} appears`;
    case "at": return `it is ${new Date(Number(w.until_arg)).toISOString().replace(/:\d\d\.\d+Z$/, "Z")}`;
    case "run": { const [id, st] = w.until_arg.split(":"); return st === "done" ? `run ${id} ends` : `run ${id} finishes its turn`; }
    default: return "it expires (progress watch only)";
  }
}

// ---------------------------------------------------------------- checking one (pure part: tested)

/** One check's reading. progress: the new reading, or null when there is none this time (no progress source, or it failed). */
export type Reading = { met: boolean; output?: string; progress: string | null; error?: string };
export type Fire = { reason: "met" | "stalled" | "expired"; text: string };

const fmtDur = (sec: number) => {
  sec = Math.max(0, Math.round(sec));
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h < 48 ? `${h}h${m ? ` ${m}m` : ""}` : `${Math.round(h / 24)}d`;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

/** lofiwave's line at the top of a watch's message, then the agent's own words for itself. */
export function watchText(w: WatchRow, reason: Fire["reason"] | "fired", t: number, r?: { output?: string; quiet_sec?: number }): string {
  const name = `[lofiwave watch #${w.id}${w.label ? ` "${w.label}"` : ""}]`;
  const age = fmtDur((t - w.created_at) / 1000);
  let line: string;
  if (reason === "met") line = `Done: ${describeUntil(w)} (watched for ${age}).`;
  else if (reason === "stalled") line = `Stalled: the progress reading hasn't changed for ${fmtDur(r?.quiet_sec ?? w.stall_sec)}${w.progress ? ` (last: "${clip(w.progress, 160)}")` : ""}. Still watching for: ${describeUntil(w)}. \`lw watch rm ${w.id}\` stops it.`;
  else if (reason === "expired") line = `Expired after ${age} without this happening: ${describeUntil(w)}.${w.progress ? ` Last progress: "${clip(w.progress, 160)}".` : ""}`;
  else line = `Fired by hand before: ${describeUntil(w)}.${w.progress ? ` Last progress: "${clip(w.progress, 160)}".` : ""}`;
  const parts = [`${name} ${line}`];
  const out = (r?.output ?? "").trim();
  if (out) parts.push(`Output:\n${tail(out, 1500)}`);
  if (w.message) parts.push(w.message.replaceAll("{progress}", w.progress).replaceAll("{output}", tail(out, 1500)));
  return parts.join("\n\n");
}

/** What one check changes on a watch, what to log, and whether to tell the agent. No I/O. */
export function advance(w: WatchRow, r: Reading, t: number): { set: Partial<WatchRow>; events: Event[]; fire?: Fire } {
  // A time (or the expiry) that comes before the next regular check is checked right then.
  const due = [t + w.every_sec * 1000, w.until_kind === "at" ? Number(w.until_arg) : Infinity, w.expires_at ?? Infinity].filter((x) => x > t);
  const set: Partial<WatchRow> = { checks: w.checks + 1, last_check_at: t, next_check_at: Math.min(...due), check_error: r.error ?? "" };
  const events: Event[] = [];
  if (r.error && r.error !== w.check_error) events.push({ kind: "check_error", detail: { error: clip(r.error, 500) } });
  let fire: Fire | undefined;
  let cur = { ...w };
  if (r.progress !== null) {
    if (w.progress_at === null) {
      Object.assign(set, { progress: r.progress, progress_at: t });
      events.push({ kind: "progress", detail: { value: clip(r.progress, 200), first: true } });
    } else if (r.progress !== w.progress) {
      const quiet = Math.round((t - w.progress_at) / 1000);
      Object.assign(set, { progress: r.progress, progress_at: t, max_quiet_sec: Math.max(w.max_quiet_sec, quiet) });
      events.push({ kind: "progress", detail: { value: clip(r.progress, 200), quiet_sec: quiet } });
      if (w.stalled_at !== null) {
        // Progress moved after a stall was reported: how long after tells us if the threshold was too tight.
        events.push({ kind: "stall_cleared", detail: { stalled_for_sec: Math.round((t - w.stalled_at) / 1000), quiet_sec: quiet, stall_sec: w.stall_sec } });
        set.stalled_at = null;
      }
    } else if (w.stall_sec > 0 && w.stalled_at === null) {
      const quiet = Math.round((t - w.progress_at) / 1000);
      if (quiet >= w.stall_sec) {
        Object.assign(set, { stalled_at: t, stalls: w.stalls + 1 });
        events.push({ kind: "stall", detail: { quiet_sec: quiet, stall_sec: w.stall_sec, every_sec: w.every_sec, progress: clip(w.progress, 200), checks: w.checks + 1, nth: w.stalls + 1 } });
        cur = { ...cur, ...set } as WatchRow;
        fire = { reason: "stalled", text: watchText(cur, "stalled", t, { quiet_sec: quiet }) };
      }
    }
  }
  cur = { ...cur, ...set } as WatchRow;
  const quietNow = cur.progress_at !== null ? Math.round((t - cur.progress_at) / 1000) : 0;
  const summary = { checks: cur.checks, age_sec: Math.round((t - w.created_at) / 1000), stalls: cur.stalls, max_quiet_sec: Math.max(cur.max_quiet_sec, quietNow), stall_sec: w.stall_sec, open_stall: cur.stalled_at !== null };
  if (r.met) {
    Object.assign(set, { status: "delivering", outcome: "met", ended_at: t, max_quiet_sec: summary.max_quiet_sec });
    events.push({ kind: "met", detail: summary });
    fire = { reason: "met", text: watchText({ ...cur, ...set } as WatchRow, "met", t, { output: r.output }) };
  } else if (w.expires_at !== null && t >= w.expires_at) {
    Object.assign(set, { status: "delivering", outcome: "expired", ended_at: t, max_quiet_sec: summary.max_quiet_sec });
    events.push({ kind: "expired", detail: summary });
    fire = { reason: "expired", text: watchText({ ...cur, ...set } as WatchRow, "expired", t) };
  }
  return { set, events, fire };
}

// ---------------------------------------------------------------- checking one (I/O)

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

async function sh(cmd: string, cwd: string, runId: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  const p = Bun.spawn(["sh", "-c", cmd], {
    cwd: existsSync(cwd) ? cwd : homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, AGENT_CONSOLE_RUN_ID: String(runId) },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch { /* gone */ } }, CHECK_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, out: tail((out + (err.trim() ? `\n${err}` : "")).trim(), 8000), timedOut };
}
const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

export async function readWatch(w: WatchRow, run: RunRow, t = now()): Promise<Reading> {
  const r: Reading = { met: false, progress: null };
  const errors: string[] = [];
  if (w.progress_kind === "cmd") {
    const p = await sh(w.progress_arg, run.cwd, run.id);
    if (p.timedOut) errors.push(`progress command timed out after ${CHECK_TIMEOUT_MS / 1000}s`);
    else if (p.code !== 0) errors.push(`progress command exited ${p.code}: ${clip(p.out, 300)}`);
    else r.progress = clip(lastLine(p.out), 300);
  } else if (w.progress_kind === "file") {
    try { const s = statSync(w.progress_arg); r.progress = `${s.size} bytes, modified ${new Date(s.mtimeMs).toISOString()}`; }
    catch { errors.push(`progress file not found: ${w.progress_arg}`); }
  }
  switch (w.until_kind) {
    case "exit": r.met = !pidAlive(Number(w.until_arg)); break;
    case "cmd": {
      const c = await sh(w.until_arg, run.cwd, run.id);
      if (c.timedOut) errors.push(`command timed out after ${CHECK_TIMEOUT_MS / 1000}s`);
      r.met = c.code === 0;
      if (r.met) r.output = c.out;
      break;
    }
    case "file": { const sig = fileSig(w.until_arg); r.met = Boolean(sig) && sig !== w.baseline; break; }
    case "at": r.met = t >= Number(w.until_arg); break;
    case "run": {
      const [id, st] = w.until_arg.split(":");
      let other: RunRow | null = null;
      try { other = getRun(Number(id)); } catch { r.met = true; r.output = `run ${id} no longer exists`; break; }
      if (other.status !== "running") { r.met = true; r.output = `run ${id} ended: ${other.status}`; break; }
      if (st === "idle") {
        // An idle that began after the watch was made: the turn it was waiting on is over.
        const a = activityOf(other);
        r.met = (a.activity === "idle" || a.activity === "waiting_input") && a.activity_since >= w.created_at;
        if (r.met) r.output = `run ${id} is ${a.activity === "waiting_input" ? `waiting on a prompt${a.waiting_for ? ` (${a.waiting_for})` : ""}` : "idle"}`;
      }
      break;
    }
  }
  if (errors.length) r.error = errors.join("; ");
  return r;
}

// ---------------------------------------------------------------- the loop

const inFlight = new Set<number>();
const nextDeliveryTry = new Map<number, number>();

function queueText(w: WatchRow, text: string, reason: string, t: number): Partial<WatchRow> {
  // A stall waiting to be typed when the condition is met: the met message says it all.
  const pending = w.pending && reason === "stalled" ? `${w.pending}\n\n${text}` : text;
  return { pending, pending_at: w.pending_at ?? t };
}

async function checkOne(w: WatchRow) {
  if (inFlight.has(w.id)) return;
  inFlight.add(w.id);
  try {
    const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(w.run_id);
    const t0 = now();
    if (!run || run.status !== "running") {
      update(w.id, { status: "done", outcome: "run_ended", ended_at: t0, pending: "" });
      logEvent(w, { kind: "run_ended", detail: { run_status: run?.status ?? "deleted", checks: w.checks } }, t0);
      return;
    }
    const reading = await readWatch(w, run);
    const t = now();
    const fresh = getWatch(w.id);
    if (fresh.status !== "active") return;                // cancelled or fired by hand meanwhile
    const { set, events, fire } = advance(fresh, reading, t);
    if (fire) Object.assign(set, queueText(fresh, fire.text, fire.reason, t));
    update(w.id, set);
    for (const e of events) logEvent(w, e, t);
  } catch (e) {
    console.error(`[watches] watch ${w.id}:`, e);
  } finally { inFlight.delete(w.id); }
}

async function deliverOne(w: WatchRow) {
  const t = now();
  if ((nextDeliveryTry.get(w.id) ?? 0) > t) return;
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(w.run_id);
  if (!run || run.status !== "running") {
    update(w.id, { pending: "", status: w.status === "active" || w.status === "delivering" ? "done" : w.status, outcome: w.outcome || "run_ended", ended_at: w.ended_at ?? t });
    logEvent(w, { kind: "run_ended", detail: { run_status: run?.status ?? "deleted", undelivered: true } }, t);
    return;
  }
  const a = activityOf(run);
  // Waiting on a person (a permission prompt, a question): typing would answer it. Hold; Watching shows the run.
  if (a.activity === "waiting_input") return;
  if (a.activity === "working" && t - (w.pending_at ?? t) < HOLD_WHILE_WORKING_MS) return;
  try {
    const mark = transcriptMark(run);
    const sent = await sendMessage(run, w.pending);
    const mid = recordMessage(run, w.pending, sent, mark, `watch:${w.id}`);
    const fresh = getWatch(w.id);
    update(w.id, { pending: "", pending_at: null, delivered: fresh.delivered + 1, last_message_id: mid, status: fresh.status === "delivering" ? "done" : fresh.status });
    logEvent(w, { kind: "delivered", detail: { message_id: mid, waited_sec: Math.round((t - (w.pending_at ?? t)) / 1000), activity: a.activity, delivered: sent.delivered, queued: sent.queued } }, t);
    nextDeliveryTry.delete(w.id);
  } catch (e: any) {
    nextDeliveryTry.set(w.id, t + 60_000);
    logEvent(w, { kind: "deliver_error", detail: { error: clip(String(e?.message ?? e), 300) } }, t);
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const t = now();
    const due = db.query<WatchRow, [number]>("SELECT * FROM watches WHERE status = 'active' AND next_check_at <= ? ORDER BY next_check_at LIMIT 20").all(t);
    await Promise.all(due.map(checkOne));
    for (const w of db.query<WatchRow, []>("SELECT * FROM watches WHERE pending != '' ORDER BY pending_at").all()) await deliverOne(w);
  } finally { ticking = false; }
}
function kick() { setTimeout(() => tick().catch((e) => console.error("[watches]", e)), 50); }

export function startWatches(intervalMs = 5000) {
  idleKeepers.push((runId) => Boolean(db.query("SELECT 1 FROM watches WHERE run_id = ? AND (status IN ('active', 'delivering') OR pending != '') LIMIT 1").get(runId)));
  setInterval(() => tick().catch((e) => console.error("[watches]", e)), intervalMs);
  kick();
}

// ---------------------------------------------------------------- the API's side

export function watchOut(w: WatchRow, withEvents = false) {
  const t = now();
  const out: any = {
    ...w, until: describeUntil(w), quiet_sec: w.progress_at !== null && w.status === "active" ? Math.round((t - w.progress_at) / 1000) : null,
    stalled: w.stalled_at !== null, pending: w.pending || null,
  };
  if (withEvents) {
    out.events = db.query<{ at: number; kind: string; detail: string }, [number]>("SELECT at, kind, detail FROM watch_events WHERE watch_id = ? ORDER BY id DESC LIMIT 200").all(w.id)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail || "{}") }));
  }
  return out;
}

export function listWatches(o: { run?: number; all?: boolean } = {}) {
  const where: string[] = [], args: any[] = [];
  if (o.run) { where.push("run_id = ?"); args.push(o.run); }
  if (!o.all) { where.push("(status IN ('active', 'delivering') OR pending != '' OR ended_at > ?)"); args.push(now() - 48 * 3600_000); }
  return db.query<WatchRow, any[]>(`SELECT * FROM watches ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 200`).all(...args).map((w) => watchOut(w));
}

export function getWatchOut(id: number) { return watchOut(getWatch(id), true); }

export function cancelWatch(id: number, by = "") {
  const w = getWatch(id);
  if (w.status === "done" || w.status === "cancelled") return watchOut(w);
  const t = now();
  update(id, { status: "cancelled", outcome: "cancelled", ended_at: t, pending: "" });
  logEvent(w, { kind: "cancelled", detail: { by, checks: w.checks, stalls: w.stalls, age_sec: Math.round((t - w.created_at) / 1000) } }, t);
  return watchOut(getWatch(id));
}

/** Tell the agent now, as if the condition were met (for when a person knows it's done, or wants it to look). */
export function fireWatch(id: number, by = "") {
  const w = getWatch(id);
  if (w.status !== "active") throw new ApiError(409, `watch ${id} is ${w.status}`);
  const t = now();
  update(id, { status: "delivering", outcome: "fired", ended_at: t, ...queueText(w, watchText(w, "fired", t), "fired", t) });
  logEvent(w, { kind: "fired", detail: { by, checks: w.checks, stalls: w.stalls, age_sec: Math.round((t - w.created_at) / 1000) } }, t);
  kick();
  return watchOut(getWatch(id));
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * Is stall detection firing too much or too little? From watch_events over `days`.
 * - Too much: stalls that cleared soon after (progress moved again within one stall_sec) were a slow patch, not a stall.
 * - Too little: watches that ended without a stall but went quiet for most of stall_sec (near misses), and stalls that
 *   never cleared (the job really was stuck) tell how long it took to notice.
 */
export function watchStats(days = 30) {
  const since = now() - days * 86400_000;
  const ev = db.query<{ watch_id: number; kind: string; at: number; detail: string }, [number]>("SELECT watch_id, kind, at, detail FROM watch_events WHERE at >= ? ORDER BY id").all(since)
    .map((e) => ({ ...e, d: JSON.parse(e.detail || "{}") }));
  const created = db.query<WatchRow, [number]>("SELECT * FROM watches WHERE created_at >= ?").all(since);
  const outcomes: Record<string, number> = {};
  for (const w of created) outcomes[w.outcome || w.status] = (outcomes[w.outcome || w.status] ?? 0) + 1;
  const stalls = ev.filter((e) => e.kind === "stall");
  const cleared = ev.filter((e) => e.kind === "stall_cleared");
  const clearedFast = cleared.filter((e) => e.d.stalled_for_sec <= e.d.stall_sec);
  const ended = created.filter((w) => w.ended_at && w.stall_sec > 0);
  const nearMisses = ended.filter((w) => w.stalls === 0 && w.max_quiet_sec >= 0.75 * w.stall_sec);
  const delivered = ev.filter((e) => e.kind === "delivered");
  return {
    days, watches: created.length, outcomes,
    with_stall_detection: created.filter((w) => w.stall_sec > 0).length,
    stalls: stalls.length,
    stalls_cleared: cleared.length,
    stalls_cleared_within_stall_sec: clearedFast.length,
    median_stalled_for_sec: median(cleared.map((e) => e.d.stalled_for_sec)),
    stalls_never_cleared: stalls.length - cleared.length,
    near_misses: nearMisses.length,
    median_quiet_over_stall: median(ended.map((w) => Math.round((w.max_quiet_sec / w.stall_sec) * 100) / 100)),
    deliveries: delivered.length,
    median_delivery_wait_sec: median(delivered.map((e) => e.d.waited_sec)),
    deliver_errors: ev.filter((e) => e.kind === "deliver_error").length,
    reading: [
      stalls.length && clearedFast.length / stalls.length > 0.5 ? "Most stalls cleared within one stall_sec: thresholds look too tight." : "",
      nearMisses.length && ended.length && nearMisses.length / ended.length > 0.3 ? "Many watches went quiet for most of stall_sec without stalling: real stalls may be caught late." : "",
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------- Watching: what each agent is waiting on

export type BgTask = {
  id: string; kind: "shell" | "agent" | "monitor"; description: string; started_at: number; output_file: string;
  expires_at: number | null; ended_at: number | null; end_status: string;
};
type Said = { text: string; at: number; api_error: boolean };
type Wake = { at: number; wake_at: number; reason: string; seen: boolean };
export type TranscriptState = {
  offset: number; tasks: Map<string, BgTask>; pending: Map<string, { kind: BgTask["kind"] | "bash"; description: string; at: number }>;
  wake: Wake | null; lastPrompt: { text: string; at: number } | null; lastSaid: Said | null; lastAt: number;
};
export const newTranscriptState = (): TranscriptState => ({ offset: 0, tasks: new Map(), pending: new Map(), wake: null, lastPrompt: null, lastSaid: null, lastAt: 0 });

const FINAL_TASK = /^(completed|failed|killed|stopped|error|expired|timeout|timed_out|cancelled|canceled)$/;
const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("\n") : "";

/** Feed transcript entries, in order, into what we know about a session's background work and its last words. */
export function feedTranscript(st: TranscriptState, entries: any[]) {
  for (const d of entries) {
    if (!d || typeof d !== "object" || d.isSidechain) continue;
    const at = Date.parse(d.timestamp ?? "") || st.lastAt;
    if (at) st.lastAt = at;
    const c = d.message?.content;
    if (d.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text" && b.text?.trim()) st.lastSaid = { text: b.text, at, api_error: Boolean(d.isApiErrorMessage) };
        if (b?.type !== "tool_use") continue;
        const inp = b.input ?? {};
        const desc = String(inp.description || inp.command || inp.prompt || "").split("\n")[0].slice(0, 160);
        if (b.name === "Bash") st.pending.set(b.id, { kind: inp.run_in_background ? "shell" : "bash", description: desc, at });
        else if (b.name === "Agent" || b.name === "Task") { if (inp.run_in_background) st.pending.set(b.id, { kind: "agent", description: desc, at }); }
        else if (b.name === "Monitor") st.pending.set(b.id, { kind: "monitor", description: desc, at });
        else if (b.name === "ScheduleWakeup") {
          st.wake = inp.stop ? null : { at, wake_at: at + Number(inp.delaySeconds ?? 0) * 1000, reason: String(inp.reason ?? "").slice(0, 200), seen: false };
        }
      }
      continue;
    }
    // A notice that came while a turn was running is handed to it as a queued_command attachment.
    if (d.type === "attachment" && d.attachment?.type === "queued_command") {
      const text = String(d.attachment.prompt ?? "");
      if (text.includes("<task-notification>")) taskNotices(st, text, at);
      if (st.wake && !st.wake.seen && at >= st.wake.wake_at - 60_000) st.wake.seen = true;
      continue;
    }
    if (d.type !== "user") continue;
    if (Array.isArray(c) && c.some((p: any) => p?.type === "tool_result")) {
      for (const p of c) {
        if (p?.type !== "tool_result") continue;
        const s = textOf(p.content) || (typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? ""));
        const stopped = /(?:stopped task|killed shell):?\s*([A-Za-z0-9_-]+)/i.exec(s);
        if (stopped) endTask(st, stopped[1], "stopped", at);
        const pend = st.pending.get(p.tool_use_id);
        if (!pend) continue;
        st.pending.delete(p.tool_use_id);
        let m: RegExpExecArray | null;
        // Anchored at the start: a command's own output may well contain these words (it read another transcript).
        const bg = pend.kind === "shell" ? /^\s*Command running in background with ID:\s*([A-Za-z0-9_-]+)[\s\S]*?written to:\s*(\S+?\.output)/
          : /^\s*Command did not complete within its \d+s timeout and was moved to the background \(ID:\s*([A-Za-z0-9_-]+)\)[\s\S]*?written to:\s*(\S+?\.output)/;
        if ((pend.kind === "shell" || pend.kind === "bash") && (m = bg.exec(s))) {
          st.tasks.set(m[1], { id: m[1], kind: "shell", description: pend.description, started_at: pend.at, output_file: m[2], expires_at: null, ended_at: null, end_status: "" });
        } else if (pend.kind === "agent" && (m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(s))) {
          st.tasks.set(m[1], { id: m[1], kind: "agent", description: pend.description, started_at: pend.at, output_file: "", expires_at: null, ended_at: null, end_status: "" });
        } else if (pend.kind === "monitor" && (m = /Monitor started \(task\s+([A-Za-z0-9_-]+)(?:,\s*expires in (\d+)\s*(s|m|h))?/.exec(s))) {
          const mult = m[3] === "h" ? 3600_000 : m[3] === "s" ? 1000 : 60_000;
          st.tasks.set(m[1], { id: m[1], kind: "monitor", description: pend.description, started_at: pend.at, output_file: "", expires_at: m[2] ? pend.at + Number(m[2]) * mult : null, ended_at: null, end_status: "" });
        }
      }
      continue;
    }
    const text = textOf(c);
    if (text.includes("<task-notification>")) taskNotices(st, text, at);
    else if (!d.isMeta && text.trim() && !/^\s*<(command-|local-command|system-reminder)/.test(text)) {
      st.lastPrompt = { text: text.slice(0, 300), at };
    }
    if (st.wake && !st.wake.seen && at >= st.wake.wake_at - 60_000) st.wake.seen = true;
  }
}
function taskNotices(st: TranscriptState, text: string, at: number) {
  for (const m of text.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>[\s\S]*?<status>([a-z_]+)<\/status>/g)) if (FINAL_TASK.test(m[2])) endTask(st, m[1], m[2], at);
}
function endTask(st: TranscriptState, id: string, status: string, at: number) {
  const t = st.tasks.get(id);
  if (t && !t.ended_at) { t.ended_at = at; t.end_status = status; }
}

const states = new Map<string, TranscriptState>();
/** Big transcripts are read from near their end the first time: background work older than that is long over. */
const FIRST_READ_MAX = 16 * 1024 * 1024;
function observe(path: string): TranscriptState | null {
  let st = states.get(path);
  try {
    const size = statSync(path).size;
    if (!st || size < st.offset) { st = newTranscriptState(); st.offset = Math.max(0, size - FIRST_READ_MAX); states.set(path, st); }
    if (size > st.offset) { const r = readLines(path, st.offset); feedTranscript(st, r.entries); st.offset = r.offset; }
    return st;
  } catch { return st ?? null; }
}

export const PROMISE = /\b(I'll|I will|I'm going to|I'll be)\b[^.!?\n]{0,80}\b(report|check (back|again|in|on)|come back|get back|let you know|tell you|send (you|the)|pass (it )?on|ping you|update you|post|verify|confirm|follow up|pick (it|them|each one) up)\b|\bat your next status\b|\b(waiting for it|standing by( for)?|until it reports)\b|\bwill (notify|tell you|report|come back|let you know)\b|\bshould (finish|be done|complete|land|be ready)\b|\bexpect (it |this |that |them |about |around |roughly |another )*[\w~–-]* ?(minutes|minute|mins|hours|hour|h)\b|\b(waiting|I'll wait|I will wait|we'll wait) (for|on|until)\b[^.!?\n]{0,100}\b(to )?(finish|finishes|complete|completes|be done|land|lands|drain|drains|pass|passes)\b|\b(when|once|as soon as) (the )?[\w#-]+( [\w#-]+)? (finishes|finish|is done|are done|completes|complete|lands|land|passes|pass|verifies|reaches|is green|merges)\b/i;
const API_ERROR = /^\s*(API Error|Not logged in|Please run \/login|You've hit your|Claude AI usage limit|Credit balance is too low|Request timed out|Prompt is too long)|\bAPI Error: \d{3}\b/i;
/** The last paragraph has a question for the person, or asks for a go-ahead. */
function asks(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).at(-1) ?? "";
  return /\?\s*(\*\*)?\s*$/.test(last) || /\?\s*$/m.test(last) || /\b(say go|your call|waiting for your|need(s)? (a decision|your))\b/i.test(last);
}

export type Flag = { kind: "needs_you" | "asked" | "api_error" | "unbacked_promise" | "missed_wakeup" | "stale_shell" | "lost_shells"; text: string; since: number };

function sessionTranscript(run: RunRow): string | null {
  const sid = noteClaudeSession(run.id, run.pid, run.cwd)
    ?? db.query<{ session_id: string }, [number]>("SELECT session_id FROM sessions WHERE run_id = ? ORDER BY started_at DESC, id DESC LIMIT 1").get(run.id)?.session_id;
  if (!sid) return null;
  const s = db.query<{ transcript_path: string; cwd: string }, [number, string]>("SELECT transcript_path, cwd FROM sessions WHERE run_id = ? AND session_id = ?").get(run.id, sid);
  const p = s?.transcript_path || claudeTranscriptPath(sid, s?.cwd || run.cwd);
  return p && existsSync(p) ? p : null;
}

const STALE_OUTPUT_MS = 2 * 3600_000;

export function watching() {
  const t = now();
  const runs = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running' ORDER BY id").all();
  const reg = claudeRegistry();
  const out: any[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const meta = JSON.parse(run.meta || "{}");
    if (!meta.interactive && !meta.tmux) continue;
    const a = activityOf(run);
    const active = db.query<WatchRow, [number]>("SELECT * FROM watches WHERE run_id = ? AND (status IN ('active', 'delivering') OR pending != '') ORDER BY id").all(run.id);
    const isClaude = basename(run.command) === "claude";
    const path = isClaude ? sessionTranscript(run) : null;
    if (path) seen.add(path);
    const st = path ? observe(path) : null;
    const tasks: any[] = [];
    const flags: Flag[] = [];
    const idle = a.activity === "idle";
    if (st) {
      for (const task of st.tasks.values()) {
        if (task.kind === "monitor" && !task.ended_at && task.expires_at && task.expires_at < t) { task.ended_at = task.expires_at; task.end_status = "expired"; }
        if (task.ended_at && t - task.ended_at > 3600_000) continue;
        const o: any = { ...task, age_sec: Math.round((t - task.started_at) / 1000) };
        if (task.output_file) {
          try { const s = statSync(task.output_file); o.output_bytes = s.size; o.output_changed_at = Math.floor(s.mtimeMs); } catch { o.output_missing = true; }
        }
        tasks.push(o);
      }
    }
    const open = tasks.filter((x) => !x.ended_at);
    const openShells = open.filter((x) => x.kind === "shell");
    const wake = st?.wake && !st.wake.seen ? { wake_at: st.wake.wake_at, reason: st.wake.reason, missed: t > st.wake.wake_at + 180_000 } : null;
    const said = st?.lastSaid ?? null;
    const turnOver = said && (!st?.lastPrompt || said.at >= st.lastPrompt.at);
    if (a.activity === "waiting_input") flags.push({ kind: "needs_you", text: `waiting on ${a.waiting_for ? `a ${a.waiting_for.replace(/_/g, " ")}` : "a prompt"}`, since: a.activity_since });
    if (idle && said && turnOver) {
      if (said.api_error || API_ERROR.test(said.text)) flags.push({ kind: "api_error", text: `stopped on: ${clip(said.text.trim().split("\n")[0], 140)}`, since: said.at });
      else if (asks(said.text)) flags.push({ kind: "asked", text: "ended its turn with a question for you", since: said.at });
      else if (PROMISE.test(said.text.slice(-800)) && !open.length && !wake && !active.length && !a.background_shells)
        flags.push({ kind: "unbacked_promise", text: "said it would report back, but nothing is set to wake it", since: said.at });
    }
    if (wake?.missed) flags.push({ kind: "missed_wakeup", text: `a wakeup was due ${fmtDur((t - wake.wake_at) / 1000)} ago${wake.reason ? ` (${clip(wake.reason, 80)})` : ""}`, since: wake.wake_at });
    for (const x of openShells) {
      const quietFor = x.output_changed_at ? t - x.output_changed_at : t - x.started_at;
      if (x.output_missing) continue;
      if (quietFor > STALE_OUTPUT_MS) flags.push({ kind: "stale_shell", text: `"${clip(x.description || x.id, 60)}" has written nothing for ${fmtDur(quietFor / 1000)}`, since: t - quietFor });
    }
    // Claude says no shells are running, but the transcript has shells it never heard back from: they're gone.
    const regEntry = run.pid ? reg.byPid.get(run.pid) : undefined;
    if (idle && regEntry && regEntry.status !== "shell" && openShells.length)
      flags.push({ kind: "lost_shells", text: `${openShells.length} background shell${openShells.length === 1 ? "" : "s"} never reported back, and Claude no longer runs any`, since: openShells[0].started_at });
    const title = path ? db.query<{ custom_title: string; ai_title: string }, [string]>("SELECT custom_title, ai_title FROM token_sessions WHERE session_id = ?").get(basename(path, ".jsonl")) : null;
    out.push({
      run_id: run.id, name: title?.custom_title || title?.ai_title || run.workflow_name || basename(run.cwd), cwd: run.cwd, tmux: meta.tmux ?? null,
      activity: a.activity, activity_since: a.activity_since, waiting_for: a.waiting_for ?? null, background_shells: Boolean(a.background_shells),
      tasks, wakeup: wake, last_said: said ? { text: tail(said.text.trim(), 400), at: said.at } : null,
      watches: active.map((w) => watchOut(w)), flags,
    });
  }
  for (const p of states.keys()) if (!seen.has(p)) states.delete(p);
  const attention = out.filter((r) => r.flags.length).length;
  return { at: t, attention, runs: out };
}
