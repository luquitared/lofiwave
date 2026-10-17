/**
 * Swarms: several agent runs started together on one job, each in its own folder, reporting back through files.
 *
 *   <cwd_root>/<group>/BRIEF.md          the shared brief (also copied into every worker folder)
 *   <cwd_root>/<group>/<worker>/TASK.md  that worker's task, followed by the worker contract
 *   <cwd_root>/<group>/<worker>/STATUS.md   kept by the worker: first line = its current state
 *   <cwd_root>/<group>/<worker>/out/        its deliverables; out/REPORT.md when it is finished
 *   <cwd_root>/<group>/<worker>/COST.md     optional: what it has spent
 *
 * The workers are ordinary runs (meta.group, meta.swarm_worker); this file only deals with their folders.
 * Starting, messaging and stopping them is in server.ts, through the same paths as any other run.
 */
import { join, resolve, isAbsolute, normalize, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { ApiError } from "./runner";

/** Group and worker names end up in paths and tmux-visible prompts: keep them to plain name characters. */
export function checkName(v: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v) || v.includes("..")) throw new ApiError(400, `${field} may only contain letters, digits, _ . - (up to 64, starting with a letter or digit)`);
  return v;
}

export const CONTRACT = `## How to report (the swarm contract)

- **STATUS.md**: keep it current. Its first line is one line of your current state, e.g.
  \`working: 3/5 configs tried, best 0.81\`. Rewrite that line whenever your state changes. Start it with
  \`working:\`, \`blocked: <why>\` (then wait for a message) or \`done:\`. Notes can go below it.
- **out/**: every deliverable goes here (results, tables, code, data). \`LOFIWAVE_OUT_DIR\` points to it.
- **out/REPORT.md**: write it when you are finished: what you did, the results (with numbers), what you
  recommend, and anything the controller should check. Then set STATUS.md's first line to \`done: <one-line summary>\`.
- **COST.md** (optional): if you spend money (cloud machines, paid APIs), keep a running total at the top
  and one line per thing you started. Stop and say \`blocked:\` before going over a budget given in the brief.
- Write STATUS.md, COST.md and out/ files with your file-editing tools, not shell commands: edits in this folder
  need no approval, while a shell command can stop you on a permission prompt until someone answers it.
- Stay in this folder. Other workers have their own folders next to it; don't change theirs.
`;

/** The first message each worker gets. Short: the detail is in the files it points to. */
export function workerPrompt(group: string, name: string, dir: string): string {
  return `You are worker "${name}" in the swarm "${group}", started by lofiwave. Your folder is ${dir}; work only there. ` +
    `Read BRIEF.md (the brief shared by every worker) and TASK.md (your own task and how to report), then do the task. ` +
    `Keep STATUS.md's first line current, put deliverables in out/, and finish by writing out/REPORT.md.`;
}

export function taskFile(group: string, name: string, task: string): string {
  return `# Task for ${name} (swarm ${group})\n\n${task.trim()}\n\n${CONTRACT}`;
}

/** A relative path inside a worker folder, from a request (`files`). */
function safeRel(rel: string): string {
  const n = normalize(rel);
  if (!rel || isAbsolute(rel) || n.startsWith("..") || n.split(sep).includes("..")) throw new ApiError(400, `files: "${rel}" must be a relative path inside the worker folder`);
  return n;
}

export type WorkerSpec = { name: string; prompt: string; files: Record<string, string> };

/** Make <root>/<group>/ and a folder per worker with BRIEF.md, TASK.md, STATUS.md, out/ and any extra files. */
export function prepareFolders(groupDir: string, group: string, brief: string, workers: WorkerSpec[]): Record<string, string> {
  const dirs: Record<string, string> = {};
  mkdirSync(groupDir, { recursive: true });
  if (brief.trim()) writeFileSync(join(groupDir, "BRIEF.md"), brief.trim() + "\n");
  for (const w of workers) {
    const dir = join(groupDir, w.name);
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "BRIEF.md"), (brief.trim() || `(no shared brief for swarm ${group})`) + "\n");
    writeFileSync(join(dir, "TASK.md"), taskFile(group, w.name, w.prompt));
    if (!existsSync(join(dir, "STATUS.md"))) writeFileSync(join(dir, "STATUS.md"), "starting: not picked up yet\n");
    for (const [rel, content] of Object.entries(w.files)) {
      const path = join(dir, safeRel(rel));
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    dirs[w.name] = dir;
  }
  return dirs;
}

function head(path: string, bytes = 4096): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** The first line that says something: skips blanks and a bare "# STATUS" heading. */
function firstLine(text: string): string {
  for (const raw of text.split("\n")) {
    const l = raw.replace(/^#+\s*/, "").trim();
    if (l && !/^status(\.md)?$/i.test(l)) return l.slice(0, 300);
  }
  return "";
}

export type WorkerFiles = {
  status_line: string;        // STATUS.md's first line: the worker's own one-line state
  status_text: string;        // the top of STATUS.md (up to 20 lines)
  status_updated_at: number | null;
  report: boolean;            // out/REPORT.md exists
  report_updated_at: number | null;
  report_excerpt: string;     // its first lines
  cost_line: string;          // COST.md's first line, if any
  out_files: string[];        // names in out/ (top level, up to 50)
};

export function readWorkerFiles(dir: string): WorkerFiles {
  const statusPath = join(dir, "STATUS.md"), reportPath = join(dir, "out", "REPORT.md"), costPath = join(dir, "COST.md");
  const status = head(statusPath);
  const report = existsSync(reportPath);
  let out_files: string[] = [];
  try { out_files = readdirSync(join(dir, "out")).filter((f) => !f.startsWith(".")).sort().slice(0, 50); } catch { /* no out/ */ }
  return {
    status_line: firstLine(status),
    status_text: status.split("\n").slice(0, 20).join("\n").trim(),
    status_updated_at: existsSync(statusPath) ? statSync(statusPath).mtimeMs : null,
    report,
    report_updated_at: report ? statSync(reportPath).mtimeMs : null,
    report_excerpt: report ? head(reportPath, 1500).split("\n").slice(0, 12).join("\n").trim() : "",
    cost_line: firstLine(head(costPath, 1024)),
    out_files,
  };
}

export function readReport(dir: string): string {
  const p = join(dir, "out", "REPORT.md");
  if (!existsSync(p)) throw new ApiError(404, "no out/REPORT.md yet");
  return readFileSync(p, "utf8");
}
