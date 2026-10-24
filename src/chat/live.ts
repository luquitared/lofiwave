/**
 * What the chat view learns from Claude while a turn is running, beyond the transcript (docs/rendered-view.md,
 * "Phase 5"). All of it comes from hooks and the statusline in the `--settings` file interactive claude runs get
 * (see ./settings.ts), so it exists only for runs of ours.
 *
 *  - Streaming text: `MessageDisplay` sends each assistant message a paragraph or so at a time, before the
 *    transcript has it. The TUI waits for this hook before it draws, so the endpoint answers at once.
 *  - Usage: the statusline command gets the model, context use, cost and rate limits on every refresh;
 *    scripts/claude-statusline.ts passes a copy here and still runs the user's own statusline.
 *  - Turn boundaries: `UserPromptSubmit` and `Stop` take git checkpoints (./checkpoints.ts) for per-turn changes.
 */
import { db, type RunRow } from "../db";
import { checkpoint } from "./checkpoints";
import { adoptSession } from "../runner";

/** One assistant message as it streams: `parts[index]` is each delta. */
export type Stream = { messageId: string; promptId: string; parts: string[]; final: boolean; at: number };

export type Usage = {
  model: string; context_pct: number | null; context_tokens: number | null; context_size: number | null;
  cost_usd: number | null; lines_added: number | null; lines_removed: number | null;
  rate_limits: Record<string, { used_percentage: number; resets_at: number }>;
  at: number;
};

/** A stream nobody matched (the transcript never got the message, say) is dropped after this. */
const STREAM_TTL_MS = 10 * 60_000;
/** How long the prompt hook may wait for its checkpoint before letting Claude go on (the hook's timeout is longer). */
const START_WAIT_MS = 3_000;

const streams = new Map<number, Map<string, Stream>>();
const usage = new Map<number, Usage>();

type What = "streams" | "usage" | "changes";
const listeners = new Set<(runId: number, what: What) => void>();
/** Called with a run id and what changed: its streams, its usage, or a turn's checkpoints. */
export function onLive(fn: (runId: number, what: What) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = (runId: number, what: What) => { for (const fn of listeners) { try { fn(runId, what); } catch (e) { console.error("[live]", e); } } };

/** The run a hook call is from, if it's a running run of ours (the header comes from the run's env). */
function runOf(req: Request): RunRow | null {
  const runId = Number(req.headers.get("x-lofiwave-run"));
  const run = runId ? db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId) : null;
  return run && run.status === "running" ? run : null;
}

export function streamsFor(runId: number): Stream[] {
  const m = streams.get(runId);
  if (!m) return [];
  const old = Date.now() - STREAM_TTL_MS;
  for (const [id, s] of m) if (s.at < old) m.delete(id);
  return [...m.values()].sort((a, b) => a.at - b.at);
}

/** The feed matched a stream to the transcript (or gave up on it): forget it. */
export function dropStream(runId: number, messageId: string) { streams.get(runId)?.delete(messageId); }

export const usageFor = (runId: number): Usage | null => usage.get(runId) ?? null;

// ---------------------------------------------------------------- hook endpoints

/** POST /api/hooks/message (MessageDisplay). Never waits: the TUI holds each paragraph until this returns. */
export function messageHook(req: Request, p: any) {
  const run = runOf(req);
  if (!run || p?.hook_event_name !== "MessageDisplay" || typeof p.message_id !== "string" || typeof p.delta !== "string") return;
  let m = streams.get(run.id);
  if (!m) streams.set(run.id, (m = new Map()));
  const s = m.get(p.message_id) ?? { messageId: p.message_id, promptId: String(p.prompt_id ?? ""), parts: [], final: false, at: Date.now() };
  const i = Number.isInteger(p.index) && p.index >= 0 && p.index < 10_000 ? p.index : s.parts.length;
  s.parts[i] = p.delta;
  if (p.final) s.final = true;
  m.set(p.message_id, s);
  changed(run.id, "streams");
}

/** POST /api/hooks/statusline, from scripts/claude-statusline.ts. Only what the view shows is kept. */
export function statuslineHook(req: Request, p: any) {
  const run = runOf(req);
  if (!run || !p || typeof p !== "object") return;
  const cw = p.context_window ?? {};
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const limits: Usage["rate_limits"] = {};
  for (const [k, v] of Object.entries(p.rate_limits ?? {})) {
    const x = v as any;
    if (num(x?.used_percentage) !== null) limits[k] = { used_percentage: x.used_percentage, resets_at: num(x.resets_at) ?? 0 };
  }
  const cur = cw.current_usage ?? {};
  const inContext = [cur.input_tokens, cur.cache_creation_input_tokens, cur.cache_read_input_tokens].every((v) => num(v) !== null)
    ? cur.input_tokens + cur.cache_creation_input_tokens + cur.cache_read_input_tokens : null;
  const next: Usage = {
    model: String(p.model?.display_name ?? p.model?.id ?? ""),
    context_pct: num(cw.used_percentage), context_tokens: inContext, context_size: num(cw.context_window_size),
    cost_usd: num(p.cost?.total_cost_usd), lines_added: num(p.cost?.total_lines_added), lines_removed: num(p.cost?.total_lines_removed),
    rate_limits: limits, at: Date.now(),
  };
  const prev = usage.get(run.id);
  usage.set(run.id, next);
  if (!prev || JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 })) changed(run.id, "usage");
}

/**
 * POST /api/hooks/turn (UserPromptSubmit, Stop). A prompt waits (up to START_WAIT_MS) for its start checkpoint, so
 * the snapshot is taken before Claude can change anything; Stop answers at once and snapshots afterwards.
 */
export async function turnHook(req: Request, p: any): Promise<void> {
  const run = runOf(req);
  const event = p?.hook_event_name;
  if (!run || (event !== "UserPromptSubmit" && event !== "Stop") || typeof p.prompt_id !== "string" || !p.prompt_id) return;
  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : run.cwd;
  const sid = String(p.session_id ?? "");
  // Every turn says which session it is in: the run has it even if the SessionStart hook never reported it.
  if (/^[A-Za-z0-9_.-]+$/.test(sid)) adoptSession(run.id, { session_id: sid, cwd, transcript_path: typeof p.transcript_path === "string" ? p.transcript_path : "", source: "turn hook" });
  if (event === "UserPromptSubmit") {
    // Anything still streaming belongs to an earlier prompt; the transcript has it by now.
    const m = streams.get(run.id);
    if (m) for (const [id, s] of m) if (s.promptId !== p.prompt_id) m.delete(id);
    const taken = checkpoint(run.id, cwd, sid, p.prompt_id, "start").then((c) => { if (c) changed(run.id, "changes"); }, (e) => console.error("[checkpoint]", e));
    await Promise.race([taken, new Promise((r) => setTimeout(r, START_WAIT_MS))]);
    return;
  }
  checkpoint(run.id, cwd, sid, p.prompt_id, "end").then((c) => { if (c) changed(run.id, "changes"); }, (e) => console.error("[checkpoint]", e));
}
