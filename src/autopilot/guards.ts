/**
 * Guards: commands an agent may not run, enforced outside the prompt. Interactive claude runs get a PreToolUse hook
 * (src/chat/settings.ts) that asks here before every Bash call; a command that matches a guard is refused, with the
 * reason given to the agent. A rule in a brief is a request; this is a limit.
 *
 * It covers what lofiwave can see: the command line of a Bash call in a claude run on this machine. A script the
 * agent wrote and then runs, a run on a target or in a container, and Codex are not covered.
 */
import { db, now, type RunRow } from "../db";
import { ApiError } from "../runner";
import { logEvent } from "./core";
import { budgetOf, programmeRun } from "./programmes";
import type { GuardRow } from "./schema";

const BUILTIN: Omit<GuardRow, "id" | "enabled" | "builtin" | "hits" | "last_hit_at" | "created_at">[] = [
  {
    name: "tmux-kill-server",
    pattern: String.raw`\btmux\b[^|;&\n]*\bkill-server\b`,
    unless: String.raw`\btmux\b[^|;&\n]*\s-[LS]\s*\S+[^|;&\n]*\bkill-server\b`,
    when: "always",
    message: "`tmux kill-server` on the default socket ends every lofiwave session on this machine, yours included. Use your own server (`tmux -L <name> …`, and `tmux -L <name> kill-server` to end it), or kill one session by name.",
  },
  {
    name: "kill-tmux",
    pattern: String.raw`\b(pkill|killall)\b[^|;&\n]*\btmux\b`,
    unless: "",
    when: "always",
    message: "Killing tmux processes by name ends every lofiwave session on this machine. Kill your own processes by pid.",
  },
  {
    name: "persistent-spot",
    pattern: String.raw`request-spot-fleet|SpotInstanceType["'=:\s]+persistent|InstanceInterruptionBehavior["'=:\s]+(stop|hibernate)`,
    unless: "",
    when: "always",
    message: "No persistent spot requests or fleets: they relaunch machines after you stop looking. Use a one-time spot or an on-demand instance, and terminate it when you finish.",
  },
  {
    name: "over-budget-machines",
    pattern: String.raw`\baws\s+ec2\s+(run-instances|start-instances|request-spot-instances)\b|\bgcloud\s+compute\s+instances\s+(create|start)\b`,
    unless: "",
    when: "over_budget",
    message: "This run has reached its budget, so it can't start machines. Ask for a higher cap first: lw ask \"…\" --class budget --amount <new cap>.",
  },
];

/** Add the built-in guards a database doesn't have yet (a guard someone turned off stays off). */
export function seedGuards() {
  const ins = db.prepare(`INSERT OR IGNORE INTO guards (name, pattern, unless, "when", message, builtin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`);
  for (const g of BUILTIN) ins.run(g.name, g.pattern, g.unless, g.when, g.message, now());
}
seedGuards();

export const listGuards = () => db.query<GuardRow, []>("SELECT * FROM guards ORDER BY builtin DESC, id").all();
export function getGuard(id: number): GuardRow {
  const g = db.query<GuardRow, [number]>("SELECT * FROM guards WHERE id = ?").get(id);
  if (!g) throw new ApiError(404, `guard ${id} not found`);
  return g;
}
const regex = (src: string, field: string) => { try { return new RegExp(src, "i"); } catch (e: any) { throw new ApiError(400, `${field} is not a valid regular expression: ${e.message}`); } };

export function saveGuard(cur: GuardRow | null, b: { name?: string; pattern?: string; unless?: string; when?: string; message?: string; enabled?: boolean }): GuardRow {
  const name = (b.name ?? cur?.name ?? "").trim();
  const pattern = (b.pattern ?? cur?.pattern ?? "").trim();
  const unless = (b.unless ?? cur?.unless ?? "").trim();
  const when = b.when ?? cur?.when ?? "always";
  if (!name) throw new ApiError(400, "name is required");
  if (!pattern) throw new ApiError(400, "pattern is required: a regular expression tested against the command");
  regex(pattern, "pattern");
  if (unless) regex(unless, "unless");
  if (!["always", "over_budget"].includes(when)) throw new ApiError(400, "when must be always or over_budget");
  const message = (b.message ?? cur?.message ?? "").trim() || "This command is not allowed in runs on this machine.";
  const enabled = b.enabled === undefined ? cur?.enabled ?? 1 : b.enabled ? 1 : 0;
  if (cur) {
    db.prepare(`UPDATE guards SET name = ?, pattern = ?, unless = ?, "when" = ?, message = ?, enabled = ? WHERE id = ?`).run(name, pattern, unless, when, message, enabled, cur.id);
    return getGuard(cur.id);
  }
  if (db.query("SELECT 1 FROM guards WHERE name = ?").get(name)) throw new ApiError(409, `a guard "${name}" already exists`);
  return getGuard(Number(db.prepare(`INSERT INTO guards (name, pattern, unless, "when", message, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, pattern, unless, when, message, enabled, now()).lastInsertRowid));
}

/** The guard that refuses this command for this run, or null. */
export function checkCommand(run: RunRow, command: string): GuardRow | null {
  let over: boolean | null = null;
  for (const g of db.query<GuardRow, []>("SELECT * FROM guards WHERE enabled = 1 ORDER BY id").all()) {
    let hit = false;
    try { hit = new RegExp(g.pattern, "i").test(command) && !(g.unless && new RegExp(g.unless, "i").test(command)); } catch { continue; }
    if (!hit) continue;
    if (g.when === "over_budget") {
      over ??= programmeRun(run.id) ? budgetOf(run.id).over : false;
      if (!over) continue;
    }
    return g;
  }
  return null;
}

/** POST /api/hooks/pretool (Claude Code's PreToolUse hook, Bash only). `{}` = no opinion; a match is denied with the guard's message. */
export function pretoolHook(req: Request, p: any): object {
  const runId = Number(req.headers.get("x-lofiwave-run"));
  const run = runId ? db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId) : null;
  const command = p?.tool_input?.command;
  if (!run || run.status !== "running" || p?.hook_event_name !== "PreToolUse" || p.tool_name !== "Bash" || typeof command !== "string") return {};
  const g = checkCommand(run, command);
  if (!g) return {};
  db.prepare("UPDATE guards SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(now(), g.id);
  const pr = programmeRun(run.id);
  logEvent({ kind: "guard", programme_id: pr?.programme_id ?? null, run_id: run.id, ref: `guard:${g.id}`, actor: pr?.worker || `run ${run.id}`, text: `Blocked (${g.name}): ${command.replace(/\s+/g, " ").slice(0, 200)}` });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Blocked by lofiwave (${g.name}): ${g.message}` } };
}
