import { db, now, type WorkflowRow, type RunRow } from "./db";
import { nextCron } from "./cron";
import { startRun, reconcileRuns, getType, tmuxPath } from "./runner";
import { config } from "./config";

export function computeNext(schedule: string, after = now()): number | null {
  if (!schedule.trim()) return null;
  return nextCron(schedule, after);
}

export function refreshNextRun(wf: WorkflowRow) {
  const next = wf.enabled ? computeNext(wf.schedule) : null;
  db.prepare("UPDATE workflows SET next_run_at = ? WHERE id = ?").run(next, wf.id);
}

export function refreshAllNextRuns() {
  for (const wf of db.query<WorkflowRow, []>("SELECT * FROM workflows").all()) refreshNextRun(wf);
}

/** `target` overrides the workflow's own for this run ('' = this machine). */
export async function runWorkflow(wf: WorkflowRow, trigger: string, target: string = wf.target): Promise<RunRow> {
  if (!wf.allow_overlap) {
    const active = db.query<{ id: number }, [number]>(
      "SELECT id FROM runs WHERE workflow_id = ? AND status = 'running' LIMIT 1",
    ).get(wf.id);
    if (active) {
      const { ApiError } = await import("./runner");
      throw new ApiError(409, `workflow "${wf.name}" already has run ${active.id} in progress`);
    }
  }
  // Agents run interactively, so a run can be watched and steered from the browser while it works; it closes itself
  // once the agent is done. Without tmux (or for an app type, or on a target) it runs headless as before.
  // On an e2b target the agent can have a live terminal in its sandbox too, when the target ends idle runs by itself
  // (idle_sec with idle_action "stop"); otherwise a finished agent would sit there until the run times out.
  const t = target ? db.query<{ kind: string; config: string }, [string]>("SELECT kind, config FROM targets WHERE name = ?").get(target) : null;
  const tc = t?.kind === "e2b" ? JSON.parse(t.config || "{}") : null;
  const isAgent = getType(wf.type_name).kind === "agent";
  const interactive = isAgent && (target ? Boolean(tc && tc.idle_sec > 0 && tc.idle_action === "stop") : Boolean(tmuxPath()));
  return startRun({
    typeName: wf.type_name,
    cwd: wf.cwd,
    prompt: wf.prompt,
    extraArgs: JSON.parse(wf.extra_args || "[]"),
    env: JSON.parse(wf.env || "{}"),
    trigger,
    workflow: wf,
    timeoutSec: wf.timeout_sec,
    interactive,
    stopWhenIdle: interactive && !target,
    // No window popping up on the machine for a cron run; it is in the browser's session list.
    terminal: "none",
    target: target || undefined,
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    reconcileRuns();
    const t = now();
    const due = db.query<WorkflowRow, [number]>(
      "SELECT * FROM workflows WHERE enabled = 1 AND schedule != '' AND next_run_at IS NOT NULL AND next_run_at <= ?",
    ).all(t);
    for (const wf of due) {
      // Advance first so a failure to start doesn't retry every tick.
      db.prepare("UPDATE workflows SET next_run_at = ? WHERE id = ?").run(computeNext(wf.schedule, t), wf.id);
      try {
        const run = await runWorkflow(wf, "schedule");
        console.log(`[scheduler] started run ${run.id} for workflow "${wf.name}"`);
      } catch (e: any) {
        console.warn(`[scheduler] workflow "${wf.name}" skipped: ${e?.message ?? e}`);
        db.prepare(
          `INSERT INTO runs (workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger, status, started_at, ended_at, error)
           VALUES (?, ?, ?, ?, '', '[]', ?, ?, 'schedule', 'error', ?, ?, ?)`,
        ).run(wf.id, wf.name, wf.type_name, wf.cwd, wf.prompt, wf.env, t, t, String(e?.message ?? e));
      }
    }
  } catch (e) {
    console.error("[scheduler] tick failed", e);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  refreshAllNextRuns();
  reconcileRuns();
  setInterval(tick, config.schedulerIntervalMs);
  console.log(`[scheduler] running every ${config.schedulerIntervalMs / 1000}s`);
}
