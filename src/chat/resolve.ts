/**
 * Shortened paths in Claude's text → the files it meant, so they can be links too. Claude often writes `chat.js`,
 * `chat/files.ts` or `…/resolve.ts` for a file that isn't at that path relative to the cwd (it's under `public/`, in
 * another repo the session worked in, a worktree). A path that resolves as written never comes here (see ./files.ts).
 *
 * Each mention goes down a chain and stops at the first step that decides it:
 *   1. candidates: files whose path ends with what was written (`…/` and `/.../` match any folders), from the files
 *      the session touched and from a file index of the git repos it worked in (the cwd's, and each touched file's);
 *      copies of one file in several worktrees of a repo count once;
 *   2. one candidate: that's it;
 *   3. several: Jev, in two batched calls for every mention a render turned up. The first ranks all candidates for
 *      each mention (a Choice) given the passage the mention is in, the last prompt and the files the session touched;
 *      the second re-checks the top three with a Noul each, now with each file's opening lines. A winner needs a high
 *      Noul and a clear lead over the runner-up (a little less when both calls picked it); anything less stays
 *      unlinked. A companion Noul in the same call asks whether one particular file is meant at all (not "each
 *      package's info.json"); if not, nothing is linked. A wrong link is worse than none.
 *   Without Jev (no TYPESAFE_API_KEY, or it fails), step 3 takes the one candidate the session touched, if only one was.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Item } from "./claude";
import type { ChoiceAnswer, JevAsk, NoulAnswer, Question } from "../jev";

export type Resolved = { abs: string; via: "unique" | "session" | "jev"; confidence?: number };

type How = "edited" | "read" | "mentioned";
type Touch = { abs: string; how: How };
type Candidate = { abs: string; real: string; how?: How; root: number };

/** Choice questions take at most 255 options. */
const MAX_CANDIDATES = 255;
const SHORTLIST = 3;
/** Up to this many candidates, the ranking call sees each one's opening lines too (Jev input costs ~$0.04/Mtok). */
const RANK_WITH_OPENING = 80;
const ACCEPT = 0.7, LEAD = 0.25, AGREE = 0.55, AGREE_LEAD = 0.3, SPECIFIC = 0.35;
const INDEX_TTL_MS = 120_000;
const INDEX_MAX = 100_000, WALK_MAX = 20_000, MAX_NESTED = 40;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target", ".cache"]);

const realOrNull = (p: string) => { try { return realpathSync(p); } catch { return null; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const tilde = (p: string) => { const h = homedir(); return p === h || p.startsWith(h + sep) ? "~" + p.slice(h.length) : p; };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What was written → a regex over paths that end with it. Leading `./`, `../`, `…/` and `.../` are dropped (they say
 * "somewhere"), and a `...` or `…` folder in the middle matches any number of folders. Null for paths that are
 * explicit (absolute, ~/) or too vague to search for.
 */
export function suffixPattern(written: string): RegExp | null {
  let f = written.trim();
  if (!f || isAbsolute(f) || f.startsWith("~")) return null;
  f = f.replace(/^(?:(?:\.{1,3}|…)\/)+/, "");
  const parts = f.split("/").filter(Boolean);
  if (!parts.length || parts.every((p) => p === "..." || p === "…")) return null;
  const body = parts.map((p) => (p === "..." || p === "…" ? "(?:[^/]+/)*" : escape(p) + "/")).join("").replace(/\/$/, "");
  return new RegExp(`(?:^|/)${body}$`);
}

/** Files the session edited, read, or wrote out as absolute paths; newest first. */
export function touchedFiles(items: Item[]): Touch[] {
  const seen = new Map<string, Touch>();
  const add = (p: string, how: How) => {
    if (!p) return;
    const abs = p.startsWith("~/") ? homedir() + p.slice(1) : p;
    if (!isAbsolute(abs) || seen.has(abs)) return;
    seen.set(abs, { abs: resolve(abs), how });
  };
  for (let i = items.length - 1; i >= 0 && seen.size < 400; i--) {
    const it = items[i] as any;
    if (it.kind === "file_change") add(it.path, "edited");
    else if (it.kind === "read") add(it.label, "read");
    else if (it.kind === "assistant" || it.kind === "user") {
      for (const m of String(it.text || "").matchAll(/(?<![\w.])(~?\/[\w@.+-]+(?:\/[\w@.+-]+)+)/g)) add(m[1].replace(/[.,;:]+$/, ""), "mentioned");
    }
  }
  return [...seen.values()];
}

/** The nearest folder at or above `dir` with a .git in it (a repo or a worktree), or null. */
function gitRoot(dir: string, cache: Map<string, string | null>): string | null {
  const walked: string[] = [];
  let d = dir, found: string | null = null;
  for (;;) {
    if (cache.has(d)) { found = cache.get(d)!; break; }
    walked.push(d);
    if (existsSync(join(d, ".git"))) { found = d; break; }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const w of walked) cache.set(w, found);
  return found;
}

/** The folders to search: the cwd's repo (or the cwd), then the repos of the files the session touched. Not $HOME. */
export function searchRoots(cwd: string, touched: Touch[], allowed: (real: string) => boolean): string[] {
  const cache = new Map<string, string | null>();
  const home = realOrNull(homedir());
  const out: string[] = [];
  const add = (p: string | null) => {
    const r = p && realOrNull(p);
    if (r && r !== "/" && r !== home && allowed(r) && !out.includes(r)) out.push(r);
  };
  if (cwd && cwd !== "/") add(gitRoot(cwd, cache) ?? cwd);
  for (const t of touched.slice(0, 80)) { if (out.length >= 8) break; add(gitRoot(dirname(t.abs), cache)); }
  return out;
}

/** A repo's tracked files and untracked ones git doesn't ignore. */
function gitFiles(root: string): string[] {
  const r = Bun.spawnSync(["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
  return r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean).slice(0, INDEX_MAX) : [];
}

const indexes = new Map<string, { at: number; files: string[] }>();

/** Every file under `root`, relative to it: git's tracked + untracked-not-ignored, or a bounded walk outside git. */
export function filesUnder(root: string): string[] {
  const hit = indexes.get(root);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files;
  let files: string[] = [];
  if (existsSync(join(root, ".git"))) files = gitFiles(root);
  else {
    // Breadth-first, so the cap is spent on shallow files before one deep data folder eats it. A git repo inside is
    // listed by git instead (its ignored build and data folders stay out).
    const repos: string[] = [];
    let level: string[] = [""];
    for (let depth = 0; level.length && depth <= 8 && files.length < WALK_MAX; depth++) {
      const next: string[] = [];
      for (const rel of level) {
        if (rel && existsSync(join(root, rel, ".git"))) { repos.push(rel); continue; }
        let names: import("node:fs").Dirent[];
        try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of names) {
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) next.push(rel + e.name + "/"); }
          else if (e.isFile() && files.length < WALK_MAX) files.push(rel + e.name);
        }
      }
      level = next;
    }
    for (const rel of repos.slice(0, MAX_NESTED)) {
      if (files.length >= INDEX_MAX) break;
      for (const f of gitFiles(join(root, rel))) files.push(rel + f);
    }
  }
  indexes.set(root, { at: Date.now(), files });
  return files;
}

/**
 * The repo a checkout belongs to (worktrees share it): a `.git` folder is its own; a `.git` file says
 * `gitdir: <repo>/.git/worktrees/<name>`. `main` is false for a worktree.
 */
function repoOf(root: string): { id: string; main: boolean } {
  const g = join(root, ".git");
  try {
    if (statSync(g).isDirectory()) return { id: realOrNull(g) ?? g, main: true };
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
    if (m) {
      const dir = resolve(root, m[1].trim());
      return { id: realOrNull(/\/worktrees\/[^/]+\/?$/.test(dir) ? dirname(dirname(dir)) : dir) ?? dir, main: false };
    }
  } catch { /* not readable: treat as its own repo */ }
  return { id: g, main: true };
}

/**
 * Files that `written` could be: touched ones first, then by repo order (the cwd's first), then main checkouts
 * before worktrees, then shortest path. Copies of one file in several checkouts of a repo (same repo-relative path)
 * count once, as the first of them: with a worktree per branch, `chat.js` would otherwise always be ambiguous.
 */
export function candidatesFor(written: string, touched: Touch[], roots: string[], allowed: (real: string) => boolean): Candidate[] {
  const re = suffixPattern(written);
  if (!re) return [];
  const byReal = new Map<string, Candidate>();
  const add = (abs: string, how: How | undefined, root: number) => {
    const real = realOrNull(abs);
    if (!real || !allowed(real) || !isFile(real)) return;
    const had = byReal.get(real);
    if (had) { had.how ??= how; return; }
    byReal.set(real, { abs, real, how, root });
  };
  for (const t of touched) if (re.test(t.abs)) add(t.abs, t.how, -1);
  roots.forEach((root, i) => { for (const rel of filesUnder(root)) if (re.test(rel)) add(join(root, rel), undefined, i); });
  const rootCache = new Map<string, string | null>(), repoCache = new Map<string, { id: string; main: boolean }>();
  const info = new Map<Candidate, { key: string; main: boolean }>();
  for (const c of byReal.values()) {
    const r = gitRoot(dirname(c.real), rootCache);
    if (!r) { info.set(c, { key: c.real, main: true }); continue; }
    let repo = repoCache.get(r);
    if (!repo) repoCache.set(r, (repo = repoOf(r)));
    info.set(c, { key: `${repo.id}\0${relative(r, c.real)}`, main: repo.main });
  }
  const seen = new Set<string>();
  return [...byReal.values()]
    .sort((a, b) => Number(!a.how) - Number(!b.how) || a.root - b.root || Number(!info.get(a)!.main) - Number(!info.get(b)!.main) || a.abs.length - b.abs.length)
    .filter((c) => { const k = info.get(c)!.key; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_CANDIDATES);
}

/** The text around the newest place Claude wrote `written`, and the last prompt: what Jev reads the mention against. */
export function contextFor(written: string, items: Item[]): { passage: string; prompt: string } {
  let passage = "", prompt = "";
  for (let i = items.length - 1; i >= 0 && (!passage || !prompt); i--) {
    const it = items[i] as any;
    const text: string = it.kind === "assistant" ? it.text : it.kind === "plan" ? it.markdown : "";
    if (!passage && text) {
      const at = text.lastIndexOf(written);
      if (at >= 0) passage = text.slice(Math.max(0, at - 400), at + written.length + 300).trim();
    }
    if (!prompt && it.kind === "user" && !it.notification && it.text) prompt = String(it.text).slice(0, 600);
  }
  return { passage, prompt };
}

/** A file's first lines, for the re-check: what it is, beyond its name. */
function opening(real: string, max = 700): string {
  try {
    const fd = openSync(real, "r");
    const buf = Buffer.alloc(max);
    const n = (() => { try { return readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); } })();
    const s = buf.subarray(0, n);
    return s.includes(0) ? "(binary)" : s.toString("utf8").split("\n").slice(0, 14).join("\n");
  } catch { return ""; }
}

const describe = (c: Candidate) => (c.how ? `${c.how} in this session` : "not touched in this session");

/**
 * Resolve each mention (paths that didn't resolve as written). `allowed` says which real paths may be served.
 * Mentions nothing is sure about are left out of the result.
 */
export async function resolveMentions(opts: {
  cwd: string; mentions: string[]; items: Item[]; allowed: (real: string) => boolean; jev: JevAsk | null;
}): Promise<Record<string, Resolved>> {
  const { cwd, items, allowed, jev } = opts;
  const out: Record<string, Resolved> = {};
  const mentions = [...new Set(opts.mentions)].filter((m) => suffixPattern(m));
  if (!mentions.length) return out;
  const touched = touchedFiles(items);
  const roots = searchRoots(cwd, touched, allowed);

  const open: { written: string; cands: Candidate[]; passage: string }[] = [];
  let prompt = "";
  for (const written of mentions) {
    const cands = candidatesFor(written, touched, roots, allowed);
    if (cands.length === 1) { out[written] = { abs: cands[0].abs, via: "unique" }; continue; }
    if (cands.length > 1) {
      const ctx = contextFor(written, items);
      prompt ||= ctx.prompt;
      open.push({ written, cands, passage: ctx.passage });
    }
  }
  if (!open.length) return out;

  const fallback = (o: (typeof open)[number]) => {
    const t = o.cands.filter((c) => c.how);
    if (t.length === 1) out[o.written] = { abs: t[0].abs, via: "session" };
  };
  if (!jev) { open.forEach(fallback); return out; }

  const recent = touched.slice(0, 25).map((t) => `${tilde(t.abs)} (${t.how})`);
  // Option names are the paths themselves (Jev reads them); `~` keeps them short.
  const keyOf = (c: Candidate) => tilde(c.abs);

  // Call 1: rank every candidate, one Choice per mention.
  let shortlists: Candidate[][];
  try {
    const qs: Record<string, Question> = {};
    open.forEach((o, i) => {
      qs[`m${i}`] = {
        type: "choice",
        instructions: `An AI coding assistant wrote the shortened path "${o.written}" in its reply. Which file on disk did it mean? ` +
          `Use the passage it appears in, what the user asked, and which files the session worked on.\n\nPassage:\n${o.passage || "(not found)"}`,
        // With few enough candidates, each brings its opening lines: a path alone rarely says which package.json it is.
        criteria: Object.fromEntries(o.cands.map((c) => [keyOf(c), o.cands.length <= RANK_WITH_OPENING
          ? { session: describe(c), opening_lines: opening(c.real, 300) } : describe(c)])),
      };
    });
    const ans = await jev({ working_folder: tilde(cwd), user_request: prompt, files_touched_recently: recent }, qs);
    shortlists = open.map((o, i) => {
      const a = ans[`m${i}`] as ChoiceAnswer | undefined;
      if (!a?.probabilities) return [];
      return [...o.cands].sort((x, y) => (a.probabilities[keyOf(y)] ?? 0) - (a.probabilities[keyOf(x)] ?? 0)).slice(0, SHORTLIST);
    });
  } catch (e) {
    console.warn(`[paths] jev rank failed: ${(e as Error).message}`);
    open.forEach(fallback);
    return out;
  }

  // Call 2: re-check the shortlist, one Noul per candidate, with each file's opening lines.
  try {
    const state: Record<string, unknown> = { working_folder: tilde(cwd), user_request: prompt, mentions: {} };
    const qs: Record<string, Question> = {};
    open.forEach((o, i) => {
      if (!shortlists[i].length) return;
      (state.mentions as any)[`m${i}`] = {
        written_as: o.written,
        passage: o.passage,
        candidates: Object.fromEntries(shortlists[i].map((c, j) => [`c${j}`, { path: keyOf(c), session: describe(c), opening_lines: opening(c.real) }])),
      };
      // Companion: is one file meant at all, or a kind of file ("each package's info.json")?
      qs[`m${i}_specific`] = {
        type: "noul",
        instructions: `In \`mentions.m${i}.passage\`, does \`mentions.m${i}.written_as\` name one particular file the assistant worked with or is pointing the user to?`,
        criteria: {
          true: "One particular file, e.g. a file it read, edited, created or is telling the user to open",
          false: "A kind of file or a file name in general, e.g. every package's info.json, a file some tool writes, a file on another machine",
        },
      };
      shortlists[i].forEach((_c, j) => {
        qs[`m${i}_c${j}`] = {
          type: "noul",
          instructions: `Does the shortened path \`mentions.m${i}.written_as\`, as used in \`mentions.m${i}.passage\`, refer to the file \`mentions.m${i}.candidates.c${j}\`?`,
          criteria: {
            true: "This specific file is the one the assistant meant: its folder and contents fit the passage",
            false: "A different file was meant, or this one only shares the name",
          },
        };
      });
    });
    if (!Object.keys(qs).length) return out;
    const ans = await jev(state, qs);
    open.forEach((o, i) => {
      const scored = shortlists[i].map((c, j) => ({ c, p: (ans[`m${i}_c${j}`] as NoulAnswer | undefined)?.noul ?? 0 })).sort((a, b) => b.p - a.p);
      const [best, second] = scored;
      const lead = second ? best.p - second.p : best?.p ?? 0;
      if (((ans[`m${i}_specific`] as NoulAnswer | undefined)?.noul ?? 1) < SPECIFIC) return;
      // Clear on its own, or both calls picked it (the ranking's top is the re-check's top) with a wider lead.
      const sure = best && ((best.p >= ACCEPT && lead >= LEAD) || (best.c === shortlists[i][0] && best.p >= AGREE && lead >= AGREE_LEAD));
      if (sure) out[o.written] = { abs: best.c.abs, via: "jev", confidence: Math.round(best.p * 100) / 100 };
    });
  } catch (e) {
    console.warn(`[paths] jev check failed: ${(e as Error).message}`);
    open.forEach(fallback);
  }
  return out;
}
