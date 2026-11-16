/**
 * What runs in the background: messages owed to runs are delivered, a worker that ends or parks is announced, the
 * programme's controller is woken when something happens, overdue items are followed up, and the digest goes out.
 */
import { db, now, type RunRow, type WorkflowRow } from "../db";
import { activityOf } from "../runner";
import { nextCron } from "../cron";
import { runWorkflow } from "../scheduler";
import { flushOutbox, onDelivered, onEvent, logEvent, notify, linkTo, setting, settingNum, owe, pendingFor, eventsSince, usd } from "./core";
import { briefDelivered, outcomeOf, programmeRun, findProgramme, spentByProgramme, workersOf } from "./programmes";
import { nudgeDue } from "./items";
import type { ProgrammeRow, ProgrammeRunRow, EventRow, AskRow, ItemRow } from "./schema";

onDelivered((m) => briefDelivered(m.ref, m.run_id));

// ---------------------------------------------------------------- ends

/** A programme run that ended: log it once. One that never said what became of it is announced as such. */
function noteEnds() {
  const ended = db.query<ProgrammeRunRow & { status: string; error: string }, []>(
    "SELECT pr.*, r.status, r.error FROM programme_runs pr JOIN runs r ON r.id = pr.run_id WHERE pr.end_noted = 0 AND r.status NOT IN ('running', 'queued')").all();
  for (const w of ended) {
    db.prepare("UPDATE programme_runs SET end_noted = 1 WHERE run_id = ?").run(w.run_id);
    const name = w.worker || `run ${w.run_id}`;
    const outcome = outcomeOf(w.run_id);
    if (outcome) { logEvent({ kind: "run_ended", programme_id: w.programme_id, run_id: w.run_id, actor: name, text: `${name} ended (${outcome.outcome})` }); continue; }
    const why = w.status === "killed" ? "it was stopped" : w.status === "success" ? "it exited" : `status ${w.status}${w.error ? `: ${w.error}` : ""}`;
    logEvent({ kind: "run_ended", programme_id: w.programme_id, run_id: w.run_id, actor: name, text: `${name} ended without reporting an outcome (${why})` });
    if (w.role !== "controller" && w.status !== "killed") notify({ kind: "run_ended", title: `Ended without a report: ${name}`, text: `Run ${w.run_id} ended (${why}) and never said whether it finished.`, link: linkTo(`sessions/${w.run_id}`) });
  }
}

// ---------------------------------------------------------------- stalls

export type Stall = { run_id: number; what: "waiting" | "idle"; since: number; waiting_for?: string; worker: string; programme: { id: number; slug: string; name: string } | null; label: string };

/**
 * Runs that are parked: waiting on a prompt in the terminal, or (programme workers) idle without having said they
 * are done or blocked. `minWaitingMs` / `minIdleMs`: how long before it counts.
 */
export function stalls(minWaitingMs: number, minIdleMs: number): Stall[] {
  const out: Stall[] = [];
  const running = db.query<RunRow, []>("SELECT r.* FROM runs r JOIN process_types t ON t.name = r.type_name WHERE r.status = 'running' AND t.kind = 'agent'").all();
  const t = now();
  for (const r of running) {
    const meta = JSON.parse(r.meta || "{}");
    if (!meta.interactive) continue;
    const a = activityOf(r);
    const pr = programmeRun(r.id);
    const p = pr ? findProgramme(pr.programme_id) : null;
    const base = { run_id: r.id, since: a.activity_since, worker: pr?.worker ?? "", programme: p ? { id: p.id, slug: p.slug, name: p.name } : null, label: pr?.worker || r.workflow_name || `run ${r.id}` };
    if (a.activity === "waiting_input" && t - a.activity_since >= minWaitingMs) out.push({ ...base, what: "waiting", waiting_for: a.waiting_for });
    else if (a.activity === "idle" && pr && pr.role !== "controller" && !outcomeOf(r.id) && !pendingFor(r.id) && t - a.activity_since >= minIdleMs
      && !db.query("SELECT 1 FROM asks WHERE run_id = ? AND status = 'open'").get(r.id)) out.push({ ...base, what: "idle" });
  }
  return out;
}

function noteStalls() {
  const wm = settingNum("stall_waiting_min"), im = settingNum("stall_idle_min");
  const found = stalls(wm > 0 ? wm * 60_000 : Infinity, im > 0 ? im * 60_000 : Infinity);
  for (const s of found) {
    const had = db.query<{ since: number; what: string }, [number]>("SELECT since, what FROM stall_notes WHERE run_id = ?").get(s.run_id);
    if (had && had.since === s.since && had.what === s.what) continue;
    db.prepare("INSERT INTO stall_notes (run_id, since, what) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET since = excluded.since, what = excluded.what").run(s.run_id, s.since, s.what);
    const mins = Math.round((now() - s.since) / 60_000);
    const text = s.what === "waiting" ? `${s.label} has waited ${mins} min on a prompt in its terminal${s.waiting_for ? ` (${s.waiting_for})` : ""}` : `${s.label} has been idle ${mins} min without reporting done or blocked`;
    logEvent({ kind: "stall", programme_id: s.programme?.id ?? null, run_id: s.run_id, actor: "lofiwave", text });
    notify({ kind: "stall", title: s.what === "waiting" ? `Waiting on you: ${s.label}` : `Parked: ${s.label}`, text, link: linkTo(`sessions/${s.run_id}`) });
  }
}

// ---------------------------------------------------------------- waking the controller

const WAKES = new Set(["run_done", "run_blocked", "run_failed", "run_ended"]);
const wakeTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** A worker reported or ended: tell the programme's controller if one is running, else start one (soon, so several events make one pass). */
function wakeController(e: EventRow) {
  if (!WAKES.has(e.kind) || !e.programme_id) return;
  const p = findProgramme(e.programme_id);
  if (!p || p.status !== "active") return;
  const from = e.run_id ? programmeRun(e.run_id) : null;
  if (from?.role === "controller") return;                      // the controller's own end must not start it again
  if (e.kind === "run_ended" && e.run_id && outcomeOf(e.run_id)) return;   // its report already woke the controller
  const liveCtl = db.query<{ run_id: number }, [number]>("SELECT pr.run_id FROM programme_runs pr JOIN runs r ON r.id = pr.run_id WHERE pr.programme_id = ? AND pr.role = 'controller' AND r.status = 'running' ORDER BY pr.run_id DESC LIMIT 1").get(p.id);
  if (liveCtl) { owe(liveCtl.run_id, `${e.text}. Run \`lw programme\` and act on it.`, `wake:${e.id}`); return; }
  if (!p.controller_workflow || wakeTimers.has(p.id)) return;
  wakeTimers.set(p.id, setTimeout(async () => {
    wakeTimers.delete(p.id);
    const wf = db.query<WorkflowRow, [number]>("SELECT * FROM workflows WHERE id = ? AND enabled = 1").get(p.controller_workflow!);
    if (!wf) return;
    try { const run = await runWorkflow(wf, "event"); console.log(`[autopilot] controller of ${p.slug} started as run ${run.id}`); }
    catch (err: any) { console.warn(`[autopilot] controller of ${p.slug} not started: ${err?.message ?? err}`); }
  }, Number(process.env.CONTROLLER_WAKE_DELAY_MS ?? 60_000)));
}
onEvent(wakeController);

// ---------------------------------------------------------------- digest

const fmtAgo = (ms: number) => { const m = Math.round((now() - ms) / 60_000); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

/** What happened since `since`, and what is waiting, as plain text: the answer to "status?". */
export function digest(since: number, programme?: ProgrammeRow | null): { text: string; open_asks: number; since: number } {
  const lines: string[] = [];
  const asks = programme
    ? db.query<AskRow, [number]>("SELECT * FROM asks WHERE status = 'open' AND programme_id = ? ORDER BY created_at").all(programme.id)
    : db.query<AskRow, []>("SELECT * FROM asks WHERE status = 'open' ORDER BY created_at").all();
  lines.push(asks.length ? `Waiting on a person (${asks.length}):` : "Nothing is waiting on a person.");
  for (const a of asks.slice(0, 15)) lines.push(`  • #${a.id} ${a.title} (${fmtAgo(a.created_at)})`);
  const parked = stalls(60_000, settingNum("stall_idle_min") * 60_000 || Infinity).filter((s) => !programme || s.programme?.id === programme.id);
  if (parked.length) { lines.push("", `Parked runs (${parked.length}):`); for (const s of parked) lines.push(`  • ${s.label}: ${s.what === "waiting" ? "waiting on a prompt in its terminal" : "idle without a report"} (${fmtAgo(s.since)})`); }
  const progs = programme ? [programme] : db.query<ProgrammeRow, []>("SELECT * FROM programmes WHERE status = 'active' ORDER BY name").all();
  for (const p of progs) {
    const ws = workersOf(p).filter((w) => w.status === "running" || (w.outcome?.at ?? w.ended_at ?? 0) >= since);
    if (!ws.length && !p.summary) continue;
    lines.push("", `${p.name}: ${usd(spentByProgramme(p.id)) || "$0"} spent${p.budget_usd !== null ? ` of ${usd(p.budget_usd)}` : ""}`);
    if (p.summary) lines.push(`  ${p.summary.split("\n")[0].slice(0, 300)}`);
    for (const w of ws) lines.push(`  • ${w.worker || `run ${w.run_id}`}: ${w.state}${w.outcome ? `. ${w.outcome.summary.slice(0, 200)}` : w.status_line ? `. ${w.status_line.slice(0, 200)}` : ""}`);
  }
  const ev = eventsSince(since, { programme_id: programme?.id, limit: 500 });
  const auto = ev.filter((e) => e.kind === "auto_answer");
  if (auto.length) { lines.push("", `Answered by rules (${auto.length}):`); for (const e of auto.slice(0, 10)) lines.push(`  • ${e.text}`); }
  const blocked = ev.filter((e) => e.kind === "guard");
  if (blocked.length) { lines.push("", `Commands blocked (${blocked.length}):`); for (const e of blocked.slice(0, 5)) lines.push(`  • ${e.actor}: ${e.text}`); }
  if (!programme) {
    const overdue = db.query<ItemRow, [number]>("SELECT * FROM items WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT 10").all(now());
    if (overdue.length) { lines.push("", `Past their date (${overdue.length}):`); for (const i of overdue) lines.push(`  • ${i.owner || "nobody"}: ${i.title}`); }
  }
  return { text: lines.join("\n"), open_asks: asks.length, since };
}

let digestNext: number | null = null, digestCron = "";
function sendDigestIfDue() {
  const cron = setting("digest_cron");
  if (cron !== digestCron) { digestCron = cron; try { digestNext = cron ? nextCron(cron, now()) : null; } catch { digestNext = null; } }
  if (!digestNext || now() < digestNext) return;
  const last = Number(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = '_digest_last'").get()?.value ?? 0) || now() - 86400_000;
  const d = digest(last);
  db.prepare("INSERT INTO settings (key, value) VALUES ('_digest_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now()));
  try { digestNext = nextCron(cron, now()); } catch { digestNext = null; }
  notify({ kind: "digest", title: `lofiwave digest: ${d.open_asks ? `${d.open_asks} waiting on you` : "nothing waiting on you"}`, text: d.text, link: linkTo("inbox") });
}

// ---------------------------------------------------------------- the loop

let ticking = false, lastSlow = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await flushOutbox();
    noteEnds();
    noteStalls();
    sendDigestIfDue();
    if (now() - lastSlow > 10 * 60_000) {
      lastSlow = now();
      nudgeDue();
      // The log is for the digest and for "what happened last week", not an archive.
      db.prepare("DELETE FROM events WHERE at < ?").run(now() - 180 * 86400_000);
      db.prepare("DELETE FROM outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(now() - 30 * 86400_000);
    }
  } catch (e) { console.error("[autopilot] tick failed", e); } finally { ticking = false; }
}

export function startAutopilot(intervalMs = Number(process.env.AUTOPILOT_INTERVAL_MS ?? 10_000)) {
  setInterval(tick, intervalMs);
  setTimeout(tick, 1000);
}
