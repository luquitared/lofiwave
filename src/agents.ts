/**
 * What the agents themselves know about their sessions, read from their own on-disk state:
 *
 * - Claude Code keeps ~/.claude/sessions/<pid>.json for every running process (session id, the name it
 *   chose, cwd, idle/working status, the Remote Control bridge id) and one transcript per session under
 *   ~/.claude/projects/<cwd slug>/<session id>.jsonl (auto title, /rename title, model, bridge session).
 * - Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl (first line: session_meta), and
 *   indexes every thread in ~/.codex/state_<n>.sqlite (`threads`: cwd, who started it, title, name, times). Since
 *   0.16x the TUI runs its threads in a shared `codex app-server` daemon, so no process of ours holds the rollout
 *   open: the index is how a run finds its thread.
 *
 * Everything here is best-effort and cached; a missing file just means "unknown".
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CLAUDE_SESSIONS = join(HOME, ".claude", "sessions");
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");

export type ClaudeRegistryEntry = {
  pid: number; sessionId: string; cwd: string; name: string; nameSource?: string; kind?: string;
  status?: string; bridgeSessionId?: string; tmux?: string; startedAt?: number;
};

/** Enriched view of a session, whatever the agent. */
export type SessionInfo = {
  agent: string;
  session_id: string;
  /** Best display name: /rename title, else auto title, else the agent's derived name, else the first prompt. */
  title: string;
  /** The name Claude Code itself uses for the session (what the Claude app shows), when known. */
  name: string;
  status: string;             // idle | working | '' (unknown / not running)
  model: string;
  cwd: string;
  transcript_path: string;
  /** Same session on claude.ai (Remote Control), when it has one. */
  web_url: string;
  /** Command to reopen it in a terminal on this machine. */
  resume_cmd: string;
  /** tmux target the session runs in, per the agent's own registry; '' when it is not in tmux at all. */
  tmux: string;
};

// ---------------------------------------------------------------- claude: process registry

let registryCache: { at: number; byPid: Map<number, ClaudeRegistryEntry>; bySession: Map<string, ClaudeRegistryEntry> } | null = null;

export function claudeRegistry(fresh = false): { byPid: Map<number, ClaudeRegistryEntry>; bySession: Map<string, ClaudeRegistryEntry> } {
  const t = Date.now();
  if (!fresh && registryCache && t - registryCache.at < 2000) return registryCache;
  const byPid = new Map<number, ClaudeRegistryEntry>();
  const bySession = new Map<string, ClaudeRegistryEntry>();
  if (existsSync(CLAUDE_SESSIONS)) {
    for (const f of readdirSync(CLAUDE_SESSIONS)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(CLAUDE_SESSIONS, f), "utf8")) as ClaudeRegistryEntry;
        if (!e.pid || !e.sessionId) continue;
        if (!pidAlive(e.pid)) continue;                 // stale file from a process that is gone
        byPid.set(e.pid, e);
        bySession.set(e.sessionId, e);
      } catch { /* partial write or junk */ }
    }
  }
  registryCache = { at: t, byPid, bySession };
  return registryCache;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export const claudeWebUrl = (bridgeSessionId: string | undefined | null) =>
  bridgeSessionId ? `https://claude.ai/code/${bridgeSessionId.replace(/^cse_/, "session_")}` : "";

// ---------------------------------------------------------------- claude: transcripts

/** Claude Code's project folder for a cwd: every non-alphanumeric character becomes '-'. */
export const claudeProjectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
/** Where claude keeps a session's transcript when it runs in `cwd` (and so where `claude --resume` there looks for it). */
export const claudeTranscriptHome = (sessionId: string, cwd: string) => join(CLAUDE_PROJECTS, claudeProjectSlug(cwd), `${sessionId}.jsonl`);

export function claudeTranscriptPath(sessionId: string, cwd: string): string {
  const direct = join(CLAUDE_PROJECTS, claudeProjectSlug(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // cwd unknown or the session was moved: look through every project folder (cheap, few hundred dirs at most).
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const d of readdirSync(CLAUDE_PROJECTS)) {
      const p = join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  return "";
}

type TranscriptMeta = { title: string; customTitle: string; aiTitle: string; bridgeSessionId: string; model: string; firstPrompt: string; cwd: string };
const transcriptCache = new Map<string, { key: string; meta: TranscriptMeta }>();

export function claudeTranscriptMeta(path: string): TranscriptMeta | null {
  if (!path || !existsSync(path)) return null;
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = transcriptCache.get(path);
  if (hit && hit.key === key) return hit.meta;
  const meta: TranscriptMeta = { title: "", customTitle: "", aiTitle: "", bridgeSessionId: "", model: "", firstPrompt: "", cwd: "" };
  // Titles and bridge ids are tiny lines; scan line by line without parsing every message.
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!meta.cwd) { const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(line); if (m) try { meta.cwd = JSON.parse(m[1]); } catch {} }
    if (line.startsWith('{"type":"ai-title"')) { try { meta.aiTitle = JSON.parse(line).aiTitle ?? meta.aiTitle; } catch {} }
    else if (line.startsWith('{"type":"custom-title"')) { try { meta.customTitle = JSON.parse(line).customTitle ?? meta.customTitle; } catch {} }
    else if (line.startsWith('{"type":"bridge-session"')) { try { meta.bridgeSessionId = JSON.parse(line).bridgeSessionId ?? meta.bridgeSessionId; } catch {} }
    else if (!meta.model && line.includes('"role":"assistant"')) { const m = /"model":"([^"]+)"/.exec(line); if (m) meta.model = m[1]; }
    else if (!meta.firstPrompt && line.includes('"type":"user"') && line.includes('"role":"user"')) {
      try {
        const c = JSON.parse(line)?.message?.content;
        const s = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ") : "";
        if (s && !s.startsWith("<")) meta.firstPrompt = s.slice(0, 120);
      } catch {}
    }
  }
  meta.title = meta.customTitle || meta.aiTitle;
  transcriptCache.set(path, { key, meta });
  return meta;
}

// ---------------------------------------------------------------- codex: rollouts

function codexDayDirs(): string[] {
  if (!existsSync(CODEX_SESSIONS)) return [];
  const out: string[] = [];
  for (const y of readdirSync(CODEX_SESSIONS)) for (const m of safeList(join(CODEX_SESSIONS, y))) for (const d of safeList(join(CODEX_SESSIONS, y, m))) out.push(join(CODEX_SESSIONS, y, m, d));
  return out.sort().reverse();
}
const safeList = (p: string) => { try { return readdirSync(p); } catch { return []; } };

export function codexRolloutPath(sessionId: string): string {
  for (const dir of codexDayDirs()) {
    for (const f of safeList(dir)) if (f.endsWith(`-${sessionId}.jsonl`)) return join(dir, f);
  }
  return "";
}

type CodexMeta = { cwd: string; model: string; firstPrompt: string; startedAt: number };
const codexCache = new Map<string, { key: string; meta: CodexMeta }>();

export function codexRolloutMeta(path: string): CodexMeta | null {
  if (!path || !existsSync(path)) return null;
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = codexCache.get(path);
  if (hit && hit.key === key) return hit.meta;
  const meta: CodexMeta = { cwd: "", model: "", firstPrompt: "", startedAt: 0 };
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.includes('"type":"session_meta"')) {
      try { const p = JSON.parse(line).payload; meta.cwd = p?.cwd ?? ""; meta.startedAt = Date.parse(p?.timestamp ?? "") || 0; } catch {}
    } else if (!meta.firstPrompt && line.includes('"role":"user"')) {
      try {
        const c = JSON.parse(line)?.payload?.content;
        const s = Array.isArray(c) ? c.filter((x: any) => x?.type === "input_text").map((x: any) => x.text).join(" ") : "";
        if (s && !isCodexContext(s)) meta.firstPrompt = s.slice(0, 120);
      } catch {}
    } else if (!meta.model) { const m = /"model":"([^"]+)"/.exec(line); if (m) meta.model = m[1]; }
  }
  codexCache.set(path, { key, meta });
  return meta;
}

/** User messages Codex adds itself: the environment, AGENTS.md and other instructions. Not what the person typed. */
const isCodexContext = (s: string) => /^\s*(<|# AGENTS\.md instructions)/.test(s);

// ---------------------------------------------------------------- codex: the thread index

export type CodexThread = {
  id: string; rollout_path: string; cwd: string; source: string; originator: string | null; thread_source: string | null;
  title: string; name: string | null; first_user_message: string; model: string | null; created_at_ms: number; updated_at_ms: number;
};

let codexDb: { db: Database | null; at: number } | null = null;
/**
 * The newest ~/.codex/state_<n>.sqlite, read-only. Not `immutable=1`: Codex keeps it in WAL mode, and an immutable
 * open skips the WAL, which is where the newest threads are (checked on 0.162.1: a day of threads missing).
 */
function codexState(): Database | null {
  if (codexDb && (codexDb.db || Date.now() - codexDb.at < 60_000)) return codexDb.db;
  let db: Database | null = null;
  try {
    const name = safeList(CODEX_HOME).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
    if (name) db = new Database(join(CODEX_HOME, name), { readonly: true });
  } catch { db = null; }
  codexDb = { db, at: Date.now() };
  return db;
}

const THREAD_COLS = "id, rollout_path, cwd, source, originator, thread_source, title, name, first_user_message, model, created_at_ms, updated_at_ms";

function codexQuery<T>(sql: string, ...params: any[]): T[] {
  const db = codexState();
  if (!db) return [];
  try { return db.query(sql).all(...params) as T[]; }
  catch { try { db.close(); } catch {} codexDb = { db: null, at: Date.now() }; return []; } // a schema we don't know: try again in a minute
}

/** Whether Codex's thread index can be read (an older Codex has none). */
export const codexIndexReadable = () => Boolean(codexState());

export function codexThread(id: string): CodexThread | null {
  return codexQuery<CodexThread>(`SELECT ${THREAD_COLS} FROM threads WHERE id = ?`, id)[0] ?? null;
}

/** Same folder, allowing for macOS's /private prefix (/tmp and /var are symlinks into it). */
const sameDir = (a: string, b: string) => a === b || a.replace(/^\/private(?=\/)/, "") === b.replace(/^\/private(?=\/)/, "");

/** A subagent's thread, which belongs to its parent's session. */
const isSubagent = (t: CodexThread) => t.thread_source === "subagent" || t.source.startsWith("{");

/**
 * The thread a codex we started at `startedAt` in `cwd` created: the TUI's (originator codex-tui; older versions
 * left originator empty with source cli) or `codex exec`'s (source exec). Threads other runs already claimed are
 * skipped; among the rest, one whose first message is our prompt wins, then the earliest. Null when the index has
 * none yet (or can't be read).
 */
export function findCodexThread(o: { startedAt: number; cwd: string; kind: "tui" | "exec"; exclude?: Set<string>; prompt?: string }): CodexThread | null {
  const rows = codexQuery<CodexThread>(`SELECT ${THREAD_COLS} FROM threads WHERE created_at_ms >= ? AND archived = 0 ORDER BY created_at_ms`, o.startedAt - 5000)
    .filter((t) => !isSubagent(t) && !o.exclude?.has(t.id) && (!o.cwd || sameDir(t.cwd, o.cwd)))
    .filter((t) => o.kind === "exec" ? t.source === "exec" : t.originator === "codex-tui" || (!t.originator && t.source === "cli"));
  const want = (o.prompt ?? "").trim().slice(0, 80);
  return (want && rows.find((t) => t.first_user_message.trim().startsWith(want))) || rows[0] || null;
}

/** Whether a codex resumed at `since` really reopened thread `id`: Codex bumps updated_at when the thread is used. */
export function codexThreadTouched(id: string, since: number): CodexThread | null {
  const t = codexThread(id);
  return t && t.updated_at_ms >= since - 2000 ? t : null;
}

/**
 * For a codex process lofiwave didn't start: the thread it's most likely on, from the index alone (the daemon holds
 * the files, so the process can't be asked). The newest thread in its folder used since it started.
 */
export function codexThreadNear(cwd: string, startedAt: number, kind: "tui" | "exec"): CodexThread | null {
  const rows = codexQuery<CodexThread>(`SELECT ${THREAD_COLS} FROM threads WHERE updated_at_ms >= ? AND archived = 0 ORDER BY updated_at_ms DESC LIMIT 50`, startedAt - 5000)
    .filter((t) => !isSubagent(t) && sameDir(t.cwd, cwd) && (kind === "exec" ? t.source === "exec" : t.source !== "exec"));
  return rows[0] ?? null;
}

/** Older Codex (no thread index): a codex TUI/exec started at `startedAt` in `cwd` writes its rollout within seconds: find it. */
export function discoverCodexSession(startedAt: number, cwd: string): { session_id: string; path: string } | null {
  for (const dir of codexDayDirs().slice(0, 2)) {
    for (const f of safeList(dir).sort().reverse()) {
      const m = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(f);
      if (!m) continue;
      const path = join(dir, f);
      if (statSync(path).mtimeMs < startedAt - 5000) continue;
      const meta = codexRolloutMeta(path);
      if (meta && meta.startedAt >= startedAt - 5000 && (!cwd || sameDir(meta.cwd, cwd))) return { session_id: m[1], path };
    }
  }
  return null;
}

// ---------------------------------------------------------------- unified

export function describeSession(agent: string, sessionId: string, hint: { cwd?: string; transcript_path?: string; model?: string; pid?: number | null } = {}): SessionInfo {
  const info: SessionInfo = { agent, session_id: sessionId, title: "", name: "", status: "", model: hint.model ?? "", cwd: hint.cwd ?? "", transcript_path: hint.transcript_path ?? "", web_url: "", resume_cmd: "", tmux: "" };
  if (agent === "claude") {
    const reg = claudeRegistry();
    const r = (hint.pid && reg.byPid.get(hint.pid)) || reg.bySession.get(sessionId);
    if (r) { info.name = r.name ?? ""; info.status = r.status ?? ""; info.cwd ||= r.cwd; info.web_url = claudeWebUrl(r.bridgeSessionId); info.tmux = r.tmux ?? ""; }
    if (!info.transcript_path) info.transcript_path = claudeTranscriptPath(sessionId, info.cwd);
    const m = claudeTranscriptMeta(info.transcript_path);
    if (m) { info.title = m.title || info.title; info.model ||= m.model; info.web_url ||= claudeWebUrl(m.bridgeSessionId); if (!info.title && !info.name) info.title = m.firstPrompt; }
    info.resume_cmd = `claude --resume ${sessionId}`;
  } else if (agent === "codex") {
    // The index has Codex's own short name for the thread and its first message; the rollout is the fallback.
    const t = codexThread(sessionId);
    if (t) { info.name = t.name ?? ""; info.cwd ||= t.cwd; info.model ||= t.model ?? ""; info.transcript_path ||= t.rollout_path; if (!isCodexContext(t.first_user_message)) info.title = t.first_user_message.slice(0, 120); }
    if (!info.transcript_path) info.transcript_path = codexRolloutPath(sessionId);
    const m = codexRolloutMeta(info.transcript_path);
    if (m) { info.cwd ||= m.cwd; info.model ||= m.model; info.title ||= m.firstPrompt; }
    info.resume_cmd = `codex resume ${sessionId}`;
  }
  return info;
}

/**
 * A session id pasted in by hand: which agent it belongs to and the folder it ran in (claude only finds a session
 * from that folder), from the transcript on disk. `agent` narrows the search; null when nothing on disk matches.
 */
export function locateSession(sessionId: string, agent?: string): SessionInfo | null {
  if (!agent || agent === "claude") {
    const path = claudeTranscriptPath(sessionId, "");
    if (path) return describeSession("claude", sessionId, { cwd: claudeTranscriptMeta(path)?.cwd ?? "", transcript_path: path });
  }
  if (!agent || agent === "codex") {
    const path = codexThread(sessionId)?.rollout_path || codexRolloutPath(sessionId);
    if (path) return describeSession("codex", sessionId, { transcript_path: path });
  }
  return null;
}

/** For the live process list: what we can tell about a running claude process without the console having started it. */
export function sessionForPid(pid: number): SessionInfo | null {
  const r = claudeRegistry().byPid.get(pid);
  if (!r) return null;
  return describeSession("claude", r.sessionId, { cwd: r.cwd, pid });
}

// ---------------------------------------------------------------- reading a conversation back

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string; at: string | null };

/** One line for a tool call: its name and the input that says what it did (a command, a file, a pattern). */
function toolLine(name: string, input: any): string {
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return `${name} ${input}`.slice(0, 300); } }
  const what = input?.command ?? input?.cmd ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.prompt ?? "";
  return `${name}${what ? " " + (Array.isArray(what) ? what.join(" ") : String(what)) : ""}`.slice(0, 300);
}

/**
 * The readable part of a Claude transcript or a codex rollout: what the user said, what the agent answered, and a line
 * per tool call. Thinking, tool output, hooks and bookkeeping are left out. Newest `limit` messages.
 */
export function transcriptMessages(path: string, limit = 500): ChatMessage[] {
  const out: ChatMessage[] = [];
  const push = (role: ChatMessage["role"], text: string, at: string | null) => { text = text.trim(); if (text) out.push({ role, text: text.slice(0, 20_000), at }); };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const at = d.timestamp ?? null;
    if (d.type === "user" || d.type === "assistant") {
      // claude: a message per line; skip sub-agents and the meta messages the CLI injects (command output, caveats).
      if (d.isSidechain || d.isMeta) continue;
      const c = d.message?.content;
      if (typeof c === "string") { if (!c.startsWith("<")) push(d.type, c, at); continue; }
      for (const part of Array.isArray(c) ? c : []) {
        if (part.type === "text" && !(d.type === "user" && part.text?.startsWith("<"))) push(d.type, part.text ?? "", at);
        else if (part.type === "tool_use") push("tool", toolLine(part.name, part.input), at);
      }
    } else if (d.type === "response_item") {
      // codex: the model's items; some user messages are context it injects (environment, AGENTS.md, instructions).
      const p = d.payload ?? {};
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const text = (p.content ?? []).map((x: any) => x.text ?? "").join("\n");
        if (!(p.role === "user" && isCodexContext(text))) push(p.role, text, at);
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        push("tool", toolLine(p.name ?? "shell", p.arguments ?? p.input ?? p.action), at);
      }
    }
  }
  return out.slice(-limit);
}
