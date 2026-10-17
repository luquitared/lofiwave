/**
 * The `e2b` run target: each run gets its own E2B sandbox (a Firecracker microVM), and an interactive run's agent
 * runs in a PTY there that the browser terminal drives like a tmux one. No SDK: the control plane is REST
 * (`api.e2b.app`, X-API-Key) and the sandbox's own `envd` daemon speaks Connect-RPC (src/connect.ts) plus a small
 * HTTP files API. Wire formats follow E2B's open-source SDK (spec/envd/process/process.proto, spec/openapi.yml).
 *
 * A run: create sandbox → (clone repo) → upload inputs → pre-accept claude's trust/onboarding prompts → start the
 * agent (in a PTY with the tag `lofiwave-<run>`, so a restarted console can find it again) → follow its output →
 * when it exits, copy its transcript and `out/` folder back here → kill (or pause) the sandbox.
 */
import { join, relative, resolve, sep } from "node:path";
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { serverStream, unary, ConnectError } from "./connect";
import { VtScreen } from "./vtscreen";
import { TargetError, type E2BConfig } from "./targets";

export const ENVD_PORT = 49983;
const SANDBOX_USER = "user";

const apiBase = () => (process.env.E2B_API_URL || `https://api.${process.env.E2B_DOMAIN || "e2b.app"}`).replace(/\/$/, "");

export type SandboxInfo = { sandboxID: string; envdAccessToken?: string; domain?: string | null; envdVersion?: string; templateID?: string };
export type SandboxState = { sandboxID: string; state: string; endAt?: string; templateID?: string };

/** The E2B control plane: sandboxes are created, resumed, paused and killed here. */
export class E2BApi {
  constructor(private key: string, private base = apiBase()) {}

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; data: any; text: string }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "X-API-Key": this.key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, data, text };
  }
  private fail(what: string, r: { status: number; data: any; text: string }) {
    return new TargetError(r.status === 401 || r.status === 403 ? 400 : 502, `E2B: ${what} failed (HTTP ${r.status}): ${r.data?.message ?? r.text.trim().slice(0, 200)}`);
  }

  async create(body: Record<string, unknown>): Promise<SandboxInfo> {
    let r = await this.req("POST", "/v2/sandboxes", body);
    if (r.status === 404 || r.status === 405) r = await this.req("POST", "/sandboxes", { ...body, secure: true });
    if (!r.ok) throw this.fail("creating a sandbox", r);
    return r.data;
  }
  /** Connect to a sandbox, resuming it if it is paused, and set its time to live. Null when it no longer exists. */
  async connect(id: string, timeoutSec: number): Promise<SandboxInfo | null> {
    let r = await this.req("POST", `/v2/sandboxes/${encodeURIComponent(id)}/connect`, { timeout: timeoutSec });
    if (r.status === 404 || r.status === 405) r = await this.req("POST", `/sandboxes/${encodeURIComponent(id)}/connect`, { timeout: timeoutSec });
    if (r.status === 404) return null;
    if (!r.ok) throw this.fail("connecting to the sandbox", r);
    return r.data;
  }
  async get(id: string): Promise<SandboxState | null> {
    const r = await this.req("GET", `/sandboxes/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw this.fail("reading the sandbox", r);
    return r.data;
  }
  async kill(id: string): Promise<void> {
    const r = await this.req("DELETE", `/sandboxes/${encodeURIComponent(id)}`);
    if (!r.ok && r.status !== 404) throw this.fail("killing the sandbox", r);
  }
  /** Pause (memory + disk). False when it was already paused. */
  async pause(id: string): Promise<boolean> {
    const r = await this.req("POST", `/sandboxes/${encodeURIComponent(id)}/pause`, {});
    if (r.status === 409) return false;
    if (!r.ok) throw this.fail("pausing the sandbox", r);
    return true;
  }
  async setTimeout(id: string, timeoutSec: number): Promise<void> {
    const r = await this.req("POST", `/sandboxes/${encodeURIComponent(id)}/timeout`, { timeout: timeoutSec });
    if (!r.ok) throw this.fail("extending the sandbox", r);
  }
  async list(): Promise<SandboxState[]> {
    const r = await this.req("GET", "/sandboxes");
    if (!r.ok) throw this.fail("listing sandboxes", r);
    return r.data ?? [];
  }
}

// ---------------------------------------------------------------- envd (inside the sandbox)

export type ProcEvent =
  | { kind: "start"; pid: number }
  | { kind: "data"; stream: "stdout" | "stderr" | "pty"; data: Uint8Array }
  | { kind: "end"; code: number | null; status: string; error: string }
  | { kind: "keepalive" };

/** A Start/Connect stream message (`{event: {start|data|end|keepalive}}`, proto3 JSON: bytes as base64, zero values left out). */
export function parseProcEvent(msg: any): ProcEvent | null {
  const e = msg?.event ?? msg;
  if (!e || typeof e !== "object") return null;
  if (e.start) return { kind: "start", pid: Number(e.start.pid ?? 0) };
  if (e.data) {
    for (const k of ["pty", "stdout", "stderr"] as const) if (typeof e.data[k] === "string") return { kind: "data", stream: k, data: new Uint8Array(Buffer.from(e.data[k], "base64")) };
    return null;
  }
  if (e.end) {
    const status = String(e.end.status ?? "");
    const raw = e.end.exitCode ?? e.end.exit_code ?? 0;
    // Killed by a signal: no exit code to report (envd says "signal: killed" and -1).
    const code = Number(raw) === -1 || (/^signal:/.test(status) && !e.end.exited) ? null : Number(raw);
    // envd repeats the status as the error ("exit status 3"); only a different one says something more.
    const error = String(e.end.error ?? "");
    return { kind: "end", code, status, error: error === status ? "" : error };
  }
  if (e.keepalive) return { kind: "keepalive" };
  return null;
}

export type StartProc = { cmd: string; args: string[]; envs?: Record<string, string>; cwd?: string; tag?: string; pty?: { cols: number; rows: number } };

/** The StartRequest message for a process. */
export function startRequest(p: StartProc) {
  return {
    process: { cmd: p.cmd, args: p.args, envs: p.envs ?? {}, ...(p.cwd ? { cwd: p.cwd } : {}) },
    ...(p.pty ? { pty: { size: { cols: p.pty.cols, rows: p.pty.rows } } } : {}),
    ...(p.tag ? { tag: p.tag } : {}),
    // A PTY needs input; a plain command gets none (claude -p would otherwise wait on stdin).
    stdin: Boolean(p.pty),
  };
}

const b64 = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64");

/** The sandbox's envd: processes (Connect-RPC) and files (HTTP). */
export class Envd {
  readonly base: string;
  private headers: Record<string, string>;

  constructor(sb: SandboxInfo) {
    const domain = sb.domain || process.env.E2B_DOMAIN || "e2b.app";
    this.base = (process.env.E2B_SANDBOX_URL || `https://${ENVD_PORT}-${sb.sandboxID}.${domain}`).replace(/\/$/, "");
    this.headers = {
      "E2b-Sandbox-Id": sb.sandboxID,
      "E2b-Sandbox-Port": String(ENVD_PORT),
      // Run things as the template's regular user (envd before 0.4.0 needs it named; later ones default to it).
      Authorization: `Basic ${b64(`${SANDBOX_USER}:`)}`,
      ...(sb.envdAccessToken ? { "X-Access-Token": sb.envdAccessToken } : {}),
    };
  }

  /** Start a process and stream its events. With a tag it can be found again by `connectProc`. */
  start(p: StartProc, signal?: AbortSignal) {
    return serverStream(this.base, "process.Process/Start", startRequest(p), { headers: { ...this.headers, "Keepalive-Ping-Interval": "50" }, signal });
  }
  /** Re-attach to a running process's event stream (output from now on). */
  connectProc(sel: { tag: string } | { pid: number }, signal?: AbortSignal) {
    return serverStream(this.base, "process.Process/Connect", { process: sel }, { headers: { ...this.headers, "Keepalive-Ping-Interval": "50" }, signal });
  }
  async list(): Promise<{ pid: number; tag?: string }[]> {
    const r = await unary(this.base, "process.Process/List", {}, { headers: this.headers });
    return (r.processes ?? []).map((p: any) => ({ pid: Number(p.pid), tag: p.tag }));
  }
  sendInput(pid: number, data: Uint8Array | string, pty = true) {
    return unary(this.base, "process.Process/SendInput", { process: { pid }, input: pty ? { pty: b64(data) } : { stdin: b64(data) } }, { headers: this.headers });
  }
  resize(pid: number, cols: number, rows: number) {
    return unary(this.base, "process.Process/Update", { process: { pid }, pty: { size: { cols, rows } } }, { headers: this.headers });
  }
  signal(pid: number, sig: "SIGNAL_SIGTERM" | "SIGNAL_SIGKILL") {
    return unary(this.base, "process.Process/SendSignal", { process: { pid }, signal: sig }, { headers: this.headers });
  }

  /** Run a bash script to the end (`args` become $1…, never parsed by the shell); stdout/stderr collected. */
  async exec(script: string, args: string[] = [], o: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 120_000);
    const out: Buffer[] = [], err: Buffer[] = [];
    try {
      for await (const m of this.start({ cmd: "/bin/bash", args: ["-l", "-c", script, "lofiwave", ...args], envs: o.envs, cwd: o.cwd }, ctl.signal)) {
        const ev = parseProcEvent(m);
        if (ev?.kind === "data") (ev.stream === "stderr" ? err : out).push(Buffer.from(ev.data));
        else if (ev?.kind === "end") return { code: ev.code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") || ev.error };
      }
      return { code: null, stdout: Buffer.concat(out).toString("utf8"), stderr: "the command's stream ended early" };
    } finally { clearTimeout(timer); }
  }

  private fileUrl(path: string) {
    const u = new URL(this.base + "/files");
    u.searchParams.set("path", path);
    u.searchParams.set("username", SANDBOX_USER);
    return u.toString();
  }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([typeof data === "string" ? data : new Uint8Array(data)]), path);
    const { Authorization: _a, ...h } = this.headers;
    const res = await fetch(this.fileUrl(path), { method: "POST", headers: h, body: form, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`upload of ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  /** A file's bytes, or null when it doesn't exist. */
  async readFile(path: string): Promise<Uint8Array | null> {
    const { Authorization: _a, ...h } = this.headers;
    const res = await fetch(this.fileUrl(path), { headers: h, signal: AbortSignal.timeout(300_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`download of ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

// ---------------------------------------------------------------- the live terminal of a run

type Viewer = { send(b: Uint8Array): void; close(reason: string): void };
const REPLAY_BYTES = 512 * 1024;

/**
 * An interactive E2B run's terminal on this side: output fans out to every browser terminal open on it, a headless
 * screen (VtScreen) keeps the text for `GET /screen` and the log, and input from any viewer goes to the one PTY.
 */
export class E2BTerm {
  readonly screen: VtScreen;
  readonly viewers = new Set<Viewer>();
  pid = 0;
  envd: Envd | null = null;
  paused = false;
  lastActivity = Date.now();
  private ring: Uint8Array[] = [];
  private ringBytes = 0;
  private pending: Uint8Array[] = [];
  private flushing: Promise<void> | null = null;
  /** Set by the run: resumes a paused sandbox (resolves once its PTY is reachable again). */
  resume: () => Promise<void> = async () => {};

  constructor(public runId: number, public cols = 120, public rows = 40) {
    this.screen = new VtScreen(cols, rows);
  }

  output(b: Uint8Array) {
    this.lastActivity = Date.now();
    this.screen.write(b);
    this.ring.push(b); this.ringBytes += b.length;
    while (this.ringBytes > REPLAY_BYTES && this.ring.length > 1) this.ringBytes -= this.ring.shift()!.length;
    for (const v of this.viewers) v.send(b);
  }

  /** Recent raw output, for a viewer that just opened (the TUI then redraws on the resize it sends). */
  replay(): Uint8Array { return Buffer.concat(this.ring); }

  /** Queue input; sends go out one at a time and in order, batching whatever piled up meanwhile. */
  input(data: Uint8Array | string): Promise<void> {
    this.lastActivity = Date.now();
    this.pending.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    if (!this.flushing) {
      this.flushing = (async () => {
        try {
          while (this.pending.length) {
            if (this.paused) await this.resume();
            const batch = Buffer.concat(this.pending.splice(0));
            if (!this.envd || !this.pid) throw new Error("the sandbox terminal isn't up yet");
            await this.envd.sendInput(this.pid, batch, true);
          }
        } finally { this.flushing = null; }
      })();
    }
    return this.flushing;
  }

  async resize(cols: number, rows: number, force = false) {
    if (!force && cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.screen.resize(cols, rows);
    if (this.envd && this.pid && !this.paused) await this.envd.resize(this.pid, cols, rows).catch(() => {});
  }

  /** Make the TUI repaint (a new viewer has only the recent bytes): a size change, then back. */
  async redraw() {
    if (!this.envd || !this.pid || this.paused) return;
    await this.envd.resize(this.pid, this.cols, Math.max(5, this.rows - 1)).catch(() => {});
    await Bun.sleep(60);
    await this.envd.resize(this.pid, this.cols, this.rows).catch(() => {});
  }

  closeAll(reason: string) { for (const v of this.viewers) v.close(reason); this.viewers.clear(); }
}

/** Live terminals of interactive E2B runs, by run id. */
export const e2bTerms = new Map<number, E2BTerm>();

// ---------------------------------------------------------------- running on a sandbox

export type E2BRunOpts = {
  runId: number;
  c: E2BConfig;
  command: string;
  args: string[];
  /** The run's env (type + request); goes into the sandbox with the target's env and the auth vars it forwards. */
  env: Record<string, string>;
  interactive: boolean;
  /** A claude session id passed with --session-id: its transcript is copied back at the end. */
  sessionId?: string;
  /** A local folder uploaded to `<workdir>/in/` before the agent starts. */
  inputDir?: string;
  /** Where the sandbox's `<workdir>/out/` is copied at the end. */
  outDir: string;
  /** Never forwarded into the sandbox (the console's own token). */
  forbiddenValues: string[];
  write: (s: string) => void;
  /** Merge these into the run's meta.e2b and save it. */
  onMeta: (patch: Record<string, unknown>) => void;
  saveTranscript: (sessionId: string, data: Buffer) => void;
  /** Re-attach to a run's sandbox after a console restart instead of creating one. */
  attach?: { sandboxId: string };
};

/** `failed`: it never got going (no key, sandbox couldn't be made, clone failed...). */
export type E2BHandle = { done: Promise<{ code: number | null; message: string; failed?: boolean }>; cancel: () => Promise<void> };

/** The sandbox env: the target's env, the auth vars it forwards from this machine's env, and the run's env. */
export function sandboxEnv(c: E2BConfig, runEnv: Record<string, string>, forbidden: string[], from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { ...c.env };
  for (const [to, local] of Object.entries(c.env_from)) { const v = from[local]; if (v) out[to] = v; }
  Object.assign(out, runEnv);
  for (const k of ["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_URL", "AGENT_CONSOLE_RUN_ID", "AUTH_TOKEN"]) delete out[k];
  for (const [k, v] of Object.entries(out)) if (v && forbidden.includes(v)) delete out[k];
  return out;
}

/**
 * Pre-answers claude's first-run questions for `$1` (the folder it works in): onboarding, trusting the folder, the
 * bypass-permissions warning, and using the ANTHROPIC_API_KEY it finds in its env. Node is there wherever claude is.
 */
const TRUST_SCRIPT = `
command -v node >/dev/null 2>&1 || { echo "no node in the sandbox; claude may ask to trust the folder" >&2; exit 0; }
node -e '
const fs = require("fs"), path = require("path"), os = require("os");
const home = os.homedir(), dir = process.argv[1];
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const f = path.join(home, ".claude.json"), j = rd(f);
j.hasCompletedOnboarding = true; j.bypassPermissionsModeAccepted = true;
j.projects = j.projects || {};
j.projects[dir] = Object.assign({}, j.projects[dir], { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
const k = process.env.ANTHROPIC_API_KEY;
if (k) { const r = j.customApiKeyResponses = j.customApiKeyResponses || { approved: [], rejected: [] }; r.approved = r.approved || []; if (!r.approved.includes(k.slice(-20))) r.approved.push(k.slice(-20)); }
fs.writeFileSync(f, JSON.stringify(j, null, 2));
const sd = path.join(home, ".claude"); fs.mkdirSync(sd, { recursive: true });
const sf = path.join(sd, "settings.json"), s = rd(sf); s.skipDangerousModePermissionPrompt = true;
fs.writeFileSync(sf, JSON.stringify(s, null, 2));
' "$1"`;

const MAX_IN_FILES = 500, MAX_IN_BYTES = 200 * 1024 * 1024;
const MAX_OUT_FILES = 1000;

function listLocal(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
      if (out.length > MAX_IN_FILES) throw new Error(`more than ${MAX_IN_FILES} files in ${dir}`);
    }
  };
  walk(dir);
  return out;
}

/** A path the sandbox listed, kept only when it stays inside `root` here. */
export function safeLocal(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const p = resolve(root, rel);
  return p.startsWith(resolve(root) + sep) ? p : null;
}

export function runE2B(o: E2BRunOpts): E2BHandle {
  const c = o.c;
  const key = process.env[c.api_key_env]?.trim();
  if (!key) throw new TargetError(400, `${c.api_key_env} is not set in lofiwave's environment; e2b targets need an E2B API key`);
  const api = new E2BApi(key);
  const tag = `lofiwave-${o.runId}`;
  const workdir = c.workdir;
  const term = o.interactive ? new E2BTerm(o.runId) : null;
  if (term) e2bTerms.set(o.runId, term);

  let sb: SandboxInfo | null = null;
  let envd: Envd | null = null;
  let pid = 0;
  let stopping = false, killed = false, paused = false, finished = false;
  let beforeStop = "";
  let ctl = new AbortController();
  // While paused the follow loop sleeps on `wake`; resume() wakes it and waits on `resumed` until the PTY is back.
  let resumeAsked = false;
  let wake: (() => void) | null = null;
  let resumed: { promise: Promise<void>; resolve: () => void } | null = null;
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  const write = o.write;

  const setEnvd = (info: SandboxInfo) => { sb = info; envd = new Envd(info); if (term) term.envd = envd; };

  /** Resume a paused sandbox (on a viewer opening it, keys sent to it, or a stop). */
  const resume = async () => {
    if (!paused) return;
    resumeAsked = true;
    if (!resumed) { let r!: () => void; resumed = { promise: new Promise<void>((res) => (r = res)), resolve: r }; }
    const w = resumed;
    wake?.();             // the follow loop does the resuming
    ctl.abort();          // (or is still on the old stream: end it)
    await w.promise;
  };
  if (term) term.resume = resume;

  const setup = async (): Promise<AsyncGenerator<any>> => {
    if (o.attach) {
      const info = await api.connect(o.attach.sandboxId, c.timeout_sec);
      if (!info) throw new TargetError(410, `sandbox ${o.attach.sandboxId} no longer exists`);
      setEnvd(info);
      write(`# e2b: console restarted; re-attached to sandbox ${info.sandboxID}`);
      return envd!.connectProc({ tag }, ctl.signal);
    }
    write(`# e2b: creating a sandbox from template "${c.template}"`);
    const info = await api.create({
      templateID: c.template,
      timeout: c.timeout_sec,
      envVars: sandboxEnv(c, o.env, o.forbiddenValues),
      metadata: { lofiwave_run: String(o.runId) },
    });
    setEnvd(info);
    o.onMeta({ sandbox_id: info.sandboxID, template: c.template });
    write(`# e2b: sandbox ${info.sandboxID} is up`);
    if (stopping) throw new Error("stopped before the agent started");
    const e = envd!;
    if (c.repo) {
      write(`# e2b: cloning ${c.repo}`);
      const r = await e.exec('git clone --depth 1 "$1" "$2"', [c.repo, workdir], { timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    } else {
      const r = await e.exec('mkdir -p "$1"', [workdir]);
      if (r.code !== 0) throw new Error(`couldn't make ${workdir}: ${r.stderr.trim()}`);
    }
    if (o.inputDir) {
      const files = listLocal(o.inputDir);
      let total = 0;
      for (const f of files) {
        total += statSync(f).size;
        if (total > MAX_IN_BYTES) throw new Error(`input folder is over ${MAX_IN_BYTES >> 20}MB`);
        await e.writeFile(`${workdir}/in/${relative(o.inputDir, f).split(sep).join("/")}`, readFileSync(f));
      }
      write(`# e2b: uploaded ${files.length} file(s) from ${o.inputDir} to ${workdir}/in/`);
    }
    if (/(^|\/)claude$/.test(o.command)) {
      const r = await e.exec(TRUST_SCRIPT, [workdir]);
      if (r.code !== 0) write(`# e2b: couldn't pre-accept claude's prompts: ${r.stderr.trim()}`);
    }
    write(`# e2b: starting ${o.command}${o.interactive ? " in a PTY (open its terminal from Sessions)" : ""}`);
    // exec through a login shell so the template's PATH (npm globals) applies; argv is passed as-is, never parsed.
    return e.start({
      cmd: "/bin/bash", args: ["-l", "-c", 'exec "$0" "$@"', o.command, ...o.args],
      envs: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      cwd: workdir, tag,
      ...(term ? { pty: { cols: term.cols, rows: term.rows } } : {}),
    }, ctl.signal);
  };

  /** Ask the agent to stop (SIGTERM, then SIGKILL), and kill the sandbox if it still won't end. */
  const cancel = async () => {
    if (stopping) return;
    stopping = true;
    if (paused) await resume().catch(() => {});
    // claude clears its screen on the way out: keep what it showed before being stopped.
    if (term) beforeStop = term.screen.text(2000);
    if (envd && pid) {
      await envd.signal(pid, "SIGNAL_SIGTERM").catch(() => {});
      setTimeout(() => { if (!finished && envd && pid) envd.signal(pid, "SIGNAL_SIGKILL").catch(() => {}); }, 8000);
    }
    setTimeout(async () => {
      if (finished) return;
      killed = true; ctl.abort();
      if (sb) await api.kill(sb.sandboxID).catch(() => {});
    }, sb ? 25_000 : 0);
  };

  /** Every minute: keep the sandbox's time to live ahead of us while the run is active; pause or stop it when idle. */
  const keeper = setInterval(async () => {
    if (!sb || paused || stopping) return;
    const idleFor = Date.now() - Math.max(lastActivity, term?.lastActivity ?? 0);
    if (c.idle_sec > 0 && idleFor >= c.idle_sec * 1000 && !(term && term.viewers.size)) {
      if (c.idle_action === "pause" && term) {
        write(`# e2b: idle for ${Math.round(idleFor / 1000)}s; pausing the sandbox (it resumes when its terminal is opened)`);
        paused = true; if (term) term.paused = true;
        o.onMeta({ paused: true });
        try { await api.pause(sb.sandboxID); } catch (e: any) { write(`# e2b: pause failed: ${e?.message ?? e}`); paused = false; if (term) term.paused = false; o.onMeta({ paused: false }); return; }
        ctl.abort();
        return;
      }
      write(`# e2b: idle for ${Math.round(idleFor / 1000)}s; stopping`);
      cancel();
      return;
    }
    await api.setTimeout(sb.sandboxID, c.timeout_sec).catch((e) => write(`# e2b: couldn't extend the sandbox: ${e?.message ?? e}`));
  }, 60_000);

  const done = (async (): Promise<{ code: number | null; message: string; failed?: boolean }> => {
    let code: number | null = null, message = "", gone = false, failed = false;
    try {
      let events: AsyncGenerator<any>;
      try { events = await setup(); }
      catch (e: any) {
        if (e instanceof TargetError && e.status === 410) { gone = true; return { code: null, message: e.message }; }
        throw e;
      }
      let misses = 0;
      outer: for (;;) {
        try {
          for await (const m of events) {
            const ev = parseProcEvent(m);
            if (!ev) continue;
            misses = 0;
            if (ev.kind === "start") { pid = ev.pid; if (term) term.pid = pid; o.onMeta({ pid }); if (term) term.resize(term.cols, term.rows, true); }
            else if (ev.kind === "data") { touch(); if (ev.stream === "pty" && term) term.output(ev.data); else write(Buffer.from(ev.data).toString("utf8")); }
            else if (ev.kind === "end") { code = ev.code; message = ev.error || (ev.code === null ? ev.status : ""); break outer; }
          }
          throw new ConnectError("unavailable", "the process stream ended without an exit");
        } catch (e: any) {
          if (killed) { message = "the sandbox was killed"; gone = true; break; }
          const id = sb!.sandboxID;
          if (paused) {
            // Paused (idle): wait for someone to open its terminal (or send keys, or stop it), then resume.
            if (!resumeAsked && !stopping) {
              await new Promise<void>((res) => {
                const t = setInterval(() => { if (stopping) done(); }, 1000);
                const done = () => { clearInterval(t); wake = null; res(); };
                wake = done;
              });
            }
            resumeAsked = false;
            const w = resumed as { resolve: () => void } | null; resumed = null;
            write(`# e2b: resuming the sandbox`);
            const info = await api.connect(id, c.timeout_sec).catch((err) => { w?.resolve(); throw err; });
            if (!info) { message = "the paused sandbox no longer exists"; gone = true; w?.resolve(); break; }
            setEnvd(info);
            paused = false; if (term) term.paused = false; touch();
            o.onMeta({ paused: false });
            ctl = new AbortController();
            events = envd!.connectProc({ tag }, ctl.signal);
            // The stream is attached by the time its first message arrives; let the waiter go a moment later either way.
            setTimeout(() => { w?.resolve(); term?.redraw(); }, 500);
            continue;
          }
          const st = await api.get(id).catch(() => undefined);
          if (st === null) { message = "the sandbox is gone (killed outside lofiwave, or its time ran out)"; gone = true; break; }
          if (st?.state === "paused") { paused = true; if (term) term.paused = true; o.onMeta({ paused: true }); write("# e2b: the sandbox was paused"); continue; }
          if (++misses > 8) { message = `lost the sandbox's process stream: ${e?.message ?? e}`; break; }
          await Bun.sleep(Math.min(30_000, 1000 * 2 ** misses));
          ctl = new AbortController();
          events = envd!.connectProc({ tag }, ctl.signal);
        }
      }
    } catch (e: any) {
      message = e?.message ?? String(e);
      write(`# e2b: ${message}`);
      code = null;
      failed = !pid;
    } finally {
      clearInterval(keeper);
      finished = true;
    }
    if (term) {
      // Keep what it showed last as the run's record, like a tmux run's captured pane.
      const last = term.screen.text(2000);
      for (const text of beforeStop && beforeStop !== last ? [beforeStop, last] : [last]) if (text) write(text.replace(/\n{3,}/g, "\n\n") + "\n");
    }
    // (assigned in closures, so TypeScript can't follow them here)
    const box = sb as SandboxInfo | null, env = envd as Envd | null;
    if (!gone && box && env) await collect(env).catch((e) => write(`# e2b: couldn't copy results back: ${e?.message ?? e}`));
    if (!gone && box) {
      const id = box.sandboxID;
      if (c.on_exit === "pause") await api.pause(id).then(() => write(`# e2b: sandbox ${id} paused (kept; kill it in E2B when done)`)).catch((e) => write(`# e2b: pause failed: ${e?.message ?? e}`));
      else await api.kill(id).then(() => write(`# e2b: sandbox ${id} killed`)).catch((e) => write(`# e2b: couldn't kill sandbox ${id}: ${e?.message ?? e}`));
    }
    return { code, message, failed };
  })().catch((e) => ({ code: null, message: String(e?.message ?? e), failed: true })).finally(() => {
    if (term) { term.closeAll("session ended"); e2bTerms.delete(o.runId); }
  });

  /** Bring the transcript and out/ back. */
  async function collect(e: Envd) {
    if (o.sessionId) {
      const f = await e.exec('find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "$1.jsonl" 2>/dev/null | head -n 1', [o.sessionId]);
      const path = f.stdout.trim();
      const data = path ? await e.readFile(path) : null;
      if (data) o.saveTranscript(o.sessionId, Buffer.from(data));
      else write(`# e2b: no transcript for session ${o.sessionId} in the sandbox (claude never got as far as writing one)`);
    }
    const ls = await e.exec(`cd "$1" 2>/dev/null && [ -d out ] && find out -type f -size -51200k | head -n ${MAX_OUT_FILES + 1}`, [workdir]);
    const files = ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!files.length) return;
    let n = 0;
    for (const rel of files.slice(0, MAX_OUT_FILES)) {
      const local = safeLocal(o.outDir, rel.replace(/^out\//, ""));
      if (!local) continue;
      const data = await e.readFile(`${workdir}/${rel}`);
      if (!data) continue;
      mkdirSync(resolve(local, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(local, data, { mode: 0o600 });
      n++;
    }
    o.onMeta({ out_dir: o.outDir, out_files: n });
    write(`# e2b: copied ${n} file(s) from ${workdir}/out/ to ${o.outDir}${files.length > MAX_OUT_FILES ? ` (first ${MAX_OUT_FILES} only)` : ""}`);
  }

  return { done, cancel };
}

/** Is the key good and the API reachable? */
export async function checkE2B(c: E2BConfig): Promise<{ ok: boolean; running: number; error?: string }> {
  const key = process.env[c.api_key_env]?.trim();
  if (!key) return { ok: false, running: 0, error: `${c.api_key_env} is not set in lofiwave's environment` };
  try { return { ok: true, running: (await new E2BApi(key).list()).length }; }
  catch (e: any) { return { ok: false, running: 0, error: e?.message ?? String(e) }; }
}
