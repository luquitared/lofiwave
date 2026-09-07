import { db, now, type WorkflowRow, type RunRow } from "./db";
import { nextCron } from "./cron";
import { startRun, reconcileRuns } from "./runner";
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

export async function runWorkflow(wf: WorkflowRow, trigger: string): Promise<RunRow> {
  if (!wf.allow_overlap) {
    const active = db.query<{ id: number }, [number]>(
      "SELECT id FROM runs WHERE workflow_id = ? AND status = 'running' LIMIT 1",
    ).get(wf.id);
    if (active) {
      const { ApiError } = await import("./runner");
      throw new ApiError(409, `workflow "${wf.name}" already has run ${active.id} in progress`);
    }
  }
  return startRun({
    typeName: wf.type_name,
    cwd: wf.cwd,
    prompt: wf.prompt,
    extraArgs: JSON.parse(wf.extra_args || "[]"),
    env: JSON.parse(wf.env || "{}"),
    trigger,
    workflow: wf,
    timeoutSec: wf.timeout_sec,
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
