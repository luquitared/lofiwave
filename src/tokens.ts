/**
 * Token usage from Claude's transcripts, for Advanced → Stats (src/stats.ts).
 *
 * Every Claude session on this machine writes ~/.claude/projects/<slug>/<session>.jsonl, and its subagents write
 * <session>/subagents/agent-*.jsonl. Each API call is an `assistant` line with `message.usage`; a call written as
 * several lines (one per content block) repeats its id, so calls are keyed by message id. Assistant lines don't say
 * which prompt they answer: the `promptId` of the user line before them does (subagent lines carry the parent's).
 *
 * Files are read incrementally (token_files keeps the offset), so after the first pass only new lines are parsed.
 * The first pass skips transcripts untouched for BACKFILL_DAYS.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./db";

const BACKFILL_DAYS = 90;
const CHUNK = 8 * 1024 * 1024;
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

type FileState = { path: string; offset: number; prompt_id: string; cwd: string };

/** Every transcript: [path, session id]. */
function transcripts(): [string, string][] {
  const root = projectsDir(), out: [string, string][] = [];
  if (!existsSync(root)) return out;
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.endsWith(".jsonl")) { out.push([join(dir, n), n.slice(0, -6)]); continue; }
      const sub = join(dir, n, "subagents");
      if (!existsSync(sub)) continue;
      try { for (const s of readdirSync(sub)) if (s.endsWith(".jsonl")) out.push([join(sub, s), n]); } catch { /* gone */ }
    }
  }
  return out;
}

const PROMPT_RE = /"promptId":"([^"]+)"/;
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const upsert = () => db.query(
  `INSERT INTO token_calls (msg_id, session_id, prompt_id, cwd, model, at, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(msg_id) DO UPDATE SET input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write,
     prompt_id = CASE WHEN token_calls.prompt_id = '' THEN excluded.prompt_id ELSE token_calls.prompt_id END`);

/** Read one transcript from where the last pass stopped. Returns whether it read anything. */
export async function indexFile(path: string, sessionId: string): Promise<boolean> {
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  const st = db.query<FileState, [string]>("SELECT * FROM token_files WHERE path = ?").get(path) ?? { path, offset: 0, prompt_id: "", cwd: "" };
  if (size < st.offset) Object.assign(st, { offset: 0, prompt_id: "", cwd: "" }); // rewritten
  if (size === st.offset) return false;
  const main = !path.includes("/subagents/"); // a subagent's titles aren't its session's
  const fd = openSync(path, "r");
  const ins = upsert();
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, size - st.offset));
    while (st.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - st.offset), st.offset);
      if (n <= 0) break;
      const text = buf.toString("utf8", 0, n);
      const end = text.lastIndexOf("\n");
      if (end < 0) {
        if (n < buf.length) break; // a line still being written
        st.offset += n; continue;   // one line longer than a chunk (a huge tool result): skip it
      }
      db.transaction(() => {
        for (const line of text.slice(0, end).split("\n")) {
          if (main && (line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"'))) {
            try {
              const d = JSON.parse(line), custom = d.type === "custom-title";
              const title = String((custom ? d.customTitle : d.aiTitle) ?? "").slice(0, 200);
              if (title) db.query(`INSERT INTO token_sessions (session_id, ${custom ? "custom_title" : "ai_title"}) VALUES (?, ?)
                ON CONFLICT(session_id) DO UPDATE SET ${custom ? "custom_title" : "ai_title"} = excluded.${custom ? "custom_title" : "ai_title"}`).run(sessionId, title);
            } catch { /* not ours */ }
          } else if (line.includes('"type":"user"')) {
            const p = PROMPT_RE.exec(line)?.[1];
            if (p) st.prompt_id = p;
            if (!st.cwd) { const c = CWD_RE.exec(line)?.[1]; if (c) { try { st.cwd = JSON.parse(`"${c}"`); } catch { /* odd escape */ } } }
          } else if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
            let d: any;
            try { d = JSON.parse(line); } catch { continue; }
            const m = d.message, u = m?.usage;
            if (!m?.id || !u || m.model === "<synthetic>") continue;
            if (!st.cwd && typeof d.cwd === "string") st.cwd = d.cwd;
            const at = Date.parse(d.timestamp) || Date.now();
            ins.run(m.id, sessionId, st.prompt_id, st.cwd, String(m.model ?? ""), at,
              num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens));
          }
        }
      })();
      st.offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
      if (st.offset < size) await Bun.sleep(0); // a big file: let requests through between chunks
    }
  } finally { closeSync(fd); }
  db.query("INSERT OR REPLACE INTO token_files (path, offset, prompt_id, cwd) VALUES (?, ?, ?, ?)").run(st.path, st.offset, st.prompt_id, st.cwd);
  return true;
}

let running: Promise<void> | null = null, lastPass = 0;

/** One pass over every transcript; files untouched since BACKFILL_DAYS are skipped until they change. */
export function indexTokens(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const cutoff = Date.now() - BACKFILL_DAYS * 86_400_000;
    const known = new Set(db.query<{ path: string }, []>("SELECT path FROM token_files").all().map((r) => r.path));
    for (const [path, sid] of transcripts()) {
      try {
        if (!known.has(path) && statSync(path).mtimeMs < cutoff) continue;
        if (await indexFile(path, sid)) await Bun.sleep(0); // let requests through between files
      } catch (e) { console.error("[tokens]", path, e); }
    }
    lastPass = Date.now();
  })().finally(() => { running = null; });
  return running;
}

/** Fresh enough for a stats request: start a pass if the last is over 15 s old, and wait for it up to `ms`. */
export async function tokensFresh(ms = 3000): Promise<void> {
  if (!running && Date.now() - lastPass < 15_000) return;
  await Promise.race([indexTokens(), Bun.sleep(ms)]);
}

export function startTokenIndex(everyMs = 60_000): void {
  setTimeout(() => indexTokens().catch((e) => console.error("[tokens]", e)), 5_000);
  setInterval(() => indexTokens().catch((e) => console.error("[tokens]", e)), everyMs);
}
