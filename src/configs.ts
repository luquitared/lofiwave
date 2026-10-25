/**
 * Run configs: a named bundle attached to any run (POST /api/processes `config`, a workflow's `config`). It carries
 *
 * - `instructions`: custom instructions for the agent. claude gets them as `--append-system-prompt`, codex as
 *   `-c developer_instructions=…`; any other type through an `{instructions}` placeholder in its args, and every run
 *   gets them in `LOFIWAVE_INSTRUCTIONS`.
 * - `env`: KEY=VALUE pairs (API keys and the like), pasted as a .env file. The values are secrets: kept in the
 *   database only (not on the run record, not in its log), and listed masked.
 * - `docker` (optional): run the agent in a container of `image`, with the run's folder and `volumes` mounted, so it
 *   starts with tools installed or files in place. An interactive run's tmux pane runs `docker run -it …`.
 *
 * Env precedence, lowest first: lofiwave's own environment < the type's env < the config's env < the run's (or the
 * workflow's) env.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { db, type ConfigRow } from "./db";

export class ConfigError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type DockerVolume = { source: string; target: string; mode: "ro" | "rw" };
export type DockerSettings = {
  image: string;                 // e.g. "node:22" or an image you built with your tools in it
  volumes: DockerVolume[];       // besides the run's folder, which is always mounted at the same path
  user: string;                  // "" = the image's user; "host" = this machine's uid:gid (files in the folder stay yours); or "uid[:gid]"
  network: string;               // "" = docker's default bridge; "host", "none" or a network name
  args: string[];                // more `docker run` flags, as given
};
export type RunConfig = { name: string; description: string; instructions: string; env: Record<string, string>; docker: DockerSettings | null };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Never taken from a config: the console's own credentials, and what lofiwave sets on every run itself. */
const RESERVED = new Set(["AGENT_CONSOLE_RUN_ID", "AGENT_CONSOLE_URL", "AGENT_CONSOLE_TOKEN", "AUTH_TOKEN", "PASSWORD"]);

/**
 * A .env file as a map: `KEY=value` and `export KEY=value` lines, blank lines and `#` comments skipped. Values may be
 * "double quoted" (with \n, \t, \" and \\ escapes, and may span lines), 'single quoted' (taken as is) or bare (an
 * inline ` # comment` is cut off, and the value trimmed).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new ConfigError(400, `.env line ${i + 1}: expected KEY=value`);
    const key = m[1];
    if (!ENV_NAME.test(key)) throw new ConfigError(400, `.env line ${i + 1}: "${key}" is not a valid variable name`);
    let v = m[2];
    if (v.startsWith('"')) {
      // Up to the closing quote, which may be on a later line.
      let s = v.slice(1), val = "", closed = false;
      for (;;) {
        for (let j = 0; j < s.length; j++) {
          const c = s[j];
          if (c === "\\" && j + 1 < s.length) { const n = s[++j]; val += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n; }
          else if (c === '"') { closed = true; break; }
          else val += c;
        }
        if (closed || i + 1 >= lines.length) break;
        val += "\n"; s = lines[++i];
      }
      if (!closed) throw new ConfigError(400, `.env: unterminated "quote" for ${key}`);
      v = val;
    } else if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      if (end < 0) throw new ConfigError(400, `.env: unterminated 'quote' for ${key}`);
      v = v.slice(1, end);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[key] = v;
  }
  return out;
}

/** How a secret is listed: never in full. Long values keep their last 4 characters so you can tell keys apart. */
export const MASK = "••••";
export const maskValue = (v: string) => (v.length >= 20 ? `${MASK}${v.slice(-4)}` : MASK);
export const maskEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, maskValue(v)]));

/**
 * A config's env from a request: an object of strings, or .env text. A value sent back exactly as it was listed
 * (masked) keeps what is stored, so a form can show the masked list and save it with one key changed.
 */
export function parseEnvInput(v: unknown, cur: Record<string, string> = {}): Record<string, string> {
  if (v === undefined || v === null) return {};
  const raw = typeof v === "string" ? parseDotenv(v) : v;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(400, "env must be an object of strings or the text of a .env file");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(k)) throw new ConfigError(400, `env: "${k}" is not a valid variable name`);
    if (RESERVED.has(k)) throw new ConfigError(400, `env: ${k} is lofiwave's own and can't be set by a config`);
    const s = String(val ?? "");
    out[k] = s.startsWith(MASK) && k in cur && s === maskValue(cur[k]) ? cur[k] : s;
  }
  return out;
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** One volume: {source, target, mode} or "source:target[:ro|rw]". `source` is a host path (absolute or ~/…) or a named volume. */
function parseVolume(v: unknown, i: number): DockerVolume {
  let source = "", target = "", mode = "rw";
  if (typeof v === "string") {
    const parts = v.trim().split(":");
    if (parts.length < 2 || parts.length > 3) throw new ConfigError(400, `docker.volumes[${i}]: write it as source:target or source:target:ro`);
    [source, target, mode = "rw"] = parts;
  } else if (v && typeof v === "object") {
    const o = v as any;
    source = String(o.source ?? "").trim(); target = String(o.target ?? "").trim(); mode = String(o.mode ?? (o.readonly ? "ro" : "rw")).trim() || "rw";
  } else throw new ConfigError(400, `docker.volumes[${i}] must be "source:target[:ro]" or {source, target, mode}`);
  source = expandHome(source.trim()); target = target.trim();
  if (!source || !target) throw new ConfigError(400, `docker.volumes[${i}]: source and target are both needed`);
  if (!isAbsolute(source) && !VOLUME_NAME.test(source)) throw new ConfigError(400, `docker.volumes[${i}]: source "${source}" must be an absolute path, ~/…, or a volume name`);
  if (!isAbsolute(target)) throw new ConfigError(400, `docker.volumes[${i}]: target "${target}" must be an absolute path in the container`);
  if (/[:,\n]/.test(source) || /[:,\n]/.test(target)) throw new ConfigError(400, `docker.volumes[${i}]: paths can't contain ":" or ","`);
  if (mode !== "ro" && mode !== "rw") throw new ConfigError(400, `docker.volumes[${i}]: mode must be "ro" or "rw"`);
  return { source, target, mode };
}

/** Docker settings from a request; null (or an empty image) = no container. */
export function parseDocker(v: unknown): DockerSettings | null {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(400, "docker must be an object: {image, volumes?, user?, network?, args?}");
  const o = v as any;
  const image = String(o.image ?? "").trim();
  if (!image) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,254}$/.test(image)) throw new ConfigError(400, `docker.image "${image}" doesn't look like an image reference`);
  const vols = o.volumes ?? [];
  if (!Array.isArray(vols)) throw new ConfigError(400, "docker.volumes must be an array");
  const user = String(o.user ?? "").trim();
  if (user && user !== "host" && !/^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(user)) throw new ConfigError(400, `docker.user "${user}": "host", a name or uid[:gid]`);
  const network = String(o.network ?? "").trim();
  if (network && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network)) throw new ConfigError(400, `docker.network "${network}" is not a network name`);
  const args = o.args ?? [];
  if (!Array.isArray(args) || !args.every((a: unknown) => typeof a === "string")) throw new ConfigError(400, "docker.args must be an array of strings");
  return { image, volumes: vols.map(parseVolume), user, network, args };
}

/** Validate a config body (fields left out keep `cur`'s values). */
export function parseConfig(b: any, cur?: RunConfig): Omit<RunConfig, "name"> {
  const str = (k: string, def: string) => (b?.[k] === undefined || b[k] === null ? def : String(b[k]));
  return {
    description: str("description", cur?.description ?? "").trim(),
    instructions: str("instructions", cur?.instructions ?? "").replace(/\s+$/, ""),
    env: b?.env === undefined ? cur?.env ?? {} : parseEnvInput(b.env, cur?.env),
    docker: b?.docker === undefined ? cur?.docker ?? null : parseDocker(b.docker),
  };
}

export const rowToConfig = (r: ConfigRow): RunConfig => ({
  name: r.name, description: r.description, instructions: r.instructions,
  env: JSON.parse(r.env || "{}"), docker: r.docker ? parseDocker(JSON.parse(r.docker)) : null,
});

export function getConfig(name: string): RunConfig {
  const r = db.query<ConfigRow, [string]>("SELECT * FROM configs WHERE name = ?").get(name);
  if (!r) throw new ConfigError(404, `unknown config "${name}"`);
  return rowToConfig(r);
}

/** For the API: everything but the env's values. */
export function configOut(r: ConfigRow) {
  const c = rowToConfig(r);
  const used = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM workflows WHERE config = ?").get(r.name)!.n;
  return { id: r.id, ...c, env: maskEnv(c.env), env_keys: Object.keys(c.env), workflows: used, created_at: r.created_at, updated_at: r.updated_at };
}

// ---------------------------------------------------------------- applying a config to a command

/** Args that already say what the system prompt is: the config's instructions are then left out. */
const PICKS_SYSTEM_PROMPT = /^--(append-)?system-prompt(-file)?(=|$)/;

/**
 * Add the config's instructions to an agent's argv (the template part, so a restart doesn't count them as extra
 * args): claude `--append-system-prompt`, codex `-c developer_instructions=…`. Other types use `{instructions}` in
 * their templates (substituted by buildCommand) or read LOFIWAVE_INSTRUCTIONS. Returns the args to add.
 */
export function instructionArgs(agent: string, instructions: string, args: string[]): string[] {
  if (!instructions.trim()) return [];
  if (agent === "claude") return args.some((a) => PICKS_SYSTEM_PROMPT.test(a)) ? [] : ["--append-system-prompt", instructions];
  // A TOML basic string: JSON's escapes are valid TOML.
  if (agent === "codex") return args.some((a) => /^developer_instructions\s*=/.test(a)) ? [] : ["-c", `developer_instructions=${JSON.stringify(instructions)}`];
  return [];
}

/** A container name for a run: unique even across several lofiwaves on one docker. */
export const containerName = () => `lofiwave-${randomBytes(5).toString("hex")}`;

/**
 * The `docker run` argv that runs `command args` in the config's image: the run's folder mounted at the same path
 * (and the working dir), the config's volumes, and the environment passed by name only (`-e KEY`: docker reads the
 * value from its own environment, so secrets never appear in the argv, the run record or the log).
 */
export function dockerArgv(d: DockerSettings, o: { name: string; cwd: string; command: string; args: string[]; envKeys: string[]; interactive: boolean; uid?: string }): string[] {
  const user = d.user === "host" ? o.uid ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` : d.user;
  return [
    "run", "--rm", "--init", "--name", o.name,
    // A tty for the tmux pane's TUI; a headless run's stdin is closed anyway.
    ...(o.interactive ? ["-it"] : []),
    "-w", o.cwd, "-v", `${o.cwd}:${o.cwd}`,
    ...d.volumes.flatMap((v) => ["-v", `${v.source}:${v.target}${v.mode === "ro" ? ":ro" : ""}`]),
    ...(user ? ["--user", user] : []),
    ...(d.network ? ["--network", d.network] : []),
    ...o.envKeys.flatMap((k) => ["-e", k]),
    ...d.args,
    d.image, o.command, ...o.args,
  ];
}

// ---------------------------------------------------------------- is docker usable here

let dockerCache: { at: number; v: DockerStatus } | null = null;
export type DockerStatus = { available: boolean; path: string | null; version?: string; error?: string };

/** Is docker installed, and is its daemon answering? Cached for 20 s (a `docker version` takes a moment). */
export async function dockerStatus(fresh = false): Promise<DockerStatus> {
  if (!fresh && dockerCache && Date.now() - dockerCache.at < 20_000) return dockerCache.v;
  const path = Bun.which("docker");
  let v: DockerStatus;
  if (!path) v = { available: false, path: null, error: "docker is not installed on this machine (no `docker` on PATH)" };
  else {
    try {
      const p = Bun.spawn([path, "version", "--format", "{{.Server.Version}}"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 8000);
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      v = code === 0 && out.trim()
        ? { available: true, path, version: out.trim() }
        : { available: false, path, error: `docker is installed but its daemon isn't answering: ${(err.trim().split("\n").pop() || `exit ${code}`).slice(0, 300)}` };
    } catch (e: any) {
      v = { available: false, path, error: `could not run docker: ${e?.message ?? e}` };
    }
  }
  dockerCache = { at: Date.now(), v };
  return v;
}

/** Stop and remove a run's container (best effort): `docker run -t` doesn't pass a SIGTERM on to it. */
export async function removeContainer(name: string) {
  const path = Bun.which("docker");
  if (!path || !name) return;
  try { await Bun.spawn([path, "rm", "-f", name], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited; } catch { /* gone already */ }
}
