/**
 * What a run's agent is doing right now: `working`, `idle`, `waiting_input` or `done`, plus since when.
 *
 * A basic version derived from what the console already tracks: the run's status, and for claude the
 * idle/busy status Claude Code writes to its own session registry (~/.claude/sessions/<pid>.json).
 * Agents that report nothing (codex, apps) count as `working` while they run. One function, so a better
 * source (hooks, screen parsing) can replace it without touching its callers.
 */
import type { RunRow } from "./db";
import { claudeRegistry } from "./agents";

export type Activity = "working" | "idle" | "waiting_input" | "done";

/** Last activity seen per run and when it started, so `activity_since` survives between polls (in memory). */
const seen = new Map<number, { activity: Activity; since: number }>();

function current(run: RunRow): Activity {
  if (run.status !== "running") return "done";
  const st = run.pid ? claudeRegistry().byPid.get(run.pid)?.status ?? "" : "";
  if (st === "idle") return "idle";
  if (/wait|permission|input|blocked/i.test(st)) return "waiting_input";
  return "working";
}

export function activityOf(run: RunRow): { activity: Activity; activity_since: number } {
  const activity = current(run);
  const prev = seen.get(run.id);
  if (activity === "done") {
    seen.delete(run.id);
    return { activity, activity_since: run.ended_at ?? Date.now() };
  }
  if (prev?.activity === activity) return { activity, activity_since: prev.since };
  // First look at a run that is working: it has been since it started, as far as we know.
  const since = !prev && activity === "working" ? run.started_at : Date.now();
  seen.set(run.id, { activity, since });
  return { activity, activity_since: since };
}
