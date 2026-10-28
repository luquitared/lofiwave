/**
 * Plan usage for Advanced → Usage (GET /api/system/limits): how much of each agent's subscription limits is used,
 * when each window resets, and whether the pace lasts until then.
 *
 *  - Claude: the statusline of interactive claude runs gets `rate_limits` on every refresh (./chat/live.ts). The
 *    newest one is kept in `plan_limits`, so the page has numbers after a restart and while no run is open.
 *  - Codex: every rollout's `token_count` events carry `rate_limits` (~/.codex/sessions). The newest one wins, so
 *    it counts Codex sessions lofiwave didn't start too.
 *
 * Both are as of the agent's last request on this machine. A window whose reset time has passed is shown as reset.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db, now } from "./db";

export type LimitWindow = {
  id: string; label: string; used_percent: number; window_minutes: number | null; resets_at: number | null;
  /** The reset time is past: the window started over after the snapshot, so used_percent is 0. */
  reset: boolean;
  /** How much would be used by now at an even pace through the window, or null without a window length. */
  expected_percent: number | null;
};
export type AgentLimits = { agent: "claude" | "codex"; plan: string; at: number; windows: LimitWindow[] } | null;

/** Claude's statusline keys: five_hour, seven_day, and per-model weekly ones like seven_day_opus. */
const CLAUDE_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080 };

export function windowLabel(minutes: number | null, id = ""): string {
  const base = minutes === 300 ? "5-hour session" : minutes === 10080 ? "Weekly" : minutes === 1440 ? "Daily"
    : minutes ? `${minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${Math.round(minutes / 60)}-hour`} window` : id.replace(/_/g, " ");
  const model = /^seven_day_(.+)$/.exec(id)?.[1];
  return model ? `${base} · ${model.replace(/_/g, " ")} only` : base;
}

/** A window as of `at` (ms): what it is at `t`, with a passed reset counted and the even-pace expectation. */
export function windowAt(id: string, used: number, minutes: number | null, resetsAt: number | null, t = now()): LimitWindow {
  const reset = resetsAt !== null && resetsAt <= t;
  let expected: number | null = null;
  if (minutes && resetsAt !== null && !reset) {
    const left = (resetsAt - t) / (minutes * 60_000);
    expected = Math.round(Math.min(1, Math.max(0, 1 - left)) * 100);
  }
  return { id, label: windowLabel(minutes, id), used_percent: reset ? 0 : Math.round(used * 10) / 10, window_minutes: minutes, resets_at: resetsAt, reset, expected_percent: expected };
}

// ---------------------------------------------------------------- claude (statusline)

db.exec(`CREATE TABLE IF NOT EXISTS plan_limits (agent TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)`);

/** From the statusline hook: keep the newest rate limits any claude run reported (resets_at is in seconds). */
export function recordClaudeLimits(limits: Record<string, { used_percentage: number; resets_at: number }>) {
  if (!Object.keys(limits).length) return;
  db.query("INSERT INTO plan_limits (agent, data, at) VALUES ('claude', ?, ?) ON CONFLICT(agent) DO UPDATE SET data = excluded.data, at = excluded.at")
    .run(JSON.stringify(limits), now());
}

export function claudeLimits(t = now()): AgentLimits {
  const row = db.query<{ data: string; at: number }, []>("SELECT data, at FROM plan_limits WHERE agent = 'claude'").get();
  if (!row) return null;
  let limits: Record<string, { used_percentage: number; resets_at: number }> = {};
  try { limits = JSON.parse(row.data); } catch { return null; }
  const order = (k: string) => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2);
  const windows = Object.entries(limits).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([k, v]) => windowAt(k, v.used_percentage, CLAUDE_WINDOWS[k] ?? (k.startsWith("seven_day") ? 10080 : null), v.resets_at ? v.resets_at * 1000 : null, t));
  return { agent: "claude", plan: "", at: row.at, windows };
}

// ---------------------------------------------------------------- codex (rollouts)

const CODEX_SESSIONS = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
/** How far back from a rollout's end to look for its last rate limits. */
const TAIL_BYTES = 512 * 1024;
/** Rollouts to try, newest first, before giving up (one that never reached the API has none). */
const MAX_FILES = 20;

/** The last `rate_limits` in rollout text, with the event's time. */
export function lastCodexLimits(text: string): { at: number; rate_limits: any } | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const rl = e?.payload?.rate_limits;
      if (rl && (rl.primary || rl.secondary)) return { at: Date.parse(e.timestamp) || 0, rate_limits: rl };
    } catch { /* the cut first line, or a line being written */ }
  }
  return null;
}

export function codexWindows(rl: any, t = now()): LimitWindow[] {
  const out: LimitWindow[] = [];
  for (const id of ["primary", "secondary"]) {
    const w = rl?.[id];
    if (!w || typeof w.used_percent !== "number") continue;
    const minutes = typeof w.window_minutes === "number" ? w.window_minutes : null;
    out.push(windowAt(id, w.used_percent, minutes, typeof w.resets_at === "number" ? w.resets_at * 1000 : null, t));
  }
  return out.sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity));
}

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size, len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

const list = (dir: string) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };

/** Newest rollouts first: walk the YYYY/MM/DD folders from the end and sort each day's files by modification time. */
function newestRollouts(): string[] {
  if (!existsSync(CODEX_SESSIONS)) return [];
  const out: string[] = [];
  for (const y of list(CODEX_SESSIONS)) for (const m of list(join(CODEX_SESSIONS, y))) for (const d of list(join(CODEX_SESSIONS, y, m))) {
    const dir = join(CODEX_SESSIONS, y, m, d);
    const files = list(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
    out.push(...files.sort((a, b) => mtime(b) - mtime(a)));
    if (out.length >= MAX_FILES) return out.slice(0, MAX_FILES);
  }
  return out;
}

/** The last rollout read, keyed by the newest files and their times: the page polls, rollouts change per request. */
let codexCache: { key: string; found: { at: number; rate_limits: any } | null } | null = null;

export function codexLimits(t = now()): AgentLimits {
  const files = newestRollouts();
  const key = files.slice(0, 3).map((f) => { try { return `${f}:${statSync(f).mtimeMs}`; } catch { return f; } }).join("|");
  if (codexCache?.key !== key) {
    let found: { at: number; rate_limits: any } | null = null;
    for (const f of files) { try { if ((found = lastCodexLimits(tail(f)))) break; } catch { /* unreadable: the next one */ } }
    codexCache = { key, found };
  }
  const found = codexCache.found;
  return found && { agent: "codex", plan: String(found.rate_limits.plan_type ?? ""), at: found.at, windows: codexWindows(found.rate_limits, t) };
}

export const planLimits = (t = now()) => ({ claude: claudeLimits(t), codex: codexLimits(t), server_time: t });
