/**
 * Run targets: where a run executes. The default is this machine (no target). An `e2b` target runs each run in its
 * own E2B sandbox, with a live terminal (src/e2b.ts). A `cloud-run` target runs the
 * process headless as a Google Cloud Run Job, driven through the `gcloud` CLI with the machine's own login:
 * the job spec is written with `gcloud run jobs replace`, started with `gcloud run jobs execute`, followed with
 * `gcloud run jobs executions describe`, and its output is copied from Cloud Logging into the run's log.
 */
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { db, type TargetRow } from "./db";
import { config } from "./config";

export class TargetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const TARGET_KINDS = ["cloud-run", "e2b"] as const;

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
export type TargetConfig = CloudRunConfig | E2BConfig;

export type CloudRunConfig = {
  project: string;          // '' = gcloud's configured project
  region: string;
  image: string;            // a container image with the agent installed (e.g. claude, codex)
  service_account: string;  // '' = the project's default compute service account
  cpu: string;
  memory: string;
  workdir: string;          // working directory inside the container ('' = the image's)
  repo: string;             // optional git URL, cloned into workdir (or /workspace) before the command runs
  env: Record<string, string>;
  secrets: Record<string, string>; // ENV_NAME → Secret Manager secret, "name" or "name:version"
};

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
  if (kind === "e2b") return parseE2BConfig(b, cur);
  if (kind !== "cloud-run") throw new TargetError(400, `kind must be one of: ${TARGET_KINDS.join(", ")}`);
  return parseCloudRunConfig(b, cur);
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

function parseCloudRunConfig(b: any, cur: Partial<CloudRunConfig> = {}): CloudRunConfig {
  const pick = (k: keyof CloudRunConfig, def: string) => (b?.[k] === undefined ? (cur[k] as string) ?? def : str(b[k]));
  const c: CloudRunConfig = {
    project: pick("project", ""),
    region: pick("region", ""),
    image: pick("image", ""),
    service_account: pick("service_account", ""),
    cpu: pick("cpu", "2") || "2",
    memory: pick("memory", "4Gi") || "4Gi",
    workdir: pick("workdir", ""),
    repo: pick("repo", ""),
    env: b?.env === undefined ? cur.env ?? {} : strMap(b.env, "env"),
    secrets: b?.secrets === undefined ? cur.secrets ?? {} : strMap(b.secrets, "secrets"),
  };
  if (!c.region) throw new TargetError(400, "region is required (e.g. us-central1)");
  if (!/^[a-z]+-[a-z]+\d+$/.test(c.region)) throw new TargetError(400, `region "${c.region}" doesn't look like a Cloud Run region (e.g. us-central1)`);
  if (!c.image) throw new TargetError(400, "image is required: a container image with the agent installed");
  if (c.project && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c.project)) throw new TargetError(400, `project "${c.project}" is not a valid project id`);
  if (c.workdir && !c.workdir.startsWith("/")) throw new TargetError(400, "workdir must be an absolute path inside the container");
  for (const [k, s] of Object.entries(c.secrets)) if (!/^[A-Za-z0-9_-]+(:(latest|\d+))?$/.test(s)) throw new TargetError(400, `secrets.${k}: want "secret-name" or "secret-name:version"`);
  return c;
}

export function targetConfig(t: TargetRow): TargetConfig {
  return parseTargetConfig(t.kind, JSON.parse(t.config || "{}"));
}
export function cloudRunConfig(t: TargetRow): CloudRunConfig {
  if (t.kind !== "cloud-run") throw new TargetError(400, `target "${t.name}" is not a cloud-run target`);
  return parseCloudRunConfig(JSON.parse(t.config || "{}"));
}
export function e2bConfig(t: TargetRow): E2BConfig {
  if (t.kind !== "e2b") throw new TargetError(400, `target "${t.name}" is not an e2b target`);
  return parseE2BConfig(JSON.parse(t.config || "{}"));
}

// ---------------------------------------------------------------- gcloud

export function gcloudPath(): string | null { return Bun.which("gcloud"); }

async function gcloud(args: string[], c: CloudRunConfig): Promise<{ code: number; out: string; err: string }> {
  const full = [...args, "--quiet"];
  if (c.project) full.push("--project", c.project);
  const p = Bun.spawn(["gcloud", ...full], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

async function gcloudJson<T = any>(args: string[], c: CloudRunConfig): Promise<T> {
  const r = await gcloud([...args, "--format=json"], c);
  if (r.code !== 0) throw new TargetError(502, `gcloud ${args.slice(0, 3).join(" ")} failed: ${lastLine(r.err || r.out)}`);
  try { return JSON.parse(r.out || "null"); } catch { throw new TargetError(502, `gcloud ${args.slice(0, 3).join(" ")}: unexpected output`); }
}
const lastLine = (s: string) => s.split("\n").filter((l) => l.trim()).pop() ?? "";

/** Can this machine reach the target? (gcloud installed, logged in, project known, Cloud Run reachable in the region) */
export async function checkTarget(t: TargetRow): Promise<{ ok: boolean; project?: string; account?: string; running?: number; error?: string }> {
  if (t.kind === "e2b") { const { checkE2B } = await import("./e2b"); return checkE2B(e2bConfig(t)); }
  const c = cloudRunConfig(t);
  if (!gcloudPath()) return { ok: false, project: c.project, account: "", error: "gcloud is not installed on this machine (https://cloud.google.com/sdk/docs/install)" };
  const acct = await gcloud(["config", "get-value", "account"], c);
  const account = acct.out.split("\n").pop() ?? "";
  const project = c.project || (await gcloud(["config", "get-value", "project"], c)).out.split("\n").pop() || "";
  if (!account) return { ok: false, project, account, error: "gcloud has no logged-in account: run `gcloud auth login` on this machine" };
  if (!project) return { ok: false, project, account, error: "no project: set one on the target, or `gcloud config set project …`" };
  const list = await gcloud(["run", "jobs", "list", "--region", c.region, "--limit", "1", "--format=value(name)"], c);
  if (list.code !== 0) return { ok: false, project, account, error: lastLine(list.err) || "gcloud run jobs list failed" };
  return { ok: true, project, account };
}

// ---------------------------------------------------------------- running a job

/** A Cloud Run Job name: lowercase letters, digits and hyphens, starting with a letter, at most 63 characters. */
export function jobName(key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `lofiwave-${slug}`.slice(0, 63).replace(/-$/, "");
}

/**
 * Lines the container prints to hand the claude transcript back (the container can't reach the console, so it comes
 * through the logs): `@@lofiwave-transcript <session> begin <gz|raw> <sha256 of the file>`, then numbered chunks of
 * base64 (`<session> <n> <data>`, each well under Cloud Logging's 256KB per entry), then `<session> end <count>`.
 */
export const TRANSCRIPT_MARK = "@@lofiwave-transcript";

const EXPORT_TRANSCRIPT = `
f=$(find "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "$LW_SESSION_ID.jsonl" 2>/dev/null | head -n 1)
if [ -n "$f" ]; then
  if command -v gzip >/dev/null 2>&1; then enc=gz; else enc=raw; fi
  sum=$(sha256sum "$f" 2>/dev/null | cut -d " " -f 1)
  echo "${TRANSCRIPT_MARK} $LW_SESSION_ID begin $enc \${sum:--}"
  { if [ "$enc" = gz ]; then gzip -c "$f"; else cat "$f"; fi; } | base64 | tr -d "\\n" | fold -w 60000 |
    awk -v id="$LW_SESSION_ID" '{ print "${TRANSCRIPT_MARK} " id " " NR " " $0 } END { print "${TRANSCRIPT_MARK} " id " end " NR }'
else
  echo "lofiwave: no transcript for session $LW_SESSION_ID under \${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" >&2
fi`;

/**
 * The container's command line. Plain when there's nothing to add; otherwise a small sh wrapper that clones the target's
 * repo first, and/or (with LW_SESSION_ID set) runs the agent, passes a cancel or timeout's SIGTERM on to it (stopping
 * it within 3s), and then prints its transcript for the console to collect.
 */
function containerCommand(c: CloudRunConfig, command: string, args: string[], exportTranscript: boolean): { command: string[]; args: string[]; workdir: string } {
  if (!c.repo && !exportTranscript) return { command: [command], args, workdir: c.workdir };
  const dir = c.repo ? c.workdir || "/workspace" : "";
  // $0 = repo or "", $1 = dir to work in or "", the rest is the agent's argv: nothing from the prompt is ever parsed by the shell.
  const script = [
    'set -e',
    'if [ -n "$0" ]; then git clone --depth 1 "$0" "$1"; fi',
    'if [ -n "$1" ]; then cd "$1"; fi',
    'shift',
    'if [ -z "$LW_SESSION_ID" ]; then exec "$@"; fi',
    'set +e',
    '"$@" & pid=$!',
    'stopping=""',
    'trap \'stopping=1; kill -TERM "$pid" 2>/dev/null\' TERM INT',
    'wait "$pid"; code=$?',
    // Cancelled or timed out: Cloud Run SIGKILLs everything 10s after its SIGTERM, and the transcript still has to get
    // out. claude writes it as it goes, so give it 3s to quit cleanly, then stop it and send what's on disk.
    'if [ -n "$stopping" ]; then',
    '  echo "lofiwave: got SIGTERM; stopping the agent and sending its transcript" >&2',
    '  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 6 ]; do sleep 0.5; i=$((i + 1)); done',
    '  kill -KILL "$pid" 2>/dev/null',
    'fi',
    EXPORT_TRANSCRIPT,
    'exit $code',
  ].join("\n");
  return { command: ["sh", "-c", script], args: [c.repo, dir, command, ...args], workdir: c.repo ? "" : c.workdir };
}

function jobSpec(name: string, c: CloudRunConfig, o: { command: string; args: string[]; env: Record<string, string>; timeoutSec: number; sessionId?: string }) {
  const cmd = containerCommand(c, o.command, o.args, Boolean(o.sessionId));
  const env: any[] = Object.entries({ ...c.env, ...o.env, ...(o.sessionId ? { LW_SESSION_ID: o.sessionId } : {}) }).map(([k, v]) => ({ name: k, value: v }));
  for (const [k, s] of Object.entries(c.secrets)) {
    const [secret, version] = s.split(":");
    env.push({ name: k, valueFrom: { secretKeyRef: { name: secret, key: version || "latest" } } });
  }
  const container: any = { image: c.image, command: cmd.command, args: cmd.args, env, resources: { limits: { cpu: c.cpu, memory: c.memory } } };
  if (cmd.workdir) container.workingDir = cmd.workdir;
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    metadata: { name, labels: { "cloud.googleapis.com/location": c.region, "managed-by": "lofiwave" } },
    spec: {
      template: {
        metadata: { annotations: { "run.googleapis.com/execution-environment": "gen2" } },
        spec: {
          taskCount: 1,
          template: {
            spec: {
              containers: [container],
              maxRetries: 0,
              // Cloud Run requires a task timeout; "no timeout" locally becomes its 24h maximum.
              timeoutSeconds: String(o.timeoutSec > 0 ? Math.min(o.timeoutSec, 86400) : 86400),
              ...(c.service_account ? { serviceAccountName: c.service_account } : {}),
            },
          },
        },
      },
    },
  };
}

/** Two runs of one workflow must not swap the job spec between each other's replace and execute. */
const jobLocks = new Map<string, Promise<unknown>>();
function withJobLock<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(job) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  jobLocks.set(job, next);
  next.finally(() => { if (jobLocks.get(job) === next) jobLocks.delete(job); }).catch(() => {});
  return next;
}

export type CloudRunHandle = { job: string; execution: string; region: string; project: string; console_url: string };

/** Write the job spec and start one execution of it. */
export async function startCloudRunJob(
  target: TargetRow, o: { job: string; command: string; args: string[]; env: Record<string, string>; timeoutSec: number; runId: number; sessionId?: string },
  log: (line: string) => void,
): Promise<CloudRunHandle> {
  const c = cloudRunConfig(target);
  if (!gcloudPath()) throw new TargetError(400, "gcloud is not installed on this machine; cloud-run targets need it (https://cloud.google.com/sdk/docs/install)");
  return withJobLock(o.job, async () => {
    const file = join(config.dataDir, `job-${o.runId}.json`);  // JSON is YAML; data/ is owner-only (the spec may carry env values)
    writeFileSync(file, JSON.stringify(jobSpec(o.job, c, o), null, 2), { mode: 0o600 });
    try {
      log(`# cloud run: updating job ${o.job} in ${c.region}${c.project ? ` (${c.project})` : ""}, image ${c.image}`);
      const rep = await gcloud(["run", "jobs", "replace", file, "--region", c.region], c);
      if (rep.code !== 0) throw new TargetError(502, `gcloud run jobs replace failed: ${lastLine(rep.err || rep.out)}`);
    } finally { rmSync(file, { force: true }); }
    log(`# cloud run: starting an execution`);
    const ex = await gcloud(["run", "jobs", "execute", o.job, "--region", c.region, "--async", "--format=value(metadata.name)"], c);
    if (ex.code !== 0) throw new TargetError(502, `gcloud run jobs execute failed: ${lastLine(ex.err || ex.out)}`);
    const execution = ex.out.split("\n").pop()?.trim() || /Execution \[([a-z0-9-]+)\]/.exec(ex.err)?.[1] || "";
    if (!execution) throw new TargetError(502, `gcloud run jobs execute didn't say which execution it started: ${lastLine(ex.err || ex.out)}`);
    const project = c.project || (await gcloud(["config", "get-value", "project"], c)).out.split("\n").pop() || "";
    const console_url = `https://console.cloud.google.com/run/jobs/executions/details/${c.region}/${execution}?project=${encodeURIComponent(project)}`;
    log(`# cloud run: execution ${execution}\n# ${console_url}`);
    return { job: o.job, execution, region: c.region, project, console_url };
  });
}

type ExecState = { done: boolean; code: number | null; message: string };

async function executionState(c: CloudRunConfig, execution: string): Promise<ExecState | null> {
  let ex: any;
  try { ex = await gcloudJson(["run", "jobs", "executions", "describe", execution, "--region", c.region], c); } catch { return null; }
  const st = ex?.status ?? {};
  const completed = (st.conditions ?? []).find((x: any) => x.type === "Completed");
  // Cancelled counts as soon as it's asked for, while the container still has its 10s to wind down (and hand its
  // transcript over): it's over once the Completed condition settles.
  if (st.cancelledCount > 0) return completed?.status === "Unknown" ? { done: false, code: null, message: "" } : { done: true, code: null, message: completed?.message || "execution cancelled" };
  if (!st.completionTime && completed?.status !== "True" && completed?.status !== "False") return { done: false, code: null, message: "" };
  const ok = completed?.status === "True" || (st.succeededCount > 0 && !st.failedCount);
  return { done: true, code: ok ? 0 : 1, message: completed?.message ?? "" };
}

/** New log lines of an execution since `since` (RFC 3339), oldest first, skipping ids already seen. */
async function executionLogs(c: CloudRunConfig, h: CloudRunHandle, since: string, seen: Set<string>): Promise<{ lines: string[]; last: string }> {
  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${h.job}"`,
    `labels."run.googleapis.com/execution_name"="${h.execution}"`,
    since ? `timestamp>="${since}"` : "",
  ].filter(Boolean).join(" AND ");
  let entries: any[] = [];
  try { entries = await gcloudJson(["logging", "read", filter, "--order=asc", "--limit=1000", "--freshness=2d"], c) ?? []; } catch { return { lines: [], last: since }; }
  const lines: string[] = [];
  let last = since;
  for (const e of entries) {
    if (seen.has(e.insertId)) continue;
    seen.add(e.insertId);
    last = e.timestamp ?? last;
    const text = e.textPayload ?? e.jsonPayload?.message ?? (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "");
    // Cloud Run's own lifecycle lines go to the run_job audit/system logs; keep the container's stdout/stderr only.
    if (e.logName && !/run\.googleapis\.com%2F(stdout|stderr)$/.test(e.logName)) continue;
    lines.push(String(text).replace(/\n$/, ""));
  }
  return { lines, last };
}

/** Collects the transcript chunks out of the log lines (see TRANSCRIPT_MARK) and puts the file back together. */
export class TranscriptCatcher {
  private chunks = new Map<number, string>();
  private begin: { enc: string; sum: string } | null = null;
  private count = -1;
  constructor(public sessionId: string) {}

  /** True when the line was part of the transcript (and so isn't for the log). */
  take(line: string): boolean {
    if (!line.startsWith(TRANSCRIPT_MARK + " ")) return false;
    const [, id, what, a = "", b = ""] = line.split(" ", 5);
    if (id !== this.sessionId) return true;
    if (what === "begin") this.begin = { enc: a, sum: b };
    else if (what === "end") this.count = Number(a);
    else if (/^\d+$/.test(what)) this.chunks.set(Number(what), line.slice(TRANSCRIPT_MARK.length + id.length + what.length + 3));
    return true;
  }

  /** The container started handing it over, and not every chunk has arrived yet. */
  get pending(): boolean { return Boolean(this.begin) && !this.complete; }
  get complete(): boolean { return Boolean(this.begin) && this.count >= 0 && this.chunks.size >= this.count; }
  get started(): boolean { return Boolean(this.begin); }

  /** The transcript file, checked against the container's checksum. */
  result(): Buffer {
    if (!this.begin) throw new Error("the container didn't send a transcript");
    if (!this.complete) throw new Error(`transcript incomplete: ${this.chunks.size} of ${this.count < 0 ? "?" : this.count} chunks arrived`);
    let b64 = "";
    for (let i = 1; i <= this.count; i++) {
      const c = this.chunks.get(i);
      if (c === undefined) throw new Error(`transcript chunk ${i} is missing`);
      b64 += c;
    }
    const raw = Buffer.from(b64, "base64");
    const data = this.begin.enc === "gz" ? gunzipSync(raw) : raw;
    if (this.begin.sum !== "-" && createHash("sha256").update(data).digest("hex") !== this.begin.sum) throw new Error("transcript checksum doesn't match");
    return data;
  }
}

/**
 * Follow an execution until it ends, copying its output into the log (and transcript chunks into `catcher`).
 * Resolves with the exit code: 0 success, 1 failed, null cancelled or vanished.
 */
export async function followCloudRun(target: TargetRow, h: CloudRunHandle, write: (s: string) => void, opts: { pollMs?: number; resumeSince?: string; catcher?: TranscriptCatcher } = {}): Promise<{ code: number | null; message: string }> {
  const c = { ...cloudRunConfig(target), project: h.project || cloudRunConfig(target).project, region: h.region };
  const pollMs = opts.pollMs ?? 5000;
  const seen = new Set<string>();
  let since = opts.resumeSince ?? "";
  let misses = 0;
  const drain = async () => {
    const got = await executionLogs(c, h, since, seen);
    since = got.last;
    const lines = opts.catcher ? got.lines.filter((l) => !opts.catcher!.take(l)) : got.lines;
    if (lines.length) write(lines.join("\n") + "\n");
  };
  for (;;) {
    await Bun.sleep(pollMs);
    const st = await executionState(c, h.execution);
    await drain();
    if (!st) { if (++misses >= 12) return { code: null, message: "lost track of the execution (gcloud describe kept failing)" }; continue; }
    misses = 0;
    if (st.done) {
      // Cloud Logging lags a few seconds behind the container: give the last lines time to land, and a transcript
      // that has started arriving up to a minute more.
      for (let i = 0; i < 3 || (opts.catcher?.pending && i < 18); i++) { await Bun.sleep(4000); await drain(); }
      return { code: st.code, message: st.message };
    }
  }
}

export async function cancelCloudRun(target: TargetRow, h: CloudRunHandle): Promise<void> {
  const c = { ...cloudRunConfig(target), project: h.project || cloudRunConfig(target).project, region: h.region };
  const r = await gcloud(["run", "jobs", "executions", "cancel", h.execution, "--region", h.region], c);
  if (r.code !== 0 && !/already|not running|completed/i.test(r.err)) throw new TargetError(502, `gcloud run jobs executions cancel failed: ${lastLine(r.err)}`);
}
