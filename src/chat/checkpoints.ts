/**
 * Git checkpoints for the chat view's per-turn changes (see docs/rendered-view.md, "Phase 5").
 *
 * When a prompt is submitted and when Claude stops, the run's working tree is snapshotted into a commit kept under
 * a hidden ref, `refs/lofiwave/run-<run>/<n>`. The diff between a turn's two snapshots is everything that turn
 * changed, including files written through Bash, which leave no edit in the transcript.
 *
 * Nothing touches the user's branch, index or stash: the snapshot is built in a throwaway index file
 * (GIT_INDEX_FILE), seeded from the real one so it's quick. Untracked files follow .gitignore; big ones are left out.
 * The objects do land in the repo's object store, like any `git stash`.
 */
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { config } from "../config";
import { db, now } from "../db";
import type { Hunk } from "./claude";

/** Untracked files bigger than this aren't snapshotted (models, videos, dumps). */
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
/** More untracked files than this: snapshot tracked files only. */
const MAX_UNTRACKED_FILES = 20_000;
/** A turn listing more files than this is cut short. */
const MAX_FILES = 300;
const GIT_TIMEOUT_MS = 30_000;

export type Checkpoint = { id: number; run_id: number; session_id: string; prompt_id: string; kind: "start" | "end"; root: string; commit_sha: string; at: number };
export type ChangedFile = { path: string; status: string; added: number; removed: number; binary?: boolean };
export type TurnChanges = { root: string; files: ChangedFile[]; added: number; removed: number; truncated: boolean; live: boolean };

const IDENTITY = { GIT_AUTHOR_NAME: "lofiwave", GIT_AUTHOR_EMAIL: "lofiwave@localhost", GIT_COMMITTER_NAME: "lofiwave", GIT_COMMITTER_EMAIL: "lofiwave@localhost" };

async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), GIT_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out, err };
}

/** The top of the work tree `cwd` is in, or "" (not a repo, a bare repo, git missing). Cached briefly. */
const roots = new Map<string, { root: string; at: number }>();
async function repoRoot(cwd: string): Promise<string> {
  const hit = roots.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.root;
  let root = "";
  try { const r = await git(cwd, ["rev-parse", "--show-toplevel"]); if (r.code === 0) root = r.out.trim(); } catch { /* no git */ }
  roots.set(cwd, { root, at: Date.now() });
  return root;
}

/** One snapshot at a time per repo: two runs in one folder would otherwise race on the object store's packing. */
const queues = new Map<string, Promise<unknown>>();
function serially<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(root) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(root, next);
  next.finally(() => { if (queues.get(root) === next) queues.delete(root); }).catch(() => {});
  return next;
}

/** The working tree of `root` as a commit, or null when git fails. */
async function snapshot(root: string): Promise<string | null> {
  return serially(root, async () => {
    const tmp = join(config.dataDir, `checkpoint-${process.pid}-${Math.random().toString(36).slice(2)}.index`);
    try {
      const idx = await git(root, ["rev-parse", "--git-path", "index"]);
      const real = idx.code === 0 ? resolve(root, idx.out.trim()) : "";
      if (real && existsSync(real)) copyFileSync(real, tmp);
      const env = { GIT_INDEX_FILE: tmp };
      // Tracked files (changes and deletions) first, then the untracked files git would show, minus the big ones.
      if ((await git(root, ["add", "-u", "--", "."], { env })).code !== 0) return null;
      const others = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"], { env });
      const paths = others.code === 0 ? others.out.split("\0").filter(Boolean) : [];
      if (paths.length && paths.length <= MAX_UNTRACKED_FILES) {
        const keep = paths.filter((p) => { try { return statSync(join(root, p)).size <= MAX_UNTRACKED_BYTES; } catch { return false; } });
        if (keep.length) await git(root, ["add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, stdin: keep.map((p) => `:(literal)${p}`).join("\0") });
      }
      const tree = await git(root, ["write-tree"], { env });
      if (tree.code !== 0) return null;
      const commit = await git(root, ["commit-tree", tree.out.trim(), "-m", "lofiwave checkpoint"], { env: IDENTITY });
      return commit.code === 0 ? commit.out.trim() : null;
    } finally {
      rmSync(tmp, { force: true });
      rmSync(tmp + ".lock", { force: true });
    }
  });
}

/**
 * Snapshot the run's repo and record it against a prompt. Returns null when `cwd` isn't in a git work tree or git
 * fails; a run outside git simply has no per-turn changes.
 */
export async function checkpoint(runId: number, cwd: string, sessionId: string, promptId: string, kind: "start" | "end"): Promise<Checkpoint | null> {
  const root = cwd ? await repoRoot(cwd) : "";
  if (!root) return null;
  const sha = await snapshot(root);
  if (!sha) return null;
  const ins = db.prepare("INSERT INTO checkpoints (run_id, session_id, prompt_id, kind, root, commit_sha, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(runId, sessionId, promptId, kind, root, sha, now());
  const id = Number(ins.lastInsertRowid);
  // A ref keeps the commit from being garbage-collected while the run is around.
  await git(root, ["update-ref", `refs/lofiwave/run-${runId}/${id}`, sha]);
  return { id, run_id: runId, session_id: sessionId, prompt_id: promptId, kind, root, commit_sha: sha, at: now() };
}

/**
 * A turn's two ends: its start snapshot, and its end (the Stop snapshot, else the next prompt's start). No end yet
 * (still working, or interrupted with nothing after it): the tree as it is now.
 */
async function bounds(runId: number, promptId: string, finishedOnly = false): Promise<{ root: string; from: string; to: string; live: boolean } | null> {
  const start = db.query<Checkpoint, [number, string]>("SELECT * FROM checkpoints WHERE run_id = ? AND prompt_id = ? AND kind = 'start' ORDER BY id LIMIT 1").get(runId, promptId);
  if (!start) return null;
  const end = db.query<Checkpoint, [number, string]>("SELECT * FROM checkpoints WHERE run_id = ? AND prompt_id = ? AND kind = 'end' ORDER BY id DESC LIMIT 1").get(runId, promptId)
    ?? db.query<Checkpoint, [number, number, string]>("SELECT * FROM checkpoints WHERE run_id = ? AND id > ? AND kind = 'start' AND root = ? ORDER BY id LIMIT 1").get(runId, start.id, start.root);
  if (end) return { root: start.root, from: start.commit_sha, to: end.commit_sha, live: false };
  if (finishedOnly) return null;
  const sha = await snapshot(start.root);
  return sha ? { root: start.root, from: start.commit_sha, to: sha, live: true } : null;
}

/** Finished turns don't change: their lists are kept. */
const cache = new Map<string, TurnChanges>();

/** What a turn changed in its repo, per file. Null when the turn has no checkpoints (or, finishedOnly, no end yet). */
export async function turnChanges(runId: number, promptId: string, { finishedOnly = false } = {}): Promise<TurnChanges | null> {
  const key = `${runId}:${promptId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const b = await bounds(runId, promptId, finishedOnly);
  if (!b) return null;
  const [num, names] = await Promise.all([
    git(b.root, ["diff", "--no-renames", "--numstat", "-z", b.from, b.to]),
    git(b.root, ["diff", "--no-renames", "--name-status", "-z", b.from, b.to]),
  ]);
  if (num.code !== 0 || names.code !== 0) return null;
  const status = new Map<string, string>();
  const ns = names.out.split("\0");
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i]);
  const files: ChangedFile[] = [];
  let added = 0, removed = 0;
  for (const rec of num.out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const binary = m[1] === "-";
    const f: ChangedFile = { path: join(b.root, m[3]), status: status.get(m[3]) ?? "M", added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]) };
    if (binary) f.binary = true;
    added += f.added; removed += f.removed;
    files.push(f);
  }
  const out: TurnChanges = { root: b.root, files: files.slice(0, MAX_FILES), added, removed, truncated: files.length > MAX_FILES, live: b.live };
  if (!b.live) { cache.set(key, out); if (cache.size > 2000) cache.delete(cache.keys().next().value!); }
  return out;
}

/** One file's diff within a turn, as structuredPatch-style hunks (what the chat view's diff renderer takes). */
export async function turnFileDiff(runId: number, promptId: string, path: string): Promise<{ hunks: Hunk[]; binary: boolean } | null> {
  const b = await bounds(runId, promptId);
  if (!b) return null;
  const rel = relative(b.root, resolve(b.root, path));
  if (!rel || rel.startsWith(".." + sep) || rel === "..") return null;
  const r = await git(b.root, ["diff", "--no-renames", "--no-color", "--no-ext-diff", "-U3", b.from, b.to, "--", `:(literal)${rel}`]);
  if (r.code !== 0) return null;
  if (/^Binary files /m.test(r.out)) return { hunks: [], binary: true };
  return { hunks: parseHunks(r.out), binary: false };
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(cur);
    } else if (cur && /^[ +\-\\]/.test(line)) cur.lines.push(line);
  }
  return hunks;
}

/** The run's prompts that have a start checkpoint, newest last (the feed offers their changes). */
export function checkpointedPrompts(runId: number): string[] {
  return db.query<{ prompt_id: string }, [number]>("SELECT prompt_id FROM checkpoints WHERE run_id = ? AND kind = 'start' GROUP BY prompt_id ORDER BY MIN(id)").all(runId).map((r) => r.prompt_id);
}

/** Drop a run's refs (when the run is deleted); the commits go with the repo's next gc. */
export async function dropCheckpoints(runId: number) {
  const rows = db.query<Checkpoint, [number]>("SELECT * FROM checkpoints WHERE run_id = ?").all(runId);
  for (const r of rows) { try { await git(r.root, ["update-ref", "-d", `refs/lofiwave/run-${runId}/${r.id}`]); } catch { /* repo gone */ } }
  db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
}
