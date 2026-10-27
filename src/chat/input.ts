/**
 * The chat view's composer: it types into the run's Claude TUI through tmux, the same as someone at the
 * terminal would. Nothing here talks to Claude any other way (see docs/rendered-view.md, "Input").
 *
 * - Text goes in as one bracketed paste (`paste-buffer -p`), so newlines don't submit, then Enter.
 * - Images go in first, each as its own pasted path: the TUI turns a pasted image path into `[Image #N]`.
 *   Other files go in as `@/abs/path` references on the first line.
 * - A message sent while Claude works is queued by the TUI itself, and lands in the transcript as a
 *   `queued_command` attachment once it's delivered.
 * - Text already in the TUI's input box (typed in the terminal, never sent) would get our paste appended to it,
 *   so a send checks the box first and asks the browser what to do with it.
 * - While Claude is waiting on a dialog, a send is refused: keys typed into a dialog answer it.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config";
import { getRun, tmux, tmuxTarget, ApiError } from "../runner";
import { claudeRegistry } from "../agents";
import type { RunRow } from "../db";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const UPLOAD_MAX = 20 * 1024 * 1024;
const TEXT_MAX = 200_000;

// ---------------------------------------------------------------- the pane

function paneOf(run: RunRow): { target: string; pid: number } {
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive, so there's no terminal to type into`);
  if (run.status !== "running" || !run.pid) throw new ApiError(409, `run ${run.id} is not running`);
  return { target: tmuxTarget(meta.tmux), pid: run.pid };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
const isRule = (plain: string) => /^─{20,}\s*$/.test(plain);

/**
 * What's in the TUI's input box: the lines between the last two horizontal rules on screen, the first one
 * starting with the prompt mark (❯, or ! in shell mode). The empty box shows a dim placeholder, which isn't a
 * draft. Returns null when there's no input box on screen (a dialog or menu has the screen).
 */
export async function readDraft(target: string): Promise<string | null> {
  const cap = await tmux("capture-pane", "-p", "-e", "-t", target);
  if (cap.code !== 0) throw new ApiError(500, `tmux capture-pane failed: ${cap.err}`);
  const lines = cap.out.split("\n");
  const plain = lines.map(stripAnsi);
  let bottom = -1;
  for (let i = plain.length - 1; i >= 0 && bottom < 0; i--) if (isRule(plain[i])) bottom = i;
  let top = -1;
  for (let i = bottom - 1; i >= 0 && top < 0; i--) if (isRule(plain[i])) top = i;
  if (top < 0 || bottom - top < 2) return null;
  const first = /^([❯>!])\s?(.*)$/.exec(plain[top + 1]);
  if (!first) return null;
  // A dim run right after the prompt mark is the placeholder ("Try …", "Press up to edit queued messages", or a
  // suggested next prompt). While the terminal has focus, Claude draws its cursor on the placeholder's first
  // character (inverse), so the dim starts one character later.
  const raw = lines[top + 1];
  const lead = /^(?:\s|\x1b\[[0-9;]*m)*(?:(?<=\x1b\[7m)[^\x1b](?:\x1b\[[0-9;]*m)*)?/u.exec(raw.slice(raw.indexOf(first[1]) + first[1].length))![0];
  if (/\x1b\[(?:[0-9;]*;)?2(?:;[0-9;]*)?m/.test(lead)) return "";
  const body = [first[2], ...plain.slice(top + 2, bottom).map((l) => l.replace(/^  /, ""))].join("\n").replace(/\s+$/, "");
  return first[1] === "!" ? `!${body}` : body;
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(80);
  }
  return check();
}

async function paste(target: string, text: string) {
  const buf = `lofiwave-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const p = Bun.spawn(["tmux", "load-buffer", "-b", buf, "-"], { stdin: Buffer.from(text), stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new ApiError(500, `tmux load-buffer failed: ${(await new Response(p.stderr).text()).trim()}`);
  const r = await tmux("paste-buffer", "-p", "-d", "-b", buf, "-t", target);
  if (r.code !== 0) throw new ApiError(500, `tmux paste-buffer failed: ${r.err}`);
}

/** Empty the input box a line at a time (end, delete to start, join the next and previous line), checking as it goes. */
async function clearDraft(target: string) {
  for (let i = 0; i < 60; i++) {
    const d = await readDraft(target);
    if (d === "") return;
    if (d === null) throw new ApiError(409, "the terminal is showing something other than Claude's input box");
    await tmux("send-keys", "-t", target, "C-e", "C-u", "Delete", "BSpace");
    await Bun.sleep(60);
  }
  throw new ApiError(500, "couldn't clear the terminal's input box");
}

const imageCount = (s: string | null) => (s?.match(/\[Image #\d+\]/g) ?? []).length;

// ---------------------------------------------------------------- send

/** One send at a time per run: two browsers sending at once would interleave their pastes. */
const locks = new Map<number, Promise<unknown>>();
function serialized<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(runId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(runId, next);
  next.finally(() => { if (locks.get(runId) === next) locks.delete(runId); }).catch(() => {});
  return next;
}

export type SendOptions = { text: string; files: string[]; draft?: "replace" | "append" | "" };

export function chatSend(runId: number, o: SendOptions): Promise<{ ok: true; queued: boolean }> {
  return serialized(runId, async () => {
    const run = getRun(runId);
    const { target, pid } = paneOf(run);
    if (o.text.length > TEXT_MAX) throw new ApiError(413, `message is too long (${o.text.length} characters; the limit is ${TEXT_MAX})`);
    const files = o.files.map((f) => uploadPath(runId, f));
    if (!o.text.trim() && !files.length) throw new ApiError(400, "nothing to send");

    const reg = claudeRegistry(true).byPid.get(pid);
    if (reg?.status === "waiting") throw new ApiError(409, `Claude is waiting${(reg as any).waitingFor ? ` (${(reg as any).waitingFor})` : ""}; answer it in the terminal first`);
    const draft = await readDraft(target);
    if (draft === null) throw new ApiError(409, "the terminal is showing a menu or dialog, not Claude's input box; check the terminal");
    if (draft) {
      if (o.draft === "replace") await clearDraft(target);
      else if (o.draft !== "append") throw new ApiError(409, "the terminal has an unsent draft", { draft });
    }

    // Images first, each pasted on its own and confirmed by its chip.
    let text = o.text;
    const refs: string[] = [];
    for (const f of files) {
      if (!IMAGE_EXT.has(f.ext)) { refs.push(`@${f.path}`); continue; }
      const before = imageCount(await readDraft(target));
      await paste(target, f.path);
      if (!(await waitFor(async () => imageCount(await readDraft(target)) > before, 3000)))
        throw new ApiError(500, `the terminal didn't attach ${f.name} as an image; check the terminal`);
      await paste(target, " ");
    }
    // A file reference goes on a line of its own: right at the end of the text, the TUI's file picker would take the Enter.
    if (refs.length) text = refs.join(" ") + (text.trim() ? "\n" + text : " ");
    if (draft && o.draft === "append") text = (/\s$/.test(draft) ? "" : " ") + text;
    if (text) {
      const before = await readDraft(target);
      await paste(target, text);
      await waitFor(async () => (await readDraft(target)) !== before, 1500);
    }
    await tmux("send-keys", "-t", target, "Enter");
    return { ok: true, queued: reg?.status === "busy" };
  });
}

/** Stop the current turn: Escape, which the TUI takes as an interrupt while it works. Only sent while busy. */
export async function chatInterrupt(runId: number): Promise<{ ok: true }> {
  const { target, pid } = paneOf(getRun(runId));
  const st = claudeRegistry(true).byPid.get(pid)?.status;
  if (st !== "busy") throw new ApiError(409, st ? `Claude isn't working (it's ${st})` : "can't tell whether Claude is working");
  const r = await tmux("send-keys", "-t", target, "Escape");
  if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
  return { ok: true };
}

/** The bottom of the screen, for the "terminal needs you" banner. */
export async function chatScreen(runId: number, lines = 20): Promise<{ text: string }> {
  const { target } = paneOf(getRun(runId));
  const cap = await tmux("capture-pane", "-p", "-J", "-t", target);
  const all = cap.out.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  return { text: all.slice(-Math.min(Math.max(lines, 4), 60)).join("\n") };
}

// ---------------------------------------------------------------- uploads

const uploadDir = (runId: number) => join(config.dataDir, "uploads", String(runId));

/** Save an upload as data/uploads/<run>/<sha>.<ext> (mode 600). HEIC becomes PNG on macOS (sips), since the TUI can't read it. */
export async function chatUpload(runId: number, req: Request, name: string): Promise<{ id: string; name: string; kind: "image" | "file"; bytes: number }> {
  paneOf(getRun(runId));
  const len = Number(req.headers.get("content-length") || 0);
  if (len > UPLOAD_MAX) throw new ApiError(413, `file is too big (the limit is ${UPLOAD_MAX / 1048576} MB)`);
  const data = Buffer.from(await req.arrayBuffer());
  if (data.length > UPLOAD_MAX) throw new ApiError(413, `file is too big (the limit is ${UPLOAD_MAX / 1048576} MB)`);
  if (!data.length) throw new ApiError(400, "empty upload");
  const clean = (name || "file").replace(/[^\w.\- ]+/g, "_").slice(-120) || "file";
  let ext = (/\.([A-Za-z0-9]{1,8})$/.exec(clean)?.[1] ?? "bin").toLowerCase();
  const dir = uploadDir(runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha = createHash("sha256").update(data).digest("hex").slice(0, 24);
  if (ext === "heic" || ext === "heif") {
    if (process.platform !== "darwin" || !Bun.which("sips")) throw new ApiError(415, "HEIC images can only be converted on macOS; export it as JPEG or PNG first");
    const src = join(dir, `${sha}.${ext}`), out = join(dir, `${sha}.png`);
    writeFileSync(src, data, { mode: 0o600 });
    const p = Bun.spawn(["sips", "-s", "format", "png", src, "--out", out], { stdout: "ignore", stderr: "pipe" });
    const code = await p.exited;
    rmSync(src, { force: true });
    if (code !== 0 || !existsSync(out)) throw new ApiError(415, "couldn't convert the HEIC image");
    chmodSync(out, 0o600);
    ext = "png";
  } else {
    const tmp = join(dir, `.${sha}.${process.pid}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(dir, `${sha}.${ext}`));
  }
  const id = `${sha}.${ext}`;
  writeFileSync(join(dir, `${id}.name`), clean, { mode: 0o600 });
  return { id, name: clean.replace(/\.(heic|heif)$/i, ".png"), kind: IMAGE_EXT.has(ext) ? "image" : "file", bytes: data.length };
}

function uploadPath(runId: number, id: string): { path: string; ext: string; name: string } {
  const m = /^([0-9a-f]{24})\.([a-z0-9]{1,8})$/.exec(id);
  if (!m) throw new ApiError(400, `bad upload id: ${id}`);
  const path = join(uploadDir(runId), id);
  if (!existsSync(path)) throw new ApiError(404, `upload ${id} not found (uploads belong to one run)`);
  let name = id;
  try { name = readFileSync(`${path}.name`, "utf8"); } catch { /* the id will do */ }
  return { path, ext: m[2], name };
}

/** Uploads live as long as the run's log: they go when the run is deleted. */
export function deleteUploads(runId: number) { rmSync(uploadDir(runId), { recursive: true, force: true }); }

// ---------------------------------------------------------------- the / list

export type SlashCommand = { name: string; description: string; source: "built-in" | "user" | "project" | "plugin"; menu?: boolean };

/** Built-ins worth listing. `menu`: it opens a menu or dialog in the TUI, so the browser switches to the terminal. */
const BUILT_IN: [string, string, boolean?][] = [
  ["/clear", "Start a new conversation (the old one stays on disk)"],
  ["/compact", "Summarize the conversation so far to free up context"],
  ["/context", "Show what's using the context window"],
  ["/usage", "Session cost, plan usage and limits"],
  ["/review", "Review a pull request"],
  ["/init", "Write a CLAUDE.md for this codebase"],
  ["/rewind", "Go back to an earlier point in the conversation", true],
  ["/resume", "Resume another conversation", true],
  ["/model", "Pick the model (with no argument it opens a menu)", true],
  ["/effort", "Set the reasoning effort"],
  ["/config", "Settings", true],
  ["/permissions", "Allow and deny rules for tools", true],
  ["/agents", "Manage subagents", true],
  ["/mcp", "Manage MCP servers", true],
  ["/hooks", "Manage hooks", true],
  ["/memory", "Edit memory files", true],
  ["/status", "Version, model, account and connection status", true],
  ["/login", "Sign in", true],
  ["/logout", "Sign out"],
  ["/doctor", "Check the installation", true],
  ["/help", "Help and the full command list", true],
  ["/export", "Export the conversation", true],
  ["/remote-control", "Continue this session from claude.ai/code"],
];

const MENU_WITHOUT_ARGS = new Set(["/model", "/effort"]);
/** Whether sending this text opens a TUI menu, so the composer should hand over to the terminal. */
export function opensMenu(text: string): boolean {
  const m = /^(\/[\w:-]+)(\s+\S)?/.exec(text.trim());
  if (!m) return false;
  if (MENU_WITHOUT_ARGS.has(m[1])) return !m[2];
  return BUILT_IN.some(([n, , menu]) => menu && n === m[1]);
}

function frontmatter(path: string): Record<string, string> {
  try {
    const text = readFileSync(path, "utf8").slice(0, 8192);
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    const out: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
    if (!out.description) out.description = text.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    return out;
  } catch { return {}; }
}

function scan(dir: string, prefix: string, source: SlashCommand["source"], out: SlashCommand[]) {
  const commands = join(dir, "commands"), skills = join(dir, "skills");
  const list = (d: string) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const walk = (d: string, ns: string) => {
    for (const e of list(d)) {
      if (e.isDirectory()) walk(join(d, e.name), `${ns}${e.name}:`);
      else if (e.name.endsWith(".md")) out.push({ name: `/${prefix}${ns}${e.name.slice(0, -3)}`, description: frontmatter(join(d, e.name)).description ?? "", source });
    }
  };
  walk(commands, "");
  for (const e of list(skills)) {
    const md = join(skills, e.name, "SKILL.md");
    if (e.isDirectory() && existsSync(md)) { const f = frontmatter(md); out.push({ name: `/${prefix}${f.name || e.name}`, description: f.description ?? "", source }); }
  }
}

/** The `/` list: built-ins, then commands and skills from the project, the user and installed plugins. */
export function chatCommands(runId: number): { commands: SlashCommand[] } {
  const run = getRun(runId);
  const out: SlashCommand[] = BUILT_IN.map(([name, description, menu]) => ({ name, description, source: "built-in" as const, ...(menu ? { menu: true } : {}) }));
  const home = join(homedir(), ".claude");
  if (run.cwd && resolve(run.cwd) !== homedir()) scan(join(run.cwd, ".claude"), "", "project", out);
  scan(home, "", "user", out);
  try {
    const installed = JSON.parse(readFileSync(join(home, "plugins", "installed_plugins.json"), "utf8"));
    for (const [key, installs] of Object.entries<any>(installed.plugins ?? {})) {
      const path = installs?.[0]?.installPath;
      if (typeof path === "string") scan(path, `${key.split("@")[0]}:`, "plugin", out);
    }
  } catch { /* no plugins */ }
  const seen = new Set<string>();
  return { commands: out.filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c) => ({ ...c, description: c.description.slice(0, 200) })) };
}
