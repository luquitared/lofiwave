/**
 * Conversation search over this machine's Claude transcripts, for ccx (https://github.com/luquitared/ccx) on other
 * machines: `ccx search … -m <this machine>`. The console token finds everything; signed-in people and API keys find
 * what CCX_SHARE lets them (see config). lofiwave runs the ccx installed here and adds what only it knows:
 * who each session belongs to. That is the person who started the run in the console; a session nobody started
 * here (one from a terminal, a scheduled run, the token) belongs to the OS user lofiwave runs as.
 */
import { homedir, hostname, userInfo } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { ApiError } from "./runner";
import { TOKEN_ACTOR, KEY_ACTOR_PREFIX } from "./auth";

const INSTALL = "ccx isn't installed on this machine: git clone https://github.com/luquitared/ccx && cd ccx && bun link (or set CCX_BIN)";
const RUN_TIMEOUT_MS = 60_000;
/** How long a request waits for the index to catch up before searching what is already indexed. */
const INDEX_WAIT_MS = 10_000;
const INDEX_EVERY_MS = 30_000;
const MAX_LIMIT = 200;
/** Hits are filtered (by user, by what is shared) after ccx ranked them: ask for more until enough are kept, up to this many. */
const MAX_SCAN = 6400;

/** Whether ccx is installed here (for what a run is told about this machine). */
export const ccxInstalled = () => ccxCommand() !== null;

/** ccx as an argv prefix. It is a bun script, so lofiwave's own bun runs it: bun needn't be on the service's PATH. */
function ccxCommand(): string[] | null {
  const found = process.env.CCX_BIN?.trim() || Bun.which("ccx") || join(homedir(), ".bun", "bin", "ccx");
  if (!existsSync(found)) return null;
  const real = realpathSync(found);
  return /\.(ts|js|mjs)$/.test(real) ? [process.execPath, real] : [real];
}

/**
 * Run ccx and return what it printed. Its output goes to a file, not a pipe: ccx versions that print with
 * console.log lose everything past 64 KiB on a pipe. The file is in the data dir (owner-only): it holds conversation text.
 */
async function ccx(args: string[]): Promise<string> {
  const cmd = ccxCommand();
  if (!cmd) throw new ApiError(503, INSTALL);
  const dir = join(config.dataDir, "ccx");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, `${randomBytes(8).toString("hex")}.out`);
  try {
    const proc = Bun.spawn([...cmd, ...args], { stdin: "ignore", stdout: Bun.file(out), stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0) throw new ApiError(proc.signalCode ? 504 : 400, err.trim() || `ccx exited with ${code}`);
    return readFileSync(out, "utf8");
  } finally {
    rmSync(out, { force: true });
  }
}

/** `positional` (a query, a session) goes after `--`, so one that starts with a dash isn't read as an option. */
async function ccxJson(args: string[], positional?: string): Promise<any> {
  const text = await ccx([...args, "--json", ...(positional === undefined ? [] : ["--", positional])]);
  try { return JSON.parse(text); } catch { throw new ApiError(502, "ccx printed something that isn't JSON"); }
}

let indexing: Promise<unknown> | null = null;
let indexedAt = 0;
/** Bring the index up to date (sub-second when little changed). A first build takes minutes: don't hold a search for it. */
async function refreshIndex(): Promise<void> {
  if (!indexing && Date.now() - indexedAt > INDEX_EVERY_MS) {
    indexing = ccx(["index", "--quiet"]).then(() => { indexedAt = Date.now(); }, (e) => console.error("[ccx] index:", e?.message ?? e)).finally(() => { indexing = null; });
  }
  if (indexing) await Promise.race([indexing, Bun.sleep(INDEX_WAIT_MS)]);
}

const osUser = userInfo().username;

/** The person behind a run's `started_by`: a sign-in name as is, an API key's maker, nobody for the token. */
function personOf(by: string, keyMakers: Map<string, string>): string | null {
  if (!by || by === TOKEN_ACTOR) return null;
  if (by.startsWith(KEY_ACTOR_PREFIX)) return personOf(keyMakers.get(by.slice(KEY_ACTOR_PREFIX.length)) ?? "", new Map());
  return by;
}

/** session id → the person who started its run, for the sessions someone started here. */
function sessionPeople(): Map<string, string> {
  const keyMakers = new Map(db.query<{ name: string; created_by: string }, []>("SELECT name, created_by FROM api_keys").all().map((k) => [k.name, k.created_by]));
  const rows = db.query<{ session_id: string; by: string | null }, []>(
    "SELECT s.session_id, json_extract(r.meta, '$.started_by') AS by FROM sessions s JOIN runs r ON r.id = s.run_id ORDER BY s.started_at").all();
  const out = new Map<string, string>();
  for (const r of rows) {
    const who = typeof r.by === "string" ? personOf(r.by, keyMakers) : null;
    if (who) out.set(r.session_id, who);
  }
  return out;
}

/** `user` matches a whole name or its first word, ignoring case ("dana" finds "Dana K"), like GIT_AUTHORS. */
const sameUser = (name: string, user: string) => {
  const n = name.toLowerCase(), u = user.trim().toLowerCase();
  return n === u || n.split(/\s+/)[0] === u;
};

/**
 * The sessions a caller may find, or null for all of them: the owner always, and everyone when CCX_SHARE is "all".
 * With "picked" it is what the owner shared with `ccx share` (kept by ccx; a ccx too old to know `shared` shares nothing).
 */
async function visibleSessions(owner: boolean): Promise<Set<string> | null> {
  if (owner || config.ccxShare === "all") return null;
  try { return new Set<string>((await ccxJson(["shared"])).sessions ?? []); } catch (e) { if (e instanceof ApiError && e.status === 503) throw e; return new Set(); }
}

/**
 * Tag each row with its user and keep the ones this caller may find and, with `user`, that person's. Rows are
 * filtered after ccx ranked them, so ccx is asked for more until `limit` are kept.
 */
async function pick<T extends { session: string }>(fetch: (limit: number) => Promise<T[]>, limit: number, user: string, owner: boolean): Promise<(T & { user: string })[]> {
  const people = sessionPeople();
  const visible = await visibleSessions(owner);
  const tag = (rows: T[]) => rows.map((r) => ({ ...r, user: people.get(r.session) ?? osUser }));
  if (!user && !visible) return tag(await fetch(limit));
  if (visible?.size === 0) return [];
  for (let n = Math.max(limit * 4, 100); ; n *= 4) {
    const all = await fetch(n);
    const mine = tag(all).filter((r) => (!visible || visible.has(r.session)) && (!user || sameUser(r.user, user)));
    if (mine.length >= limit || all.length < n || n >= MAX_SCAN) return mine.slice(0, limit);
  }
}

const param = (url: URL, name: string) => url.searchParams.get(name)?.trim() ?? "";
const flag = (url: URL, name: string) => ["1", "true"].includes(param(url, name));
function limitOf(url: URL, def: number): number {
  const n = Number(param(url, "limit") || def);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}
/** `--name=value` for each given param: a value can't be read as another option. */
const options = (url: URL, names: Record<string, string>) =>
  Object.entries(names).flatMap(([p, opt]) => (param(url, p) ? [`--${opt}=${param(url, p)}`] : []));

/** GET /api/ccx: is ccx here, and whose sessions this machine has. */
export function ccxStatus() {
  const cmd = ccxCommand();
  return {
    available: Boolean(cmd), path: cmd ? cmd[cmd.length - 1] : null, install: cmd ? undefined : INSTALL,
    machine: hostname(), os_user: osUser, users: [...new Set([osUser, ...sessionPeople().values()])], sharing: config.ccxShare,
  };
}

/** GET /api/ccx/search?q=&project=&since=&until=&kind=&tool=&session=&main=&raw=&limit=&user= */
export async function ccxSearch(url: URL, owner: boolean) {
  const q = param(url, "q");
  if (!q) throw new ApiError(400, "q is required");
  await refreshIndex();
  const args = ["search", ...options(url, { project: "project", since: "since", until: "until", kind: "kind", tool: "tool", session: "session" }),
    ...(flag(url, "main") ? ["--main"] : []), ...(flag(url, "raw") ? ["--raw"] : [])];
  const results = await pick(async (n) => (await ccxJson([...args, `--limit=${n}`], q)).results ?? [], limitOf(url, 15), param(url, "user"), owner);
  return { machine: hostname(), results };
}

/** GET /api/ccx/sessions?project=&since=&query=&limit=&user= */
export async function ccxSessions(url: URL, owner: boolean) {
  await refreshIndex();
  const args = ["sessions", ...options(url, { project: "project", since: "since", query: "query" })];
  const sessions = await pick(async (n) => (await ccxJson([...args, `--limit=${n}`])).sessions ?? [], limitOf(url, 25), param(url, "user"), owner);
  return { machine: hostname(), sessions };
}

/** Where Claude keeps transcripts: the only files `show` reads by path. */
function transcriptRoots(): string[] {
  const dirs = [...(process.env.CCX_CLAUDE_DIRS?.split(":") ?? []), process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude"), join(homedir(), ".config", "claude")];
  return dirs.filter((d): d is string => Boolean(d)).map((d) => join(d, "projects")).filter((d) => existsSync(d)).map((d) => realpathSync(d));
}

/** GET /api/ccx/show?target=&line=&around=&context=&head=&tail=&full= — a slice of one conversation. */
export async function ccxShow(url: URL, owner: boolean) {
  let target = param(url, "target");
  if (!target) throw new ApiError(400, "target is required (a session id or prefix, or a transcript path from a search hit)");
  const visible = await visibleSessions(owner);
  const hidden = new ApiError(404, `no shared session matching "${target}" on this machine (its owner shares one with: ccx share <session>)`);
  if (/^[0-9a-f-]{1,36}$/i.test(target)) {
    await refreshIndex();
    if (visible) {
      // Only among the shared ones, by its full id: a prefix must not reach a session that isn't.
      const found = [...visible].filter((id) => id.toLowerCase().startsWith(target.toLowerCase()));
      if (found.length !== 1) throw hidden;
      target = found[0];
    }
  } else {
    // A subagent's hit names its file. ccx reads any path it is given, so only transcripts get through.
    let real = "";
    try { real = realpathSync(target); } catch { throw new ApiError(404, `no transcript at ${target}`); }
    if (!real.endsWith(".jsonl") || !transcriptRoots().some((root) => real.startsWith(root + "/"))) throw new ApiError(403, "target must be a session id or a Claude transcript on this machine");
    // <session>.jsonl, or a subagent's file under a folder named after its session.
    if (visible && !real.replace(/\.jsonl$/, "").split("/").some((part) => visible.has(part))) throw hidden;
    target = real;
  }
  const args = ["show", ...options(url, { line: "line", around: "around", context: "context", head: "head", tail: "tail" }), ...(flag(url, "full") ? ["--full"] : [])];
  return { machine: hostname(), ...(await ccxJson(args, target)) };
}
