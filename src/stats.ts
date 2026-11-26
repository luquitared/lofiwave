/**
 * Advanced → Stats: who sent what, and the tokens it cost, per person, session and folder (GET /api/stats?days=).
 *
 * Who sent a prompt: lofiwave notes who is about to send one (noteSender) when someone sends from the chat view,
 * through the API, or presses Enter in the browser terminal. When Claude's UserPromptSubmit hook then reports the
 * prompt, the turn is recorded with that sender. Prompts typed where lofiwave can't see who (an ssh/tmux attach,
 * Claude's remote control) have no sender, and neither do prompts from before this was tracked.
 *
 * Tokens: per API call from the transcripts (src/tokens.ts), tied to a prompt by its id. Every Claude session on the
 * machine counts toward sessions and folders; only prompts lofiwave saw being sent count toward a person.
 */
import { basename } from "node:path";
import { db, now } from "./db";
import { TOKEN_ACTOR, KEY_ACTOR_PREFIX } from "./auth";

const DAY = 86_400_000;
/** How long after someone sends (chat, API) or presses Enter (terminal) a prompt Claude reports is theirs. */
const SENDER_WINDOW_MS: Record<Via, number> = { chat: 90_000, api: 90_000, terminal: 20_000 };
const TEXT_MAX = 2000;

export type Via = "chat" | "terminal" | "api";
const pending = new Map<number, { by: string; via: Via; at: number }>();

/** Someone is sending input to run `runId`'s agent: the next prompt it reports is theirs. */
export function noteSender(runId: number, by: string | undefined, via: Via, at = now()): void {
  if (by) pending.set(runId, { by, via, at });
}

/** UserPromptSubmit opens a turn (and closes the run's earlier open one, which an interrupt leaves open); Stop closes it. */
export function recordTurn(runId: number, sessionId: string, promptId: string, event: string, text = "", at = now()): void {
  try {
    if (event === "UserPromptSubmit") {
      const p = pending.get(runId);
      const sender = p && at - p.at <= SENDER_WINDOW_MS[p.via] ? p : null;
      if (sender) pending.delete(runId);
      db.query("UPDATE turns SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL AND prompt_id != ?").run(at, runId, promptId);
      db.query("INSERT OR IGNORE INTO turns (run_id, session_id, prompt_id, started_at, sent_by, via, text) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, sessionId, promptId, at, sender?.by ?? "", sender?.via ?? "", text.slice(0, TEXT_MAX));
    } else if (event === "Stop") {
      db.query("UPDATE turns SET ended_at = ? WHERE run_id = ? AND prompt_id = ? AND ended_at IS NULL").run(at, runId, promptId);
    }
  } catch (e) { console.error("[turns]", e); }
}

/** The person behind an actor: a sign-in name, an API key's maker (else the key's name), the console token; '' = nobody known. */
export function personOf(by: string, keyMakers: Map<string, string>): string {
  if (!by) return "";
  if (by === TOKEN_ACTOR) return "API token";
  if (by.startsWith(KEY_ACTOR_PREFIX)) {
    const key = by.slice(KEY_ACTOR_PREFIX.length), maker = keyMakers.get(key) ?? "";
    return maker && maker !== TOKEN_ACTOR && !maker.startsWith(KEY_ACTOR_PREFIX) ? maker : key;
  }
  return by;
}
const keyMakers = () => new Map(db.query<{ name: string; created_by: string }, []>("SELECT name, created_by FROM api_keys").all().map((k) => [k.name, k.created_by]));

export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; total: number };
const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });
function add(t: Tokens, u: { input: number; output: number; cache_read: number; cache_write: number }) {
  t.input += u.input; t.output += u.output; t.cache_read += u.cache_read; t.cache_write += u.cache_write;
  t.total += u.input + u.output + u.cache_read + u.cache_write;
}

export type PersonRow = { person: string; messages: number; sessions: number; tokens: Tokens; via: Record<string, number>; last_at: number | null };
export type SessionStat = { session_id: string; title: string; cwd: string; run_id: number | null; messages: number; people: string[]; tokens: Tokens; last_at: number };
export type FolderStat = { cwd: string; name: string; sessions: number; messages: number; people: string[]; tokens: Tokens; last_at: number };
export type Stats = {
  days: number; since: number; at: number;
  totals: { messages: number; tracked_messages: number; tokens: Tokens; sessions: number; people: number };
  /** By messages sent; person '' = prompts lofiwave didn't see anyone send. */
  people: PersonRow[]; sessions: SessionStat[]; folders: FolderStat[];
};

type Call = { session_id: string; prompt_id: string; cwd: string; at: number; input: number; output: number; cache_read: number; cache_write: number };
type Turn = { run_id: number; session_id: string; prompt_id: string; started_at: number; sent_by: string; via: string; cwd: string };

export function stats(days = 7, t = now(), limit = 25): Stats {
  days = Math.min(90, Math.max(1, Math.round(days) || 7));
  const since = t - days * DAY, makers = keyMakers();
  // Per prompt: its calls' tokens in the window (subagents' too), the session, folder and time of the last call.
  const calls = db.query<Call, [number]>(
    `SELECT session_id, prompt_id, cwd, MAX(at) AS at, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
     FROM token_calls WHERE at >= ? GROUP BY session_id, prompt_id`).all(since);
  // A prompt sent before the window can still be making calls in it: look turns up from a day earlier.
  const recent = db.query<Turn, [number]>(
    `SELECT t.run_id, t.session_id, t.prompt_id, t.started_at, t.sent_by, t.via, r.cwd FROM turns t JOIN runs r ON r.id = t.run_id WHERE t.started_at >= ?`).all(since - DAY);
  const turnOf = new Map(recent.map((x) => [x.prompt_id, x]));
  const turns = recent.filter((x) => x.started_at >= since);
  const runOfSession = new Map(db.query<{ session_id: string; run_id: number }, []>("SELECT session_id, MAX(run_id) AS run_id FROM sessions GROUP BY session_id").all().map((r) => [r.session_id, r.run_id]));

  const people = new Map<string, PersonRow & { _s: Set<string> }>();
  const personRow = (p: string) => {
    let r = people.get(p);
    if (!r) people.set(p, (r = { person: p, messages: 0, sessions: 0, tokens: zero(), via: {}, last_at: null, _s: new Set() }));
    return r;
  };
  const sessions = new Map<string, SessionStat & { _p: Set<string>; _m: Set<string> }>();
  const folders = new Map<string, FolderStat & { _p: Set<string>; _s: Set<string>; _m: Set<string> }>();
  const totals = { messages: 0, tracked_messages: 0, tokens: zero(), sessions: 0, people: 0 };
  const seenPrompt = new Set<string>();

  const touch = (sid: string, cwd: string, prompt: string, who: string | null, at: number, u: Tokens | null) => {
    let s = sessions.get(sid);
    if (!s) sessions.set(sid, (s = { session_id: sid, title: "", cwd, run_id: runOfSession.get(sid) ?? null, messages: 0, people: [], tokens: zero(), last_at: 0, _p: new Set(), _m: new Set() }));
    if (!s.cwd) s.cwd = cwd;
    const key = s.cwd || cwd || "?";
    let f = folders.get(key);
    if (!f) folders.set(key, (f = { cwd: key, name: basename(key) || key, sessions: 0, messages: 0, people: [], tokens: zero(), last_at: 0, _p: new Set(), _s: new Set(), _m: new Set() }));
    if (prompt) { s._m.add(prompt); f._m.add(prompt); }
    f._s.add(sid);
    if (who) { s._p.add(who); f._p.add(who); }
    if (u) { add(s.tokens, u); add(f.tokens, u); }
    s.last_at = Math.max(s.last_at, at); f.last_at = Math.max(f.last_at, at);
  };

  // Prompts that made API calls in the window: every Claude session here.
  for (const c of calls) {
    const turn = c.prompt_id ? turnOf.get(c.prompt_id) : undefined;
    const who = turn ? personOf(turn.sent_by, makers) : "";
    const u = { ...zero(), input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write, total: c.input + c.output + c.cache_read + c.cache_write };
    add(totals.tokens, u);
    const p = personRow(who);
    add(p.tokens, u); p._s.add(c.session_id);
    p.last_at = Math.max(p.last_at ?? 0, c.at);
    touch(c.session_id, c.cwd, c.prompt_id, who || null, c.at, u);
    if (c.prompt_id && !seenPrompt.has(c.prompt_id)) {
      seenPrompt.add(c.prompt_id);
      if (!turn) { p.messages++; totals.messages++; }
    }
  }
  // Prompts lofiwave recorded (whether or not their tokens are indexed yet).
  for (const turn of turns) {
    const who = personOf(turn.sent_by, makers), p = personRow(who);
    p.messages++; totals.messages++;
    if (who) totals.tracked_messages++;
    if (turn.via) p.via[turn.via] = (p.via[turn.via] ?? 0) + 1;
    p._s.add(turn.session_id);
    p.last_at = Math.max(p.last_at ?? 0, turn.started_at);
    seenPrompt.add(turn.prompt_id);
    if (turn.session_id) touch(turn.session_id, turn.cwd, turn.prompt_id, who || null, turn.started_at, null);
  }

  const peopleOut = [...people.values()].map(({ _s, ...p }) => ({ ...p, sessions: _s.size }))
    .sort((a, b) => (a.person === "" ? 1 : 0) - (b.person === "" ? 1 : 0) || b.messages - a.messages || b.tokens.total - a.tokens.total || a.person.localeCompare(b.person));
  totals.people = peopleOut.filter((p) => p.person).length;
  totals.sessions = sessions.size;

  const titles = db.query<{ title: string }, [string]>("SELECT CASE WHEN custom_title != '' THEN custom_title ELSE ai_title END AS title FROM token_sessions WHERE session_id = ?");
  const sessionsOut = [...sessions.values()].sort((a, b) => b.tokens.total - a.tokens.total || b._m.size - a._m.size).slice(0, limit)
    .map(({ _p, _m, ...s }) => ({ ...s, title: titles.get(s.session_id)?.title ?? "", messages: _m.size, people: [..._p] }));
  const foldersOut = [...folders.values()].sort((a, b) => b.tokens.total - a.tokens.total || b._m.size - a._m.size).slice(0, limit)
    .map(({ _p, _s, _m, ...f }) => ({ ...f, sessions: _s.size, messages: _m.size, people: [..._p] }));
  return { days, since, at: t, totals, people: peopleOut, sessions: sessionsOut, folders: foldersOut };
}

export type SentMessage = { at: number; person: string; via: string; text: string; run_id: number; session_id: string; cwd: string; tokens: Tokens };

/** What a person sent (person '' = prompts without a known sender), newest first, with the tokens each one cost. */
export function sentMessages(person: string, days = 7, t = now(), limit = 100): SentMessage[] {
  const since = t - Math.min(90, Math.max(1, days)) * DAY, makers = keyMakers();
  const rows = db.query<Turn & { text: string }, [number]>(
    `SELECT t.run_id, t.session_id, t.prompt_id, t.started_at, t.sent_by, t.via, t.text, r.cwd FROM turns t JOIN runs r ON r.id = t.run_id
     WHERE t.started_at >= ? ORDER BY t.started_at DESC`).all(since).filter((r) => personOf(r.sent_by, makers) === person).slice(0, Math.min(500, limit));
  const tok = db.query<{ input: number; output: number; cache_read: number; cache_write: number }, [string]>(
    "SELECT COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cache_read, COALESCE(SUM(cache_write),0) AS cache_write FROM token_calls WHERE prompt_id = ?");
  return rows.map((r) => {
    const u = tok.get(r.prompt_id)!, tokens = zero();
    add(tokens, u);
    return { at: r.started_at, person, via: r.via, text: r.text, run_id: r.run_id, session_id: r.session_id, cwd: r.cwd, tokens };
  });
}
