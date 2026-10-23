/**
 * Run targets: where a run executes. The default is this machine (no target). An `e2b` target runs each run in its
 * own E2B sandbox, with a live terminal (src/e2b.ts); it is the only kind so far.
 */
import { db, type TargetRow } from "./db";

export class TargetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const TARGET_KINDS = ["e2b"] as const;

export type E2BConfig = {
  template: string;          // an E2B template with the agent installed: "claude" is E2B's stock one
  api_key_env: string;       // the env var (in lofiwave's environment) holding the E2B API key
  workdir: string;           // the folder in the sandbox the agent works in (the repo is cloned here)
  repo: string;              // optional repo URL, cloned into workdir first
  env: Record<string, string>;      // literal env for the sandbox
  env_from: Record<string, string>; // SANDBOX_VAR -> env var on this machine, forwarded when set (auth for the agent)
  permission_mode: string;   // claude --permission-mode in the sandbox ('' = CLAUDE_PERMISSION_MODE, as for local runs)
  timeout_sec: number;       // the sandbox's time to live, renewed every minute while the run is active
  idle_sec: number;          // 0 = never; else after this long with no output or input (and no terminal open)...
  idle_action: "pause" | "stop"; // ...pause the sandbox (resumes when its terminal is opened) or end the run
  on_exit: "kill" | "pause"; // when the agent exits: kill the sandbox, or keep it paused to look at later
};
export type TargetConfig = E2BConfig;

export function getTarget(name: string): TargetRow {
  const t = db.query<TargetRow, [string]>("SELECT * FROM targets WHERE name = ?").get(name);
  if (!t) throw new TargetError(404, `unknown target "${name}"`);
  return t;
}

const str = (v: unknown, def = "") => (v === undefined || v === null ? def : String(v).trim());
function strMap(v: unknown, what: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new TargetError(400, `${what} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TargetError(400, `${what}: bad variable name "${k}"`);
    out[k] = String(val);
  }
  return out;
}

/** Validate a target's config for its kind (fields left out keep `cur`'s values). */
export function parseTargetConfig(kind: string, b: any, cur: any = {}): TargetConfig {
  if (kind !== "e2b") throw new TargetError(400, `kind must be one of: ${TARGET_KINDS.join(", ")}`);
  return parseE2BConfig(b, cur);
}

const DEFAULT_ENV_FROM = { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY", CLAUDE_CODE_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN" };
/** Never forwarded into a sandbox: the console's own credentials. */
const NEVER_FORWARD = new Set(["AUTH_TOKEN", "AGENT_CONSOLE_TOKEN", "PASSWORD"]);

export function parseE2BConfig(b: any, cur: Partial<E2BConfig> = {}): E2BConfig {
  const pick = (k: keyof E2BConfig, def: string) => (b?.[k] === undefined ? (cur[k] as string) ?? def : str(b[k]));
  const num = (k: keyof E2BConfig, def: number) => {
    const v = b?.[k] === undefined ? (cur[k] as number) ?? def : Number(b[k]);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new TargetError(400, `${k} must be a whole number of seconds`);
    return v;
  };
  const c: E2BConfig = {
    template: pick("template", "claude") || "claude",
    api_key_env: pick("api_key_env", "E2B_API_KEY") || "E2B_API_KEY",
    workdir: pick("workdir", "/home/user/work") || "/home/user/work",
    repo: pick("repo", ""),
    env: b?.env === undefined ? cur.env ?? {} : strMap(b.env, "env"),
    env_from: b?.env_from === undefined ? cur.env_from ?? { ...DEFAULT_ENV_FROM } : strMap(b.env_from, "env_from"),
    permission_mode: pick("permission_mode", ""),
    timeout_sec: num("timeout_sec", 3600),
    idle_sec: num("idle_sec", 0),
    idle_action: (pick("idle_action", "pause") || "pause") as E2BConfig["idle_action"],
    on_exit: (pick("on_exit", "kill") || "kill") as E2BConfig["on_exit"],
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,100}$/.test(c.template)) throw new TargetError(400, `template "${c.template}" doesn't look like an E2B template name or id`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.api_key_env)) throw new TargetError(400, "api_key_env must be an env var name");
  if (!c.workdir.startsWith("/")) throw new TargetError(400, "workdir must be an absolute path inside the sandbox");
  for (const [k, v] of Object.entries(c.env_from)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new TargetError(400, `env_from.${k}: "${v}" is not an env var name`);
    if (NEVER_FORWARD.has(v) || NEVER_FORWARD.has(k)) throw new TargetError(400, `env_from.${k}: lofiwave's own credentials are never sent into a sandbox`);
  }
  if (c.permission_mode && !/^[A-Za-z]+$/.test(c.permission_mode)) throw new TargetError(400, `permission_mode "${c.permission_mode}" is not a claude permission mode`);
  if (c.timeout_sec < 300 || c.timeout_sec > 86400) throw new TargetError(400, "timeout_sec must be between 300 and 86400 (E2B caps it by plan: 1h on Hobby, 24h on Pro)");
  if (c.idle_sec && c.idle_sec < 60) throw new TargetError(400, "idle_sec must be 0 (off) or at least 60");
  if (!["pause", "stop"].includes(c.idle_action)) throw new TargetError(400, 'idle_action must be "pause" or "stop"');
  if (!["kill", "pause"].includes(c.on_exit)) throw new TargetError(400, 'on_exit must be "kill" or "pause"');
  return c;
}

export function targetConfig(t: TargetRow): TargetConfig {
  return parseTargetConfig(t.kind, JSON.parse(t.config || "{}"));
}
export function e2bConfig(t: TargetRow): E2BConfig {
  if (t.kind !== "e2b") throw new TargetError(400, `target "${t.name}" is not an e2b target`);
  return parseE2BConfig(JSON.parse(t.config || "{}"));
}

/** Can this machine use the target? (for e2b: the key works and the API answers) */
export async function checkTarget(t: TargetRow): Promise<{ ok: boolean; running?: number; error?: string }> {
  const { checkE2B } = await import("./e2b");
  return checkE2B(e2bConfig(t));
}
