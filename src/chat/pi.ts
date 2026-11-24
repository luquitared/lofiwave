/**
 * pi (https://pi.dev) sessions in the chat view.
 *
 * pi writes ~/.pi/agent/sessions/--<cwd>--/<time>_<session id>.jsonl: a header line, then a tree of entries
 * (`id`/`parentId`) whose `message` entries hold user, assistant (text, thinking, toolCall blocks) and toolResult
 * messages. Rather than a second projector, `piToClaude` rewrites each line into the shape of a Claude Code
 * transcript line. `ingest`, `activeChain`, `project` and `extractBlob` in ./claude.ts then work unchanged: pi's
 * tools become their Claude equivalents (bash → Bash, edit → Edit with its diff, read → Read…).
 * The rewrite is a pure function of the line, so a blob is resolved by rewriting its line again.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hunk, Item } from "./claude";

export const piAgentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const sessionsDir = () => process.env.PI_CODING_AGENT_SESSION_DIR || join(piAgentDir(), "sessions");

/** The folder pi files a cwd's sessions under: the path without its leading separator, `/`, `\` and `:` as `-`. */
export const piSessionFolder = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** The session file for `sessionId`: in its cwd's folder when known, else in any folder. Newest wins. */
export function piSessionPath(sessionId: string, cwd = ""): string {
  if (!sessionId || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) return "";
  const root = sessionsDir();
  const suffix = `_${sessionId}.jsonl`;
  const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  const find = (dirs: string[]) => {
    let best = "", bestM = -1;
    for (const d of dirs) for (const f of ls(d)) {
      if (!f.endsWith(suffix)) continue;
      const p = join(d, f);
      const m = (() => { try { return statSync(p).mtimeMs; } catch { return -1; } })();
      if (m > bestM) { best = p; bestM = m; }
    }
    return best;
  };
  if (cwd) { const hit = find([join(root, piSessionFolder(cwd))]); if (hit) return hit; }
  return existsSync(root) ? find(ls(root).map((d) => join(root, d))) : "";
}

// ---------------------------------------------------------------- lines

const ts = (e: any, m?: any) => (typeof e.timestamp === "string" ? e.timestamp : typeof m?.timestamp === "number" ? new Date(m.timestamp).toISOString() : "");

/** pi content blocks (text, image) → Claude's. */
function blocks(c: any): any[] {
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  return c.flatMap((b: any): any[] => {
    if (b?.type === "text") return [{ type: "text", text: b.text ?? "" }];
    if (b?.type === "image" && typeof b.data === "string") return [{ type: "image", source: { type: "base64", media_type: b.mimeType ?? "image/png", data: b.data } }];
    return [];
  });
}
const textOf = (c: any) => blocks(c).filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** pi's built-in tools under their Claude names and argument names, so the chat view draws them the same way. */
export function piTool(name: string, a: any): { name: string; input: any } {
  a = a && typeof a === "object" ? a : {};
  switch (name) {
    case "bash": return { name: "Bash", input: { command: a.command ?? "", ...(a.timeout ? { timeout: a.timeout } : {}) } };
    case "read": return { name: "Read", input: { file_path: a.path ?? "", ...(a.offset ? { offset: a.offset } : {}), ...(a.limit ? { limit: a.limit } : {}) } };
    case "write": return { name: "Write", input: { file_path: a.path ?? "", content: a.content ?? "" } };
    case "edit": {
      const edits = Array.isArray(a.edits) ? a.edits : a.oldText !== undefined ? [a] : [];
      return { name: "Edit", input: { file_path: a.path ?? "", old_string: edits.map((x: any) => x.oldText ?? "").join("\n"), new_string: edits.map((x: any) => x.newText ?? "").join("\n") } };
    }
    case "grep": return { name: "Grep", input: { pattern: a.pattern ?? "", ...(a.path ? { path: a.path } : {}), ...(a.glob ? { glob: a.glob } : {}) } };
    case "find": return { name: "Glob", input: { pattern: a.pattern ?? "", ...(a.path ? { path: a.path } : {}) } };
    case "ls": return { name: "Glob", input: { pattern: "*", path: a.path || "." } };
    default: return { name, input: a };
  }
}

/** A unified patch ("@@ -a,b +c,d @@" hunks) → the chat view's hunks. */
export function parsePatch(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { cur = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] }; out.push(cur); continue; }
    if (cur && /^[ +-]/.test(line) && !/^(---|\+\+\+) /.test(line)) cur.lines.push(line);
  }
  return out;
}

/**
 * One pi session line → a Claude-transcript-shaped line (or null: the header). Every tree entry keeps its id and
 * parent, so the chain walks through entries the view doesn't show (model changes, labels…) as hidden ones.
 */
export function piToClaude(e: any): any {
  if (!e || typeof e !== "object" || typeof e.id !== "string") return null; // the session header has no parentId
  if (e.type === "session") return null;
  const base = { uuid: e.id, parentUuid: e.parentId ?? null, timestamp: ts(e, e.message) };
  const hidden = { ...base, type: "attachment", attachment: { type: `pi:${e.type}` } };
  if (e.type === "compaction") return { ...base, type: "system", subtype: "compact_boundary", content: "" };
  if (e.type === "branch_summary" && typeof e.summary === "string") return { ...base, type: "system", subtype: "informational", content: `Branch summary: ${e.summary}` };
  if (e.type === "custom_message" && e.display !== false && e.content !== undefined) return { ...base, type: "system", subtype: "informational", content: textOf(e.content) };
  if (e.type !== "message" || !e.message) return hidden;
  const m = e.message;
  switch (m.role) {
    case "user":
      return { ...base, type: "user", message: { role: "user", content: blocks(m.content) } };
    case "assistant": {
      const content: any[] = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "text" && b.text) content.push({ type: "text", text: b.text });
        else if (b?.type === "thinking" && b.thinking && !b.redacted) content.push({ type: "thinking", thinking: b.thinking });
        else if (b?.type === "toolCall") content.push({ type: "tool_use", id: b.id, ...piTool(b.name, b.arguments) });
      }
      if (m.stopReason === "error") return { ...base, type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: [...content, { type: "text", text: `API Error: ${m.errorMessage || "the request failed"}` }] } };
      if (m.stopReason === "aborted" && !content.length) return { ...base, type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
      return { ...base, type: "assistant", message: { role: "assistant", model: m.model, content } };
    }
    case "toolResult": {
      const parts = blocks(m.content);
      const text = textOf(m.content);
      const d = m.details && typeof m.details === "object" ? m.details : {};
      let tur: any = undefined;
      if (m.toolName === "bash") tur = { stdout: text, stderr: "" };
      else if (m.toolName === "edit" && typeof d.patch === "string") tur = { filePath: "", structuredPatch: parsePatch(d.patch) };
      else if (m.toolName === "read" && !parts.some((p) => p.type === "image")) tur = { content: text };
      return {
        ...base, type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, is_error: Boolean(m.isError), content: parts }] },
        ...(tur ? { toolUseResult: tur } : {}),
      };
    }
    case "compactionSummary":
      return { ...base, type: "user", isCompactSummary: true, message: { role: "user", content: m.summary ?? textOf(m.content) } };
    case "branchSummary":
      return { ...base, type: "system", subtype: "informational", content: `Branch summary: ${m.summary ?? ""}` };
    case "bashExecution": {
      // A command typed with `!` in pi's editor: shown like Claude's `!` shell commands.
      const out = [m.output ?? "", m.exitCode ? `Exit code ${m.exitCode}` : ""].filter(Boolean).join("\n");
      return { ...base, type: "system", subtype: "informational", content: `$ ${m.command ?? ""}${out ? `\n${out}` : ""}` };
    }
    case "custom":
      return m.display === false ? hidden : { ...base, type: "system", subtype: "informational", content: textOf(m.content) };
    default:
      return hidden; // system (prompt and tool loadout) and roles we don't know yet
  }
}

/**
 * Whether pi is working, from what the conversation ends on: it's idle after an answer, an error or an
 * interrupt, and working after a prompt or a tool call (whose result, or the next step, is still to come).
 */
export function piStatus(items: Item[], alive: boolean): "busy" | "idle" | "" {
  if (!alive) return "";
  const last = items.at(-1);
  if (!last) return "idle";
  if (last.kind === "assistant" || last.kind === "event" || last.kind === "thinking") return last.kind === "thinking" ? "busy" : "idle";
  return "busy";
}

/** A session's first prompt, model and name, from the start of its file (for the Sessions list). */
export function piSessionMeta(path: string): { firstPrompt: string; model: string; name: string } | null {
  let head = "";
  try {
    const fd = openSync(path, "r");
    try { const buf = Buffer.alloc(256 * 1024); head = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)); } finally { closeSync(fd); }
  } catch { return null; }
  const out = { firstPrompt: "", model: "", name: "" };
  for (const line of head.split("\n")) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e?.type === "message" ? e.message : null;
    if (m?.role === "user" && !out.firstPrompt) out.firstPrompt = textOf(m.content).slice(0, 120);
    if (m?.role === "assistant" && !out.model && m.model) out.model = String(m.model);
    if (e?.type === "model_change" && !out.model && e.modelId) out.model = String(e.modelId);
    if (e?.type === "session_info" && typeof e.name === "string") out.name = e.name;
  }
  return out;
}
