/**
 * What became of a message sent to a run (POST /api/runs/:id/message), read from the Claude transcript, so a caller
 * can get the answer without watching the screen or waiting for an idle that may never come (an agent running
 * monitors starts a new turn from its own task notifications as soon as it finishes one).
 *
 * Claude Code writes, in the session's transcript:
 *  - typed while it works: a `queue-operation` enqueue with the text; then either a `dequeue` and a `user` line (the
 *    message starts its own turn, with a `promptId`), or a `queued_command` attachment and a `remove` with reason
 *    `absorbed_mid_turn` (it was read in the middle of the running turn). A `remove` with another reason: it was taken
 *    out of the queue unread (Esc, edited, ...).
 *  - typed while idle: the same, or just the `user` line.
 *  - the turn ends with an assistant message that has `stop_reason: "end_turn"`, then a `system` `turn_duration` line.
 *
 * The reply is what the assistant said from the moment it read the message to the end of that turn.
 */
import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { db, type MessageRow, type RunRow } from "./db";
import { ApiError, getRun, noteClaudeSession, adoptSession } from "./runner";
import { claudeTranscriptPath, claudeProjectSlug } from "./agents";

export type MessageState =
  | "not_delivered" // Enter never sent it (POST /message said delivered: false)
  | "sent"          // typed and sent; not in the transcript yet
  | "queued"        // in Claude Code's queue: the agent is busy and hasn't read it yet
  | "answering"     // read: the turn that reads it is still going
  | "answered"      // that turn is over; `reply` is complete
  | "removed";      // taken out of the queue unread

export type Fate = {
  state: "sent" | "queued" | "answering" | "answered" | "removed";
  queued_at: number | null;
  /** When the agent read it: its own turn started (`turn`), or it was handed to the running turn (`mid_turn`). */
  read_at: number | null;
  read_as: "turn" | "mid_turn" | null;
  prompt_id: string | null;
  removed_reason: string | null;
  reply: { text: string; messages: { text: string; at: number }[]; done: boolean; interrupted: boolean; at: number | null };
};

/** A resumable scan of one transcript for one message. */
export type Scan = { text: string; notBefore: number; offset: number; fate: Fate; endTurnId: string | null };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const tsOf = (d: any) => { const t = Date.parse(d?.timestamp ?? ""); return Number.isFinite(t) ? t : 0; };

/** The text a user line was typed with (null for tool results and other non-prompts). */
function promptText(d: any): string | null {
  const c = d.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((p: any) => p?.type === "tool_result")) return null;
  const t = c.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n");
  return t || null;
}

export function newScan(text: string, notBefore: number, offset = 0): Scan {
  return {
    text: norm(text), notBefore, offset, endTurnId: null,
    fate: { state: "sent", queued_at: null, read_at: null, read_as: null, prompt_id: null, removed_reason: null, reply: { text: "", messages: [], done: false, interrupted: false, at: null } },
  };
}

/** Is `s` the message? Claude may keep a long paste differently, so a long text also matches on its start. */
function same(scan: Scan, s: unknown): boolean {
  if (typeof s !== "string") return false;
  const n = norm(s);
  return n === scan.text || (scan.text.length >= 80 && n.startsWith(scan.text.slice(0, 80)));
}

/** Feed transcript entries (in order) into a scan. Stops changing once the reply is done or the message was removed. */
export function feed(scan: Scan, entries: any[]) {
  const f = scan.fate;
  for (const d of entries) {
    if (f.state === "answered" || f.state === "removed") return;
    if (!d || typeof d !== "object" || d.isSidechain) continue;
    const at = tsOf(d);
    if (f.state === "sent" || f.state === "queued") {
      if (at && at < scan.notBefore) continue;
      if (d.type === "queue-operation") {
        if (d.operation === "enqueue" && same(scan, d.content) && f.state === "sent") { f.state = "queued"; f.queued_at = at; }
        else if (d.operation === "remove" && same(scan, d.content)) {
          if (d.reason === "absorbed_mid_turn") read(f, at, "mid_turn", null);
          else { f.state = "removed"; f.removed_reason = String(d.reason ?? "removed"); }
        }
      } else if (d.type === "attachment" && d.attachment?.type === "queued_command" && same(scan, d.attachment.prompt)) {
        read(f, at, "mid_turn", null);
      } else if (d.type === "user" && !d.isMeta && same(scan, promptText(d))) {
        read(f, at, "turn", d.promptId ?? null);
      }
      continue;
    }
    // Reading the turn that took the message in, up to its end.
    if (d.type === "system" && d.subtype === "turn_duration") { finish(f, at); return; }
    if (d.type === "assistant") {
      const id = d.message?.id ?? d.uuid;
      if (scan.endTurnId && id !== scan.endTurnId) { finish(f, null); return; }
      for (const p of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (p?.type === "text" && p.text?.trim()) { f.reply.messages.push({ text: p.text, at }); f.reply.at = at; }
      }
      if (d.message?.stop_reason === "end_turn") scan.endTurnId = id;
      continue;
    }
    if (d.type === "user" && !d.isMeta) {
      const t = promptText(d);
      if (t === null) continue;                                       // a tool result: same turn
      if (/^\[Request interrupted by user/.test(t)) { f.reply.interrupted = true; finish(f, null); return; }
      if (scan.endTurnId || (f.prompt_id && d.promptId && d.promptId !== f.prompt_id)) { finish(f, null); return; }
    }
    if (d.type === "queue-operation" && scan.endTurnId) { finish(f, null); return; }
  }
}

function read(f: Fate, at: number, how: "turn" | "mid_turn", promptId: string | null) {
  f.state = "answering"; f.read_at = at; f.read_as = how; f.prompt_id = promptId;
}
function finish(f: Fate, at: number | null) {
  f.state = "answered";
  f.reply.done = true;
  if (at && !f.reply.at) f.reply.at = at;
}

/** Complete JSONL lines from `offset` on (a line still being written is left for next time). */
function readLines(path: string, offset: number): { entries: any[]; offset: number } {
  const size = statSync(path).size;
  if (size <= offset) return { entries: [], offset: Math.min(offset, size) };
  const fd = openSync(path, "r");
  try {
    const entries: any[] = [];
    let pos = offset;
    const CHUNK = 4 * 1024 * 1024;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      readSync(fd, buf, 0, buf.length, pos);
      pos += buf.length;
      const all = carry.length ? Buffer.concat([carry, buf]) : buf;
      const last = all.lastIndexOf(10);
      if (last < 0) { carry = all; continue; }
      for (const line of all.subarray(0, last).toString("utf8").split("\n")) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* junk line */ }
      }
      carry = all.subarray(last + 1);
    }
    return { entries, offset: size - carry.length };
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------- per message

/** Scans in progress, by message id and transcript path. Lost on restart; they start again from the stored offset. */
const scans = new Map<number, Map<string, Scan>>();
/** Messages may be seen a little before they were sent by the clock of the line Claude writes. */
const SLACK_MS = 3000;

/** Before typing a message: the run's transcript and how long it is now, so the scan for it starts after what's there. */
export function transcriptMark(run: RunRow): { session_id: string; transcript_path: string; offset: number } {
  const sid = (run.status === "running" ? noteClaudeSession(run.id, run.pid, run.cwd) : null) ?? latestSession(run.id)?.session_id ?? "";
  const path = sid ? (sessionPath(run, sid) ?? "") : "";
  let offset = 0;
  try { if (path) offset = statSync(path).size; } catch { /* not written yet */ }
  return { session_id: sid, transcript_path: path, offset };
}

export function recordMessage(run: RunRow, text: string, sent: { sent_at: number; delivered: boolean | null; queued: boolean }, mark: ReturnType<typeof transcriptMark>, by = ""): number {
  const r = db.prepare(
    `INSERT INTO run_messages (run_id, text, sent_at, sent_by, delivered, queued, session_id, transcript_path, offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.id, text, sent.sent_at, by, sent.delivered === null ? null : sent.delivered ? 1 : 0, sent.queued ? 1 : 0, mark.session_id, mark.transcript_path, mark.offset);
  return Number(r.lastInsertRowid);
}

const latestSession = (runId: number) =>
  db.query<{ session_id: string; transcript_path: string; cwd: string; agent: string }, [number]>("SELECT session_id, transcript_path, cwd, agent FROM sessions WHERE run_id = ? ORDER BY started_at DESC, id DESC LIMIT 1").get(runId);

function sessionPath(run: RunRow, sid: string): string | null {
  const s = db.query<{ transcript_path: string; cwd: string }, [number, string]>("SELECT transcript_path, cwd FROM sessions WHERE run_id = ? AND session_id = ?").get(run.id, sid);
  const p = s?.transcript_path || claudeTranscriptPath(sid, s?.cwd || run.cwd);
  return p && existsSync(p) ? p : null;
}

/**
 * Transcripts the message may be in, most likely first: the one it was sent into, the run's sessions (a /clear
 * starts a new one), and, when the run has no session recorded at all, the session files in the run's folder that
 * changed since it was sent (the one with the message in it is the run's: it is then recorded).
 */
function candidates(run: RunRow, m: MessageRow): { path: string; offset: number; guess: boolean }[] {
  const out: { path: string; offset: number; guess: boolean }[] = [];
  const add = (path: string | null, offset = 0, guess = false) => { if (path && existsSync(path) && !out.some((c) => c.path === path)) out.push({ path, offset, guess }); };
  add(m.transcript_path, m.offset);
  if (run.status === "running") noteClaudeSession(run.id, run.pid, run.cwd);
  const rows = db.query<{ session_id: string }, [number]>("SELECT session_id FROM sessions WHERE run_id = ? AND agent = 'claude' ORDER BY started_at DESC, id DESC").all(run.id);
  for (const r of rows) add(sessionPath(run, r.session_id));
  if (!rows.length) {
    const dir = join(homedir(), ".claude", "projects", claudeProjectSlug(run.cwd));
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { /* no such folder */ }
    files.map((f) => join(dir, f))
      .map((p) => { try { return { p, t: statSync(p).mtimeMs }; } catch { return { p, t: 0 }; } })
      .filter((x) => x.t >= m.sent_at - SLACK_MS)
      .sort((a, b) => b.t - a.t).slice(0, 20)
      .forEach((x) => add(x.p, 0, true));
  }
  return out;
}

export type MessageOut = {
  message_id: number; run_id: number; text: string; sent_at: number; sent_by: string; delivered: boolean | null; queued: boolean;
  state: MessageState; queued_at: number | null; read_at: number | null; read_as: "turn" | "mid_turn" | null; prompt_id: string | null;
  removed_reason: string | null; reply: Fate["reply"] | null; answered_at: number | null;
  session_id: string; transcript_path: string;
  /** false: this run's messages can't be followed (not a claude run, or a run in a sandbox); the note says why. */
  tracked: boolean; note?: string;
};

function getMessage(runId: number, mid: number): MessageRow {
  const m = db.query<MessageRow, [number, number]>("SELECT * FROM run_messages WHERE id = ? AND run_id = ?").get(mid, runId);
  if (!m) throw new ApiError(404, `message ${mid} not found on run ${runId}`);
  return m;
}

/** Why a run's messages can't be followed through a transcript on this machine, or null when they can. */
function untracked(run: RunRow): string | null {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.target) return "the run is on a target: its transcript is only copied back when it ends";
  if (meta.docker) return "the run is in a container: its transcript is inside it, not on this machine";
  if (basename(run.command) !== "claude") return "replies are read from Claude Code transcripts; for other agents read GET /api/runs/:id/sessions/:session_id/messages";
  return null;
}

/** Where a message is now, and what the agent said to it so far. */
export function messageStatus(runId: number, mid: number): MessageOut {
  const run = getRun(runId);
  const m = getMessage(runId, mid);
  const base = {
    message_id: m.id, run_id: m.run_id, text: m.text, sent_at: m.sent_at, sent_by: m.sent_by,
    delivered: m.delivered === null ? null : m.delivered === 1, queued: m.queued === 1,
  };
  const none = { queued_at: null, read_at: null, read_as: null, prompt_id: null, removed_reason: null, reply: null, answered_at: null, session_id: m.session_id, transcript_path: m.transcript_path };
  if (m.delivered === 0) return { ...base, ...none, state: "not_delivered", tracked: true };
  const why = untracked(run);
  if (why) return { ...base, ...none, state: "sent", tracked: false, note: why };

  let mine = scans.get(m.id);
  if (!mine) scans.set(m.id, (mine = new Map()));
  let best: { path: string; scan: Scan; guess: boolean } | null = null;
  for (const c of candidates(run, m)) {
    let scan = mine.get(c.path);
    if (!scan) mine.set(c.path, (scan = newScan(m.text, m.sent_at - SLACK_MS, c.offset)));
    if (scan.fate.state !== "answered" && scan.fate.state !== "removed") {
      try { const r = readLines(c.path, scan.offset); feed(scan, r.entries); scan.offset = r.offset; } catch { continue; }
    }
    if (scan.fate.state !== "sent") { best = { path: c.path, scan, guess: c.guess }; break; }
  }
  if (best && best.path !== m.transcript_path) {
    // Found it somewhere else: remember where (and, if the run had no session, that this is its session).
    const sid = basename(best.path, ".jsonl");
    if (best.guess && /^[A-Za-z0-9_.-]+$/.test(sid)) adoptSession(run.id, { session_id: sid, cwd: run.cwd, transcript_path: best.path, source: "message" });
    db.prepare("UPDATE run_messages SET transcript_path = ?, session_id = ?, offset = 0 WHERE id = ?").run(best.path, sid, m.id);
    m.transcript_path = best.path; m.session_id = sid;
  }
  const f = best?.scan.fate;
  if (!f) {
    const note = run.status !== "running" ? "the run ended before the message showed up in its transcript" : undefined;
    return { ...base, ...none, state: "sent", tracked: true, ...(note ? { note } : {}), session_id: m.session_id, transcript_path: m.transcript_path };
  }
  return {
    ...base, state: f.state, queued_at: f.queued_at, read_at: f.read_at, read_as: f.read_as, prompt_id: f.prompt_id,
    removed_reason: f.removed_reason, reply: f.state === "answering" || f.state === "answered" ? { ...f.reply, text: f.reply.messages.map((x) => x.text.trim()).join("\n\n") } : null,
    answered_at: f.state === "answered" ? f.reply.at : null, session_id: m.session_id, transcript_path: m.transcript_path, tracked: true,
  };
}

/** The messages sent to a run, oldest first (the last `limit`). */
export function runMessages(runId: number, limit = 20): MessageOut[] {
  getRun(runId);
  const ids = db.query<{ id: number }, [number, number]>("SELECT id FROM run_messages WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, limit).map((r) => r.id).reverse();
  return ids.map((id) => messageStatus(runId, id));
}

/** States after which nothing more will happen to a message. */
const final = (s: MessageOut) => !s.tracked || ["answered", "removed", "not_delivered"].includes(s.state);

/**
 * Long-poll until the message is answered (the turn that read it is over), removed, or can't be followed, or until
 * the deadline. Also returns when the run ends: an ended run won't answer.
 */
export async function waitForReply(runId: number, mid: number, timeoutMs: number, signal?: AbortSignal): Promise<{ message: MessageOut; reached: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = messageStatus(runId, mid);
    const reached = final(message);
    if (reached || Date.now() >= deadline || signal?.aborted || getRun(runId).status !== "running") return { message, reached };
    await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}
