/**
 * Claude Code transcripts → the chat view's items (see docs/rendered-view.md, "The normalized model").
 *
 * `ingest` turns one transcript line into a compact record: big payloads (images, long outputs, whole files) are
 * left in the file and only located, so a long session doesn't sit in memory twice. `project` walks the active
 * chain of records and emits items. The transcript is a tree (rewind and edit branch from old parents), so the
 * visible conversation is the chain from the newest entry back to the root, never file order.
 */
import type { LineLoc } from "./tail";

// ---------------------------------------------------------------- the model (shared with the browser and, later, Codex)

export type Omitted<T> = T | { omitted: true; bytes: number; preview: string; blob: string };
export type ImageRef = { blob: string; mediaType: string };
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

export type Item = {
  id: string; turnId: string; ordinal: number; parentId?: string;
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted";
  native: { agent: "claude" | "codex"; ref: string };
  startedAt?: number; completedAt?: number;
} & (
  | { kind: "user"; text: string; images: ImageRef[]; command?: string; output?: Omitted<string>; notification?: boolean; turnDurationMs?: number }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "thinking"; text: string; durationMs?: number }
  | { kind: "command"; label: string; command: string; output?: Omitted<string>; exitCode?: number; background?: boolean }
  | { kind: "file_change"; path: string; op: "edit" | "write" | "delete"; added: number; removed: number; patch?: Omitted<Hunk[]> }
  | { kind: "read" | "search" | "web"; label: string; detail?: Omitted<string>; images?: ImageRef[] }
  | { kind: "todo"; steps: { text: string; status: string }[] }
  | { kind: "plan"; markdown: string; decision?: "approved" | "rejected" }
  | { kind: "subagent"; label: string; childTurnId: string; agentType?: string; prompt?: Omitted<string>; result?: Omitted<string> }
  | { kind: "tool"; name: string; input: unknown; output?: Omitted<unknown>; images?: ImageRef[] }
  | { kind: "event"; event: "compact" | "clear" | "interrupt" | "error" | "info" | "raw"; text: string; detail?: Omitted<string> }
);

export const capabilities = { streaming: false, approvals: false, images: true, interrupt: false, composer: false };

/** Outputs longer than this arrive as `omitted` with a preview, and are fetched when a row is expanded. */
const INLINE = 8 * 1024;
const PREVIEW = 2 * 1024;
/** Diffs bigger than this (as JSON) are fetched on demand too. */
const INLINE_PATCH = 48 * 1024;

// ---------------------------------------------------------------- records

/** A blob locator: "<entry uuid>/<path into the parsed line>", resolved by `extractBlob`. */
const blobRef = (uuid: string, ...path: (string | number)[]) => [uuid, ...path].join("/");

function omit(text: string, uuid: string, ...path: (string | number)[]): Omitted<string> {
  if (text.length <= INLINE) return text;
  return { omitted: true, bytes: Buffer.byteLength(text), preview: text.slice(0, PREVIEW), blob: blobRef(uuid, ...path) };
}

type ToolResult = {
  id: string; isError: boolean; text: Omitted<string>; images: ImageRef[];
  tur: any; // the compacted toolUseResult
};

export type Rec = {
  uuid: string; parent: string | null; logicalParent?: string; ts: number; loc: LineLoc;
  type: string; subtype?: string;
  hidden?: boolean;
  // user
  text?: string; images?: ImageRef[]; results?: ToolResult[]; compactSummary?: boolean; notification?: boolean;
  // assistant
  blocks?: ({ type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; input: any })[];
  thinkingMs?: number; apiError?: boolean;
  // system
  content?: string; durationMs?: number;
  cwd?: string;
};

const textOf = (c: any): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";

/** Shorten every long string in a tool's input (a Write's file body, say) so the record stays small. */
function shrinkInput(v: any, depth = 0): any {
  if (typeof v === "string") return v.length > INLINE ? v.slice(0, PREVIEW) + `\n… (${v.length - PREVIEW} more characters)` : v;
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => shrinkInput(x, depth + 1));
  const out: any = {};
  for (const [k, x] of Object.entries(v)) out[k] = shrinkInput(x, depth + 1);
  return out;
}

function compactTur(t: any, uuid: string, i: number): any {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out: any = {};
  if (typeof t.stdout === "string") out.stdout = omit(t.stdout, uuid, "tur", "stdout");
  if (typeof t.stderr === "string" && t.stderr) out.stderr = omit(t.stderr, uuid, "tur", "stderr");
  for (const k of ["interrupted", "returnCodeInterpretation", "backgroundTaskId", "type", "filePath", "agentId", "status", "agentType", "isAsync", "totalDurationMs", "answers"]) if (k in t) out[k] = t[k];
  if (Array.isArray(t.structuredPatch)) {
    const size = JSON.stringify(t.structuredPatch).length;
    out.patch = size <= INLINE_PATCH ? t.structuredPatch : { omitted: true, bytes: size, preview: "", blob: blobRef(uuid, "tur", "patch") };
    out.added = 0; out.removed = 0;
    for (const h of t.structuredPatch) for (const l of h.lines ?? []) { if (l[0] === "+") out.added++; else if (l[0] === "-") out.removed++; }
  }
  if (t.type === "create" && typeof t.content === "string" && !t.structuredPatch?.length) {
    // A new file: the whole body is the diff.
    const lines = t.content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    out.added = lines.length; out.removed = 0;
    out.patch = t.content.length <= INLINE_PATCH
      ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => "+" + l) }]
      : { omitted: true, bytes: t.content.length, preview: "", blob: blobRef(uuid, "tur", "create") };
  }
  if (t.file && typeof t.file === "object") out.file = { filePath: t.file.filePath, numLines: t.file.numLines, startLine: t.file.startLine, totalLines: t.file.totalLines };
  if (typeof t.content === "string" && t.type !== "create" && !("structuredPatch" in t)) out.content = omit(t.content, uuid, "tur", "content");
  return out;
}

function imagesIn(blocks: any[], uuid: string, ...path: (string | number)[]): ImageRef[] {
  const out: ImageRef[] = [];
  blocks.forEach((b, j) => {
    if (b?.type === "image" && b.source?.type === "base64") out.push({ blob: blobRef(uuid, ...path, j), mediaType: b.source.media_type ?? "image/png" });
  });
  return out;
}

/** One transcript line → a record, or null for lines that aren't part of the conversation (titles, snapshots…). */
export function ingest(e: any, loc: LineLoc): Rec | null {
  if (!e || typeof e !== "object" || typeof e.uuid !== "string") return null;
  if (e.isSidechain) return null; // older versions kept subagent turns in the main file
  const rec: Rec = { uuid: e.uuid, parent: e.parentUuid ?? null, ts: Date.parse(e.timestamp ?? "") || 0, loc, type: e.type };
  if (e.logicalParentUuid) rec.logicalParent = e.logicalParentUuid;
  if (typeof e.cwd === "string") rec.cwd = e.cwd;
  if (e.type === "user") {
    const c = e.message?.content;
    if (e.isMeta) { rec.hidden = true; return rec; }
    if (e.isCompactSummary) { rec.compactSummary = true; rec.text = textOf(c); return rec; }
    if (Array.isArray(c)) {
      const results: ToolResult[] = [];
      c.forEach((b: any, i: number) => {
        if (b?.type !== "tool_result") return;
        const parts = Array.isArray(b.content) ? b.content : [];
        results.push({
          id: b.tool_use_id, isError: Boolean(b.is_error),
          text: omit(typeof b.content === "string" ? b.content : textOf(parts), e.uuid, "result", i),
          images: imagesIn(parts, e.uuid, "img", i),
          tur: compactTur(e.toolUseResult, e.uuid, i),
        });
      });
      if (results.length) rec.results = results;
      rec.images = imagesIn(c, e.uuid, "img");
    }
    rec.text = textOf(c);
    if (e.origin?.kind === "task-notification" || /^<task-notification>/.test(rec.text)) rec.notification = true;
    return rec;
  }
  if (e.type === "assistant") {
    const c = Array.isArray(e.message?.content) ? e.message.content : [];
    rec.blocks = [];
    for (const b of c) {
      if (b?.type === "text") rec.blocks.push({ type: "text", text: b.text ?? "" });
      else if (b?.type === "thinking" || b?.type === "redacted_thinking") rec.blocks.push({ type: "thinking", text: b.thinking ?? "" });
      else if (b?.type === "tool_use" || b?.type === "server_tool_use") rec.blocks.push({ type: "tool_use", id: b.id, name: b.name, input: shrinkInput(b.input) });
    }
    if (e.thinkingDurationMs) rec.thinkingMs = e.thinkingDurationMs;
    if (e.isApiErrorMessage) rec.apiError = true;
    return rec;
  }
  if (e.type === "system") {
    rec.subtype = e.subtype;
    rec.content = typeof e.content === "string" ? e.content : "";
    if (typeof e.durationMs === "number") rec.durationMs = e.durationMs;
    return rec;
  }
  if (e.type === "attachment") { rec.hidden = true; return rec; } // context the model sees (hooks, reminders): not conversation
  return rec; // a type we don't know yet: a quiet raw row, never an error
}

/** Resolve a blob locator against the parsed line it points into. Returns base64 image data or text. */
export function extractBlob(e: any, path: string[]): { image?: { data: string; mediaType: string }; text?: string } | null {
  const c = e?.message?.content;
  const [what, a, b] = path;
  if (what === "img") {
    const blocks = b === undefined ? c : c?.[Number(a)]?.content;
    const img = Array.isArray(blocks) ? blocks[Number(b ?? a)] : null;
    if (img?.type === "image" && img.source?.type === "base64") return { image: { data: img.source.data, mediaType: img.source.media_type } };
    return null;
  }
  if (what === "result") {
    const r = c?.[Number(a)];
    return r ? { text: typeof r.content === "string" ? r.content : textOf(r.content) } : null;
  }
  if (what === "tur") {
    const t = e?.toolUseResult;
    if (!t) return null;
    if (a === "patch") return { text: JSON.stringify(t.structuredPatch ?? []) };
    if (a === "create") {
      const lines = String(t.content ?? "").split("\n");
      if (lines.at(-1) === "") lines.pop();
      return { text: JSON.stringify([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => "+" + l) }]) };
    }
    if (a === "stdout" || a === "stderr" || a === "content") return typeof t[a] === "string" ? { text: t[a] } : null;
  }
  if (what === "text") return { text: textOf(c) };
  return null;
}

// ---------------------------------------------------------------- the active chain

/** The visible conversation: walk back from the newest entry. A compact boundary links on through `logicalParent`. */
export function activeChain(byUuid: Map<string, Rec>, order: string[]): Rec[] {
  let leaf: Rec | undefined;
  for (let i = order.length - 1; i >= 0; i--) {
    const r = byUuid.get(order[i]);
    if (r && (r.type === "user" || r.type === "assistant" || r.type === "system")) { leaf = r; break; }
  }
  const chain: Rec[] = [];
  const seen = new Set<string>();
  for (let r = leaf; r && !seen.has(r.uuid);) {
    seen.add(r.uuid);
    chain.push(r);
    const next = r.parent ?? r.logicalParent;
    r = next ? byUuid.get(next) : undefined;
  }
  return chain.reverse();
}

// ---------------------------------------------------------------- projection

const tag = (s: string, name: string) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s); return m ? m[1] : null; };
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const isInterruptText = (s: string) => /^\[Request interrupted by user/.test(s.trim());
const firstLine = (s: string) => (s || "").split("\n").find((l) => l.trim())?.trim() ?? "";

const asText = (o: Omitted<string> | undefined): string => (o === undefined ? "" : typeof o === "string" ? o : o.preview);

/** How a tool call becomes an item, before its result is known. */
function toolItem(b: { id: string; name: string; input: any }): any {
  const inp = b.input ?? {};
  const name = b.name;
  if (name === "Bash" || name === "BashOutput") return { kind: "command", label: inp.description || firstLine(inp.command) || name, command: inp.command ?? "", background: Boolean(inp.run_in_background) };
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
    let added = 0, removed = 0;
    if (name === "Edit") { removed = String(inp.old_string ?? "").split("\n").length; added = String(inp.new_string ?? "").split("\n").length; }
    return { kind: "file_change", path: inp.file_path || inp.notebook_path || "", op: name === "Write" ? "write" : "edit", added, removed };
  }
  if (name === "Read") return { kind: "read", label: inp.file_path || "" };
  if (name === "Grep") return { kind: "search", label: `"${inp.pattern ?? ""}"${inp.path ? ` in ${inp.path}` : ""}${inp.glob ? ` (${inp.glob})` : ""}` };
  if (name === "Glob") return { kind: "search", label: `${inp.pattern ?? ""}${inp.path ? ` in ${inp.path}` : ""}` };
  if (name === "WebFetch") return { kind: "web", label: inp.url ?? "" };
  if (name === "WebSearch") return { kind: "web", label: `"${inp.query ?? ""}"` };
  if (name === "TodoWrite") return { kind: "todo", steps: (inp.todos ?? []).map((t: any) => ({ text: t.content ?? t.activeForm ?? "", status: t.status ?? "pending" })) };
  if (name === "TaskCreate") return { kind: "todo", steps: [{ text: inp.subject ?? inp.description ?? "", status: "pending" }] };
  if (name === "TaskUpdate") return { kind: "todo", steps: [{ text: inp.subject ?? `task ${inp.taskId ?? ""}`, status: inp.status ?? "" }] };
  if (name === "Task" || name === "Agent") return { kind: "subagent", label: inp.description || "Subagent", childTurnId: "", agentType: inp.subagent_type ?? "", prompt: inp.prompt ?? "" };
  if (name === "ExitPlanMode") return { kind: "plan", markdown: inp.plan ?? "" };
  return { kind: "tool", name, input: inp };
}

/** Fill a tool item in from its result. */
function applyResult(item: any, r: ToolResult) {
  const text = asText(r.text);
  const t = r.tur ?? {};
  item.completedAt = item.completedAt ?? 0;
  if (r.isError) item.status = isInterruptText(text) || /doesn't want to proceed|was rejected/.test(text) ? "interrupted" : "failed";
  else item.status = "completed";
  switch (item.kind) {
    case "command": {
      const out = [asText(t.stdout), asText(t.stderr)].filter(Boolean).join("\n");
      const big = (typeof t.stdout === "object" && t.stdout) || (typeof t.stderr === "object" && t.stderr) || (typeof r.text === "object" && r.text);
      item.output = t.stdout !== undefined ? (big ? { ...big, preview: out.slice(0, PREVIEW) } : out) : r.text;
      const m = /^Exit code (\d+)/.exec(text);
      if (m) item.exitCode = Number(m[1]);
      else if (!r.isError) item.exitCode = 0;
      if (t.interrupted) item.status = "interrupted";
      if (t.backgroundTaskId) item.background = true;
      break;
    }
    case "file_change":
      if (t.added !== undefined) { item.added = t.added; item.removed = t.removed; }
      if (t.patch) item.patch = t.patch;
      if (t.type === "create") item.op = "write";
      else if (t.type === "update" && item.op === "write") item.op = "edit";
      if (r.isError) item.error = text.slice(0, 2000);
      break;
    case "read": case "search": case "web":
      item.detail = t.content ?? r.text;
      if (t.file?.numLines) item.label += ` · ${t.file.numLines} lines`;
      if (r.images.length) item.images = r.images;
      break;
    case "subagent":
      item.childTurnId = t.agentId ?? "";
      item.result = r.text;
      if (t.isAsync && t.status === "async_launched") item.status = "running";
      break;
    case "plan":
      item.decision = r.isError ? "rejected" : "approved";
      if (r.isError) item.status = "completed";
      break;
    case "todo":
      break;
    default:
      item.output = r.text;
      if (t.answers) item.answers = t.answers;
      if (r.images.length) item.images = r.images;
  }
}

/** The items for a chain, in order. Pure: the same chain always gives the same items. */
export function project(chain: Rec[]): Item[] {
  const items: any[] = [];
  const tools = new Map<string, any>();
  let turnId = "start", head: any = null, ord = 0, lastBash: any = null;
  const push = (it: any) => { it.ordinal = ord++; it.turnId = turnId; items.push(it); return it; };
  const native = (r: Rec) => ({ agent: "claude" as const, ref: r.uuid });
  const newTurn = (r: Rec) => {
    // Calls left without a result when the next prompt arrives never finished.
    for (const t of tools.values()) if (t.status === "running" && t.kind !== "subagent") t.status = "interrupted";
    turnId = r.uuid;
  };

  for (const r of chain) {
    if (r.hidden) continue;
    if (r.type === "user") {
      if (r.compactSummary) {
        push({ id: r.uuid, kind: "event", event: "compact", text: "Conversation compacted", detail: r.text, status: "completed", native: native(r), startedAt: r.ts });
        continue;
      }
      if (r.results?.length) {
        for (const res of r.results) {
          const it = tools.get(res.id);
          if (it) { applyResult(it, res); it.completedAt = r.ts; }
        }
        continue;
      }
      const raw = r.text ?? "";
      if (isInterruptText(raw)) {
        for (const t of tools.values()) if (t.status === "running" && t.turnId === turnId) t.status = "interrupted";
        push({ id: r.uuid, kind: "event", event: "interrupt", text: "Interrupted", status: "completed", native: native(r), startedAt: r.ts });
        continue;
      }
      const stdout = tag(raw, "local-command-stdout") ?? tag(raw, "local-command-stderr");
      if (stdout !== null) {
        push({ id: r.uuid, kind: "event", event: "info", text: stripAnsi(stdout).trim(), status: "completed", native: native(r), startedAt: r.ts });
        continue;
      }
      const bashOut = tag(raw, "bash-stdout"), bashErr = tag(raw, "bash-stderr");
      if (bashOut !== null || bashErr !== null) {
        if (lastBash) { lastBash.output = stripAnsi([bashOut, bashErr].filter(Boolean).join("\n")); lastBash.status = bashErr ? "failed" : "completed"; }
        continue;
      }
      if (r.notification) {
        // A background task (async subagent, background shell) finished: settle the call that started it.
        const t = tools.get((tag(raw, "tool-use-id") ?? "").trim());
        const st = (tag(raw, "status") ?? "").trim();
        if (t && t.status === "running") t.status = /fail|error|kill/.test(st) ? "failed" : "completed";
      }
      newTurn(r);
      const cmd = tag(raw, "command-name");
      const bash = tag(raw, "bash-input");
      let text = stripReminders(raw), command: string | undefined;
      if (cmd !== null) { command = `${cmd.trim()}${(tag(raw, "command-args") ?? "").trim() ? " " + tag(raw, "command-args")!.trim() : ""}`; text = ""; }
      else if (bash !== null) { command = `!${bash.trim()}`; text = ""; }
      let notification = false;
      if (r.notification) {
        notification = true;
        const summary = tag(raw, "summary") ?? tag(raw, "status");
        text = summary ? stripReminders(summary) : "Background task update";
      }
      head = push({ id: r.uuid, kind: "user", text, images: r.images ?? [], command, notification, status: "completed", native: native(r), startedAt: r.ts });
      lastBash = bash !== null ? head : null;
      if (lastBash) lastBash.status = "running";
      continue;
    }
    if (r.type === "assistant") {
      (r.blocks ?? []).forEach((b, i) => {
        if (b.type === "text") {
          if (!b.text.trim()) return;
          push({ id: `${r.uuid}:${i}`, kind: r.apiError ? "event" : "assistant", ...(r.apiError ? { event: "error" } : {}), text: b.text, status: "completed", native: native(r), startedAt: r.ts });
        } else if (b.type === "thinking") {
          push({ id: `${r.uuid}:${i}`, kind: "thinking", text: b.text, durationMs: r.thinkingMs, status: "completed", native: native(r), startedAt: r.ts });
        } else {
          const it = push({ id: b.id, ...toolItem(b), status: "running", native: native(r), startedAt: r.ts });
          tools.set(b.id, it);
        }
      });
      continue;
    }
    if (r.type === "system") {
      if (r.subtype === "turn_duration") { if (head) head.turnDurationMs = r.durationMs; continue; }
      if (r.subtype === "compact_boundary") { push({ id: r.uuid, kind: "event", event: "compact", text: "Conversation compacted", status: "completed", native: native(r), startedAt: r.ts }); continue; }
      if (r.subtype === "local_command") { push({ id: r.uuid, kind: "event", event: "info", text: stripAnsi(tag(r.content ?? "", "local-command-stdout") ?? tag(r.content ?? "", "local-command-stderr") ?? r.content ?? "").trim(), status: "completed", native: native(r), startedAt: r.ts }); continue; }
      if (r.subtype === "api_error") { push({ id: r.uuid, kind: "event", event: "error", text: r.content || "API error", status: "completed", native: native(r), startedAt: r.ts }); continue; }
      if (r.subtype === "informational" && r.content) { push({ id: r.uuid, kind: "event", event: "info", text: r.content, status: "completed", native: native(r), startedAt: r.ts }); continue; }
      continue; // bridge status, away summaries, and the like: not conversation
    }
    push({ id: r.uuid, kind: "event", event: "raw", text: r.type, status: "completed", native: native(r), startedAt: r.ts });
  }
  return items as Item[];
}
