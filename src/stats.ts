/**
 * What the team is doing and when, for the bar above Advanced (GET /api/stats/team?days=7).
 *
 * Everything comes from lofiwave's own tables: runs (who started what, where), and turns, one row per prompt Claude
 * takes in a lofiwave run (its UserPromptSubmit hook), closed by Stop. A turn's length is how long the agent worked
 * on it, so summed turns are agent time. Work is credited to whoever started the run (sign-in name, an API key's
 * maker), not to whoever typed into a shared session: lofiwave can't tell those apart in the TUI.
 */
import { basename } from "node:path";
import { db, now } from "./db";
import { TOKEN_ACTOR, KEY_ACTOR_PREFIX } from "./auth";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A turn that never got its Stop (interrupted, crashed) counts at most this long. */
export const MAX_TURN_MS = 3 * HOUR;

/** UserPromptSubmit opens a turn (and closes the run's earlier open one, which an interrupt leaves open); Stop closes it. */
export function recordTurn(runId: number, sessionId: string, promptId: string, event: string, at = now()): void {
  try {
    if (event === "UserPromptSubmit") {
      db.query("UPDATE turns SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL AND prompt_id != ?").run(at, runId, promptId);
      db.query("INSERT OR IGNORE INTO turns (run_id, session_id, prompt_id, started_at) VALUES (?, ?, ?, ?)").run(runId, sessionId, promptId, at);
    } else if (event === "Stop") {
      db.query("UPDATE turns SET ended_at = ? WHERE run_id = ? AND prompt_id = ? AND ended_at IS NULL").run(at, runId, promptId);
    }
  } catch (e) { console.error("[turns]", e); }
}

/** Who a run's `started_by` stands for: a sign-in name, an API key's maker (or the key's name), the shared token. */
export function personOf(by: string | null, trigger: string, keyMakers: Map<string, string>): string {
  if (!by) return trigger === "schedule" ? "schedules" : "unknown";
  if (by === TOKEN_ACTOR) return "API token";
  if (by.startsWith(KEY_ACTOR_PREFIX)) {
    const key = by.slice(KEY_ACTOR_PREFIX.length), maker = keyMakers.get(key) ?? "";
    return maker && maker !== TOKEN_ACTOR && !maker.startsWith(KEY_ACTOR_PREFIX) ? maker : key;
  }
  return by;
}

export type PersonStats = { name: string; sessions: number; turns: number; agent_ms: number; running: number; working: number; last_at: number | null };
export type TeamStats = {
  days: number; since: number; at: number;
  totals: { people: number; sessions: number; workflow_runs: number; failed: number; turns: number; agent_ms: number; running: number; working: number };
  people: PersonStats[];
  projects: { name: string; turns: number; agent_ms: number; people: string[] }[];
  /** [hour start (ms), index into people, turns started that hour]: the client bins it by its own time zone. */
  activity: [number, number, number][];
};

type RunLite = { id: number; type_name: string; cwd: string; trigger: string; status: string; started_at: number; ended_at: number | null; workflow_id: number | null; by: string | null };

export function teamStats(days = 7, t = now()): TeamStats {
  days = Math.min(90, Math.max(1, Math.round(days) || 7));
  const since = t - days * DAY;
  const keyMakers = new Map(db.query<{ name: string; created_by: string }, []>("SELECT name, created_by FROM api_keys").all().map((k) => [k.name, k.created_by]));
  const agentTypes = new Set(db.query<{ name: string }, []>("SELECT name FROM process_types WHERE kind = 'agent'").all().map((r) => r.name));
  const runs = db.query<RunLite, [number, number]>(
    `SELECT id, type_name, cwd, trigger, status, started_at, ended_at, workflow_id, json_extract(meta, '$.started_by') AS by FROM runs
     WHERE started_at >= ? OR status IN ('running', 'queued') OR id IN (SELECT run_id FROM turns WHERE started_at >= ?)`).all(since, since);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const turns = db.query<{ run_id: number; started_at: number; ended_at: number | null }, [number]>(
    "SELECT run_id, started_at, ended_at FROM turns WHERE started_at >= ? ORDER BY started_at").all(since);

  const people = new Map<string, PersonStats>();
  const person = (name: string) => {
    let p = people.get(name);
    if (!p) people.set(name, (p = { name, sessions: 0, turns: 0, agent_ms: 0, running: 0, working: 0, last_at: null }));
    return p;
  };
  const touch = (p: PersonStats, at: number) => { if (p.last_at === null || at > p.last_at) p.last_at = at; };
  const totals = { people: 0, sessions: 0, workflow_runs: 0, failed: 0, turns: 0, agent_ms: 0, running: 0, working: 0 };
  const live = (r: RunLite) => r.status === "running" || r.status === "queued";

  for (const r of runs) {
    const p = person(personOf(r.by, r.trigger, keyMakers));
    if (r.started_at >= since) {
      if (r.workflow_id !== null || r.trigger === "schedule") totals.workflow_runs++;
      else if (agentTypes.has(r.type_name)) { p.sessions++; totals.sessions++; }
      if (["failed", "error", "timeout"].includes(r.status)) totals.failed++;
      touch(p, r.started_at);
    }
    if (r.status === "running" && agentTypes.has(r.type_name)) { p.running++; totals.running++; }
  }

  const projects = new Map<string, { name: string; turns: number; agent_ms: number; people: Set<string> }>();
  const hours = new Map<string, number>(); // `${hour}:${person}` → turns
  const workingRuns = new Set<number>();
  for (const turn of turns) {
    const r = runById.get(turn.run_id);
    if (!r) continue;
    const name = personOf(r.by, r.trigger, keyMakers), p = person(name);
    const open = turn.ended_at === null;
    const isWorking = open && live(r) && t - turn.started_at < MAX_TURN_MS;
    const end = open ? (isWorking ? t : turn.started_at) : turn.ended_at!;
    const ms = Math.max(0, Math.min(MAX_TURN_MS, end - turn.started_at));
    p.turns++; p.agent_ms += ms; totals.turns++; totals.agent_ms += ms;
    touch(p, open ? turn.started_at : turn.ended_at!);
    if (isWorking && !workingRuns.has(r.id)) { workingRuns.add(r.id); p.working++; totals.working++; }
    const proj = basename(r.cwd) || r.cwd || "?";
    let pr = projects.get(proj);
    if (!pr) projects.set(proj, (pr = { name: proj, turns: 0, agent_ms: 0, people: new Set() }));
    pr.turns++; pr.agent_ms += ms; pr.people.add(name);
    const key = `${Math.floor(turn.started_at / HOUR) * HOUR}:${name}`;
    hours.set(key, (hours.get(key) ?? 0) + 1);
  }

  // Busiest first; people with nothing in the window (only a live run from before it) still show.
  const list = [...people.values()].filter((p) => p.sessions || p.turns || p.running)
    .sort((a, b) => b.agent_ms - a.agent_ms || b.turns - a.turns || b.sessions - a.sessions || a.name.localeCompare(b.name));
  const index = new Map(list.map((p, i) => [p.name, i]));
  totals.people = list.filter((p) => p.name !== "schedules" && p.name !== "unknown").length;
  const activity: [number, number, number][] = [];
  for (const [key, n] of hours) {
    const i = key.indexOf(":"), at = Number(key.slice(0, i)), who = index.get(key.slice(i + 1));
    if (who !== undefined) activity.push([at, who, n]);
  }
  activity.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    days, since, at: t, totals, people: list,
    projects: [...projects.values()].sort((a, b) => b.agent_ms - a.agent_ms || b.turns - a.turns).slice(0, 8)
      .map((p) => ({ name: p.name, turns: p.turns, agent_ms: p.agent_ms, people: [...p.people] })),
    activity,
  };
}
