/**
 * The chat view's server side: a read-only projection of a Claude Code session, kept live over a WebSocket.
 * The TUI in tmux stays the only process running the session; this only reads its files.
 *
 * A *feed* follows one source (a run of ours, or any session on this machine by id) and is shared by every browser
 * watching it. It works out which transcript is current (a /clear starts a new file), tails it, projects the
 * active chain into items, and sends each viewer whole-item upserts and removals.
 *
 * Wire protocol, server → client JSON text frames:
 *   {t:"hello", session_id, cwd, read_only, capabilities, status, waiting_for, items, floor, has_earlier}
 *   {t:"items", upsert: Item[], remove: string[]}
 *   {t:"status", status, waiting_for}
 * The client sends nothing. Older turns come from GET …/chat?before=<ordinal>, big payloads from GET …/chat/blob?ref=.
 */
import type { ServerWebSocket } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, type RunRow, type SessionRow } from "../db";
import { ApiError } from "../runner";
import { claudeRegistry, claudeTranscriptPath } from "../agents";
import { JsonlTail, readLineAt, type LineLoc } from "./tail";
import { activeChain, capabilities, extractBlob, ingest, project, type Item, type Rec } from "./claude";

/** How much of the conversation a viewer gets on connect; "Load earlier" fetches the rest. */
const WINDOW_TURNS = 30;
const WINDOW_ITEMS = 500;
/** A feed with no viewers stays warm this long, so flipping views or reloading is instant. */
const LINGER_MS = 60_000;

export type ChatData = { kind: "chat"; key: string; user: string };

// ---------------------------------------------------------------- sources

type Located = { path: string; sessionId: string; pid: number | null };
type Source = { key: string; readOnly: boolean; locate(): Located };

/** The run's current Claude session: the newest of what the session hook recorded and what the pid file says. */
function runSource(runId: number): Source {
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const meta = JSON.parse(run.meta || "{}");
  const rows = db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at").all(runId);
  if (meta.codex_session || rows.some((s) => s.agent === "codex") || /(^|\/)codex$/.test(typeTool(run.type_name)))
    throw new ApiError(400, "the chat view reads Claude Code sessions; Codex support comes later");
  return {
    key: `run:${runId}`,
    readOnly: true, // phase 1: nothing is typed from the chat view yet
    locate() {
      const cur = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId);
      const pid = cur?.status === "running" ? cur.pid : null;
      const candidates: Located[] = [];
      const last = db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE run_id = ? AND agent = 'claude' ORDER BY started_at DESC LIMIT 1").get(runId);
      if (last) candidates.push({ path: last.transcript_path || claudeTranscriptPath(last.session_id, last.cwd || cur?.cwd || ""), sessionId: last.session_id, pid });
      const reg = pid ? claudeRegistry().byPid.get(pid) : undefined;
      if (reg && reg.sessionId !== last?.session_id) candidates.push({ path: claudeTranscriptPath(reg.sessionId, reg.cwd), sessionId: reg.sessionId, pid });
      const mtime = (p: string) => { try { return p ? statSync(p).mtimeMs : -1; } catch { return -1; } };
      candidates.sort((a, b) => mtime(b.path) - mtime(a.path));
      return candidates[0] ?? { path: "", sessionId: "", pid };
    },
  };
}

const typeTool = (name: string) => db.query<{ command: string }, [string]>("SELECT command FROM process_types WHERE name = ?").get(name)?.command ?? "";

/** Any Claude session on this machine, by id (the Agents tab's sessions, which lofiwave didn't start). Read-only. */
function sessionSource(sid: string): Source {
  if (!/^[A-Za-z0-9_.-]+$/.test(sid) || sid.includes("..")) throw new ApiError(400, "session id has unexpected characters");
  const path = claudeTranscriptPath(sid, claudeRegistry().bySession.get(sid)?.cwd ?? "");
  if (!path) throw new ApiError(404, `no Claude transcript for session ${sid} on this machine`);
  return {
    key: `session:${sid}`,
    readOnly: true,
    locate: () => ({ path, sessionId: sid, pid: claudeRegistry().bySession.get(sid)?.pid ?? null }),
  };
}

export function chatSource(kind: "run" | "session", id: string): Source {
  return kind === "run" ? runSource(Number(id)) : sessionSource(id);
}

// ---------------------------------------------------------------- a transcript, followed

class Transcript {
  byUuid = new Map<string, Rec>();
  order: string[] = [];
  items: Item[] = [];
  cwd = "";
  private tail: JsonlTail;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly path: string, private onItems: () => void) {
    this.tail = new JsonlTail(path, (e, loc) => this.add(e, loc), () => this.schedule(), () => this.reset());
    this.tail.start();
    this.recompute();
  }

  close() { this.tail.close(); if (this.timer) clearTimeout(this.timer); }

  private add(e: any, loc: LineLoc) {
    const r = ingest(e, loc);
    if (!r) return;
    if (!this.byUuid.has(r.uuid)) this.order.push(r.uuid);
    this.byUuid.set(r.uuid, r);
    if (r.cwd) this.cwd = r.cwd;
  }

  private reset() { this.byUuid.clear(); this.order = []; }

  /** Entries land one block at a time, often in bursts: project once per burst. */
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.recompute(); this.onItems(); }, 80);
  }

  recompute() { this.items = project(activeChain(this.byUuid, this.order)); }

  loc(uuid: string): LineLoc | undefined { return this.byUuid.get(uuid)?.loc; }
}

// ---------------------------------------------------------------- feeds

type Status = { status: string; waiting_for: string };

class Feed {
  subs = new Set<ServerWebSocket<ChatData>>();
  transcript: Transcript | null = null;
  located: Located = { path: "", sessionId: "", pid: null };
  status: Status = { status: "", waiting_for: "" };
  /** What each item looked like when last sent, to send only what changed. */
  private sent = new Map<string, string>();
  private timer: ReturnType<typeof setInterval>;
  private ticks = 0;
  lastUsed = Date.now();

  constructor(readonly source: Source) {
    this.relocate();
    this.pollStatus();
    this.timer = setInterval(() => {
      this.ticks++;
      if (this.ticks % 2 === 0) this.relocate();
      this.pollStatus();
      if (!this.subs.size && Date.now() - this.lastUsed > LINGER_MS) this.close();
    }, 1000);
  }

  close() {
    clearInterval(this.timer);
    this.transcript?.close();
    feeds.delete(this.source.key);
  }

  /** Follow the current transcript; when it changes (/clear, a resume that forked), every viewer starts over. */
  private relocate() {
    let next: Located;
    try { next = this.source.locate(); } catch { return; }
    const changed = next.path !== this.located.path;
    this.located = next;
    if (!changed && this.transcript) return;
    this.transcript?.close();
    this.transcript = next.path ? new Transcript(next.path, () => this.broadcastItems()) : null;
    this.sent = new Map((this.transcript?.items ?? []).map((i) => [i.id, JSON.stringify(i)]));
    for (const ws of this.subs) this.hello(ws);
  }

  private pollStatus() {
    const reg = this.located.pid ? claudeRegistry().byPid.get(this.located.pid) : this.located.sessionId ? claudeRegistry().bySession.get(this.located.sessionId) : undefined;
    const next: Status = { status: reg?.status ?? "", waiting_for: (reg as any)?.waitingFor ?? "" };
    if (next.status === this.status.status && next.waiting_for === this.status.waiting_for) return;
    this.status = next;
    this.send({ t: "status", ...next });
  }

  private send(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of this.subs) if (ws.readyState === 1) ws.send(s);
  }

  private broadcastItems() {
    const items = this.transcript?.items ?? [];
    const upsert: Item[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.id);
      const s = JSON.stringify(it);
      if (this.sent.get(it.id) !== s) { upsert.push(it); this.sent.set(it.id, s); }
    }
    const remove = [...this.sent.keys()].filter((id) => !seen.has(id));
    for (const id of remove) this.sent.delete(id);
    if (upsert.length || remove.length) this.send({ t: "items", upsert, remove });
  }

  hello(ws: ServerWebSocket<ChatData>) {
    const items = this.transcript?.items ?? [];
    const { slice, floor, hasEarlier } = windowBefore(items, Infinity);
    ws.send(JSON.stringify({
      t: "hello", session_id: this.located.sessionId, cwd: this.transcript?.cwd ?? "", read_only: this.source.readOnly,
      capabilities, ...this.status, items: slice, floor, has_earlier: hasEarlier, waiting_for_file: !this.transcript || !existsSync(this.located.path),
    }));
  }

  earlier(before: number) {
    this.lastUsed = Date.now();
    const { slice, floor, hasEarlier } = windowBefore(this.transcript?.items ?? [], before);
    return { items: slice, floor, has_earlier: hasEarlier };
  }
}

/** The last WINDOW_TURNS turns (or WINDOW_ITEMS items) before ordinal `before`, cut on a turn boundary. */
function windowBefore(items: Item[], before: number): { slice: Item[]; floor: number; hasEarlier: boolean } {
  let end = items.length;
  while (end > 0 && items[end - 1].ordinal >= before) end--;
  let start = end, turns = 0, turn = "";
  while (start > 0) {
    const t = items[start - 1].turnId;
    if (t !== turn) { if (turns >= WINDOW_TURNS || end - start >= WINDOW_ITEMS) break; turns++; turn = t; }
    start--;
  }
  return { slice: items.slice(start, end), floor: items[start]?.ordinal ?? 0, hasEarlier: start > 0 };
}

const feeds = new Map<string, Feed>();

function feedFor(source: Source): Feed {
  let f = feeds.get(source.key);
  if (!f) { f = new Feed(source); feeds.set(source.key, f); }
  f.lastUsed = Date.now();
  return f;
}

// ---------------------------------------------------------------- socket

/** Validate before upgrading (errors go back as HTTP); the feed itself is made on open. */
export function chatFor(kind: "run" | "session", id: string, user: string): ChatData {
  return { kind: "chat", key: chatSource(kind, id).key, user };
}

export const chatSocket = {
  open(ws: ServerWebSocket<ChatData>) {
    const [kind, id] = splitKey(ws.data.key);
    let feed: Feed;
    try { feed = feedFor(chatSource(kind, id)); } catch (e: any) { ws.close(1011, String(e?.message ?? e).slice(0, 120)); return; }
    feed.subs.add(ws);
    feed.hello(ws);
  },
  message() { /* the client sends nothing yet */ },
  close(ws: ServerWebSocket<ChatData>) {
    const f = feeds.get(ws.data.key);
    if (f) { f.subs.delete(ws); f.lastUsed = Date.now(); }
  },
};

const splitKey = (key: string): ["run" | "session", string] => {
  const i = key.indexOf(":");
  return [key.slice(0, i) as "run" | "session", key.slice(i + 1)];
};

// ---------------------------------------------------------------- HTTP: earlier turns, blobs, subagents

export function chatEarlier(kind: "run" | "session", id: string, before: number) {
  const feed = feedFor(chatSource(kind, id));
  return { session_id: feed.located.sessionId, ...feed.earlier(before) };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A payload left in the transcript: `ref` is "<uuid>/<path>" from an item; `agent` points into a subagent's file. */
export function chatBlob(kind: "run" | "session", id: string, ref: string, agent: string): Response {
  const feed = feedFor(chatSource(kind, id));
  const [uuid, ...path] = ref.split("/");
  let file: string, loc: LineLoc | undefined;
  if (agent) {
    const sub = subagentTranscript(feed, agent);
    file = sub.path; loc = sub.locs.get(uuid);
  } else {
    file = feed.transcript?.path ?? ""; loc = feed.transcript?.loc(uuid);
  }
  if (!file || !loc) throw new ApiError(404, "no such payload in this session (it may have been rewound away)");
  const blob = extractBlob(readLineAt(file, loc), path);
  if (!blob) throw new ApiError(404, "payload not found");
  if (blob.image) {
    if (!IMAGE_TYPES.has(blob.image.mediaType)) throw new ApiError(415, `unsupported image type ${blob.image.mediaType}`);
    return new Response(Buffer.from(blob.image.data, "base64"), { headers: { "content-type": blob.image.mediaType, "cache-control": "private, max-age=3600" } });
  }
  return new Response(blob.text ?? "", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

const subCache = new Map<string, { key: string; items: Item[]; locs: Map<string, LineLoc>; path: string }>();
/** Subagent transcripts are small and finished (or nearly): read whole, cached by size and mtime. */
function subagentTranscript(feed: Feed, agentId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new ApiError(400, "agent id has unexpected characters");
  const main = feed.transcript?.path;
  if (!main) throw new ApiError(404, "no transcript yet");
  const dir = dirname(main), sid = feed.located.sessionId;
  const path = [join(dir, sid, "subagents", `agent-${agentId}.jsonl`), join(dir, `agent-${agentId}.jsonl`)].find((p) => existsSync(p));
  if (!path) throw new ApiError(404, `no transcript for subagent ${agentId}`);
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = subCache.get(path);
  if (hit && hit.key === key) return hit;
  if (st.size > 64 * 1024 * 1024) throw new ApiError(413, "subagent transcript is too big to show");
  const byUuid = new Map<string, Rec>(), order: string[] = [], locs = new Map<string, LineLoc>();
  const buf = readFileSync(path);
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl < 0) nl = buf.length;
    if (nl > start) {
      try {
        const e = JSON.parse(buf.toString("utf8", start, nl));
        // Subagent files mark every entry as a sidechain; inside their own file that's the main line.
        if (e && typeof e === "object") e.isSidechain = false;
        const loc = { offset: start, length: nl - start };
        const r = ingest(e, loc);
        if (r) { if (!byUuid.has(r.uuid)) order.push(r.uuid); byUuid.set(r.uuid, r); locs.set(r.uuid, loc); }
      } catch { /* partial or junk line */ }
    }
    start = nl + 1;
  }
  const out = { key, items: project(activeChain(byUuid, order)), locs, path };
  subCache.set(path, out);
  if (subCache.size > 50) subCache.delete(subCache.keys().next().value!);
  return out;
}

export function chatSubagent(kind: "run" | "session", id: string, agentId: string) {
  const sub = subagentTranscript(feedFor(chatSource(kind, id)), agentId);
  return { agent_id: agentId, items: sub.items };
}
