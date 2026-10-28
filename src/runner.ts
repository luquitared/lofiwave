/**
 * Starts and tracks managed processes ("runs"). Every process started through the
 * console — ad-hoc or from a workflow — is a row in `runs` with its own log file.
 */
import { join, basename, dirname } from "node:path";
import { existsSync, statSync, openSync, readSync, closeSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { db, now, hydrate, type ProcessTypeRow, type RunRow, type WorkflowRow } from "./db";
import { config, logDir } from "./config";
import { killTree, pidAlive } from "./procs";
import { discoverCodexSession, codexRolloutPath, codexIndexReadable, findCodexThread, codexThreadTouched, claudeRegistry, claudeWebUrl, claudeTranscriptPath, claudeTranscriptHome, trustClaudeFolder } from "./agents";
import { openTerminalForTmux, macTabOf, typeIntoMacTab } from "./terminal";
import { actor } from "./auth";
import { ttyViewers } from "./tty";
import { chatSettingsPath } from "./chat/settings";
import { getTarget, TargetError, e2bConfig, type E2BConfig } from "./targets";
import { runE2B, sandboxEnv, e2bTerms, type E2BHandle } from "./e2b";
import { keyBytes } from "./vtscreen";
import { admissionBlocker } from "./capacity";
import { getConfig, ConfigError, instructionArgs, dockerArgv, dockerStatus, containerName, removeContainer, type RunConfig, type DockerSettings } from "./configs";

export class ApiError extends Error {
  /** `extra`: more fields for the JSON error body, next to `error`. */
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** In-memory handles for runs started by this server process. */
type LiveEntry = {
  pid: number;
  proc?: Bun.Subprocess;      // direct child (normal runs)
  tmux?: string;              // tmux session name (interactive runs)
  /** Runs on a remote target (no local process): stops it there. */
  cancel?: () => Promise<void>;
  error?: string;             // the run could not start on its target
  lostWhy?: string;           // why a run on a target ended without an exit code
  timer?: ReturnType<typeof setTimeout>;
  killedBy?: string;
  done: Promise<void>;
};
const live = new Map<number, LiveEntry>();
/** Runs startRun is still setting up (no pid yet, not in `live`): reconcileRuns must leave them alone. */
const starting = new Set<number>();

/**
 * What an agent run is doing, for the API (`activity`, `activity_since`) and the session list: working on a turn,
 * idle (its turn is over), waiting_input (a permission prompt, a question, the folder trust dialog), or done (ended).
 * Claude's own registry says it for claude; for other TUIs it is read off the screen.
 */
export type Activity = "working" | "idle" | "waiting_input" | "done";
type ActivityState = { activity: Activity; since: number; waiting_for?: string };
/** Last activity seen by each run's pane watcher. */
const activities = new Map<number, ActivityState>();
/** When each run was last sent a message (or started with a prompt): claude's registry says idle for a moment after one. */
const messagedAt = new Map<number, number>();
/** When someone last looked at a session through /screen (the simple view, or an API client): it counts as watching. */
const screenSeenAt = new Map<string, number>();

export function getType(name: string): ProcessTypeRow {
  const t = db.query<ProcessTypeRow, [string]>("SELECT * FROM process_types WHERE name = ?").get(name);
  if (!t) throw new ApiError(404, `unknown process type "${name}"`);
  return t;
}

export function getRun(id: number): RunRow {
  const r = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
  if (!r) throw new ApiError(404, `run ${id} not found`);
  return r;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export type StartOptions = {
  typeName: string;
  cwd: string;
  prompt?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  trigger: string;
  workflow?: WorkflowRow | null;
  timeoutSec?: number;
  /** Start inside a detached tmux session that stays open (an agent's own TUI, e.g. `claude` with Remote Control). */
  interactive?: boolean;
  /** Reopen this recorded session (uses the type's `resume_args`; implies interactive). */
  resumeSession?: string;
  /** Desktop terminal to attach to an interactive run: a name ("iterm", "kitty", ...), "auto", or "none". Defaults to $OPEN_TERMINAL. */
  terminal?: string;
  /**
   * Interactive claude runs: true ends the run once the agent has finished its work and sat idle (config.idleStopSec);
   * false keeps it open however long it idles; unset uses the default for agent runs (config.agentIdleStopSec).
   */
  stopWhenIdle?: boolean;
  /**
   * Run on this target (a targets.name) instead of this machine; `cwd` is ignored (the target says where). Headless,
   * except on an e2b target, where an interactive run gets a live terminal in its sandbox.
   */
  target?: string;
  /** e2b targets: a local folder uploaded to the sandbox's `<workdir>/in/` before the agent starts. */
  inputDir?: string;
  /** Set on the run's meta before launch: group, parent_run, and a queued run's started_by. */
  meta?: Record<string, any>;
  /** Launch into this queued run's row instead of inserting a new one (see src/jobs.ts). */
  runId?: number;
  /** Interactive claude runs: seconds idle (with nobody watching) before the run ends; 0 = never. Wins over stopWhenIdle. */
  idleStopSec?: number;
  /** Claude runs: mark the folder trusted first, and answer the trust dialog if it shows anyway (default true). */
  trust?: boolean;
  /** A run config (configs.name): its instructions, env and Docker settings apply to this run (src/configs.ts). */
  config?: string;
};

/** A run config by name, with ConfigErrors as ApiErrors. */
export function configOf(name: string): RunConfig {
  try { return getConfig(name); } catch (e) { if (e instanceof ConfigError) throw new ApiError(e.status, e.message); throw e; }
}

/** Stop a live entry: on its target, or its local process tree. */
function stopEntry(entry: LiveEntry, force: boolean): Promise<void> {
  return entry.cancel ? entry.cancel() : killTree(entry.pid, force);
}

/** Where a run is asked to leave its results (LOFIWAVE_OUT_DIR); GET /api/runs/:id/results lists it. */
export const outDirOf = (cwd: string) => join(cwd, "out");

/** Record (or refresh) an agent session on a run. Keyed by (run, session id) so a resumed session can belong to several runs. */
export function recordSession(runId: number, s: { session_id: string; agent?: string; cwd?: string; transcript_path?: string; model?: string; source?: string }) {
  db.prepare(
    `INSERT INTO sessions (run_id, session_id, agent, cwd, transcript_path, model, source, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, session_id) DO UPDATE SET
       cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
       transcript_path = CASE WHEN excluded.transcript_path != '' THEN excluded.transcript_path ELSE sessions.transcript_path END,
       model = CASE WHEN excluded.model != '' THEN excluded.model ELSE sessions.model END,
       source = CASE WHEN excluded.source != '' THEN excluded.source ELSE sessions.source END`,
  ).run(runId, s.session_id, s.agent || "claude", s.cwd ?? "", s.transcript_path ?? "", s.model ?? "", s.source ?? "", now());
}

/**
 * Record a session learned of on the side (claude's pid registry, a turn hook, a message found in its transcript). Unlike
 * recordSession it never overwrites what the session hook reported; it only fills in what is missing.
 */
export function adoptSession(runId: number, s: { session_id: string; agent?: string; cwd?: string; transcript_path?: string; source: string }) {
  db.prepare(
    `INSERT INTO sessions (run_id, session_id, agent, cwd, transcript_path, source, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, session_id) DO UPDATE SET
       cwd = CASE WHEN sessions.cwd = '' THEN excluded.cwd ELSE sessions.cwd END,
       transcript_path = CASE WHEN sessions.transcript_path = '' THEN excluded.transcript_path ELSE sessions.transcript_path END`,
  ).run(runId, s.session_id, s.agent || "claude", s.cwd ?? "", s.transcript_path ?? "", s.source, now());
}

/** What noteClaudeSession last recorded for each run, so the pane watcher only writes when it changes. */
const notedSessions = new Map<number, string>();
/**
 * Record the session a claude run's process is on, from claude's own pid registry (~/.claude/sessions/<pid>.json).
 * The SessionStart hook has to be installed globally and reach us once, at startup; when it doesn't, this still
 * records the session, and it follows a /clear or a resume to the new id. Returns the id.
 */
export function noteClaudeSession(runId: number, pid: number | null, cwd: string): string | null {
  const reg = pid ? claudeRegistry().byPid.get(pid) : undefined;
  if (!reg?.sessionId) return null;
  const at = reg.cwd || cwd;
  // Only where claude writes it for this folder: a session that hasn't written one yet would otherwise search every
  // project folder on each look. The path is filled in once the file exists.
  const home = claudeTranscriptHome(reg.sessionId, at);
  const path = existsSync(home) ? home : "";
  const key = `${reg.sessionId}\0${path}`;
  if (notedSessions.get(runId) !== key) {
    adoptSession(runId, { session_id: reg.sessionId, cwd: at, transcript_path: path, source: "registry" });
    notedSessions.set(runId, key);
  }
  return reg.sessionId;
}

export function tmuxPath(): string | null { return Bun.which("tmux"); }
export const tmuxSessionName = (runId: number) => `ac-${runId}`;
/**
 * The -t target for one of our sessions, by its plain name (ac-4 -> "=ac-4:"). Without the "=", tmux falls back to a
 * prefix (then fnmatch) match when there is no exact one, so once ac-4 is gone `-t ac-4` reads, types into or kills
 * ac-42. The trailing ":" (that session's current window and pane) makes it valid for pane and window commands too;
 * a bare "=ac-4" is not. meta.tmux keeps the plain name, which is what people type into `tmux attach -t`.
 */
export const tmuxTarget = (session: string) => `=${session}:`;

export async function tmux(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return tmuxWith(args);
}
/** `input` goes to tmux's stdin (load-buffer -). Code -1: tmux could not be started at all (e.g. out of memory). */
async function tmuxWith(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: out.replace(/\n$/, ""), err: err.trim() };
  } catch (e: any) {
    return { code: -1, out: "", err: `could not run tmux: ${e?.message ?? e}` };
  }
}
/** A failed tmux query that means the session is really gone, not that tmux had a bad moment. */
const sessionGone = (err: string) => /can't find|no server running|not found|no such/i.test(err);

/** The argv template for a type: `resume_args` when reopening a session, `interactive_args` when starting interactively (falls back to `args`). */
function templateFor(type: ProcessTypeRow, interactive: boolean, resume: boolean): string[] {
  if (resume) {
    const ra: string[] = JSON.parse(type.resume_args || "[]");
    if (!ra.length) throw new ApiError(400, `process type "${type.name}" has no resume_args template`);
    return ra;
  }
  const ia: string[] = interactive ? JSON.parse(type.interactive_args || "[]") : [];
  return ia.length ? ia : JSON.parse(type.args || "[]");
}

/**
 * The command and args for a run of `type`. `runConfig`: the run's config, whose instructions go in with the template
 * (claude/codex flags, or `{instructions}` in the type's args). A config with Docker settings runs where this
 * machine's files aren't: lofiwave's chat settings file is left out, as on a target. The `docker run` wrapping itself
 * is added by startRun (wrapInDocker), once the run's env is known.
 */
export function buildCommand(type: ProcessTypeRow, opts: { cwd: string; prompt?: string; extraArgs?: string[]; interactive?: boolean; resumeSession?: string; permissionMode?: string; target?: string; runConfig?: RunConfig | null }) {
  const templateArgs = templateFor(type, Boolean(opts.interactive), Boolean(opts.resumeSession));
  const prompt = opts.prompt ?? "";
  const instructions = opts.runConfig?.instructions ?? "";
  const needsPrompt = templateArgs.some((a) => a.includes("{prompt}")) || type.command.includes("{prompt}");
  // Interactive sessions can start empty: the user types (or Remote Control sends) the first message. Drop {prompt} args then.
  if (needsPrompt && !prompt.trim() && !opts.interactive) throw new ApiError(400, `process type "${type.name}" requires a prompt`);
  const vars = { prompt, cwd: opts.cwd, session: opts.resumeSession ?? "", instructions };
  const kept = templateArgs.filter((a) => (prompt.trim() || !a.includes("{prompt}")) && (instructions.trim() || !a.includes("{instructions}")));
  const command = substitute(type.command, vars);
  const templ = kept.map((a) => substitute(a, vars));
  // A switch the template already passes (claude's --remote-control) isn't passed twice when the caller adds it too.
  // Only bare switches: `--model x` keeps its value and goes through.
  const extra = (opts.extraArgs ?? []).filter((a, i, all) => !(a.startsWith("--") && !a.includes("=") && templ.includes(a) && !/^[^-]/.test(all[i + 1] ?? "-")));
  // The configured default mode goes in with the template (so restarts don't count it as an extra arg); args that pick a mode win.
  const picksMode = [...templ, ...extra].some((a) => a === "--dangerously-skip-permissions" || a === "--permission-mode" || a.startsWith("--permission-mode="));
  const mode = opts.permissionMode || config.claudePermissionMode;
  if (mode && basename(command) === "claude" && !picksMode) templ.push("--permission-mode", mode);
  // The same for codex's sandbox (CODEX_SANDBOX_MODE). --full-auto is gone from Codex but still counts as a choice.
  const picksSandbox = [...templ, ...extra].some((a) => /^(-s|--sandbox(=.*)?|--dangerously-bypass-approvals-and-sandbox|--full-auto|--approve-for-me)$/.test(a) || /^sandbox_mode\s*=/.test(a));
  if (config.codexSandboxMode && basename(command) === "codex" && !picksSandbox) templ.push("--sandbox", config.codexSandboxMode);
  // Interactive claude runs get lofiwave's hooks and statusline (src/chat/settings.ts): approvals, streaming text, usage
  // and per-turn checkpoints in the chat view. They merge with the user's and the project's hooks. A run that brings
  // its own --settings is left alone, and so is a run on a target: the file is on this machine, not in the sandbox.
  const picksSettings = [...templ, ...extra].some((a) => a === "--settings" || a.startsWith("--settings="));
  // A run on a target (or in a container) still gets the renderer (CLAUDE_TUI), which the file would have carried.
  const elsewhere = Boolean(opts.target || opts.runConfig?.docker);
  if ((opts.interactive || opts.resumeSession) && basename(command) === "claude" && !picksSettings) {
    if (!elsewhere) templ.push("--settings", chatSettingsPath());
    else if (config.claudeTui !== "keep") templ.push("--settings", JSON.stringify({ tui: config.claudeTui }));
  }
  // The config's instructions, unless the type's template took them as {instructions} or the args set a system prompt.
  if (!templateArgs.some((a) => a.includes("{instructions}"))) templ.push(...instructionArgs(basename(command), instructions, [...templ, ...extra]));
  return { command, args: [...templ, ...extra], template_len: templ.length };
}

/**
 * Run `command args` in the config's container instead: `docker run … <image> command args`. The docker flags count
 * as template (a restart builds them again), so `template_len` grows by them.
 */
export function wrapInDocker(d: DockerSettings, b: { command: string; args: string[]; template_len: number }, o: { name: string; cwd: string; envKeys: string[]; interactive: boolean }) {
  const argv = dockerArgv(d, { ...o, command: b.command, args: b.args });
  return { command: Bun.which("docker") ?? "docker", args: argv, template_len: argv.length - b.args.length + b.template_len };
}

export async function startRun(opts: StartOptions): Promise<RunRow> {
  const type = getType(opts.typeName);
  const target = opts.target ? targetOf(opts.target) : null;
  const runConfig = opts.config ? configOf(opts.config) : null;
  const docker = runConfig?.docker ?? null;
  if (docker && target) throw new ApiError(400, `config "${runConfig!.name}" runs in Docker; a run on target "${target.name}" can't use it`);
  if (docker) {
    const st = await dockerStatus();
    if (!st.available) throw new ApiError(400, `config "${runConfig!.name}" runs in Docker: ${st.error}`);
  }
  const e2b = target ? asApiErr(() => e2bConfig(target)) : null;
  if (target && opts.resumeSession) throw new ApiError(400, `runs on target "${target.name}" can't resume a session`);
  if (opts.inputDir && !e2b) throw new ApiError(400, "input_dir is for runs on an e2b target");
  if (opts.inputDir && (!existsSync(opts.inputDir) || !statSync(opts.inputDir).isDirectory())) throw new ApiError(400, `input_dir does not exist: ${opts.inputDir}`);
  // On a target, the process runs in the target's folder (the sandbox's workdir, where its repo is cloned).
  const cwd = e2b ? e2b.workdir : opts.cwd?.trim();
  if (!cwd) throw new ApiError(400, "cwd is required");
  if (!target && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new ApiError(400, `cwd does not exist: ${cwd}`);
  const interactive = Boolean(opts.interactive) || Boolean(opts.resumeSession);
  if (interactive && !e2b && !tmuxPath()) throw new ApiError(400, "interactive runs need tmux on PATH (brew install tmux / apt install tmux)");
  let { command, args, template_len } = buildCommand(type, { ...opts, cwd, permissionMode: e2b?.permission_mode, runConfig });
  // Remote Control needs a claude.ai login: in a sandbox that only has an API key, leave it out.
  if (e2b && !sandboxEnv(e2b, { ...JSON.parse(type.env || "{}"), ...(runConfig?.env ?? {}), ...(opts.env ?? {}) }, [config.authToken]).CLAUDE_CODE_OAUTH_TOKEN) {
    const drop = args.slice(0, template_len).filter((a) => a === "--remote-control").length;
    if (drop) { args = [...args.slice(0, template_len).filter((a) => a !== "--remote-control"), ...args.slice(template_len)]; template_len -= drop; }
  }
  // A claude run on a target gets a session id picked here, so its transcript can come back as a session of this run
  // (copied out of the sandbox at the end). It goes in with the template, so a restart picks a new one rather than
  // carrying this one as an extra arg.
  const picksSession = args.some((a) => ["--session-id", "--resume", "-r", "--continue", "-c"].includes(a) || a.startsWith("--session-id="));
  const targetSession = target && basename(command) === "claude" && !picksSession ? randomUUID() : "";
  if (targetSession) { args = [...args.slice(0, template_len), "--session-id", targetSession, ...args.slice(template_len)]; template_len += 2; }
  // Too many agents (or too little memory) and one more could take the machine down: refuse; the caller may queue.
  const blocked = type.kind === "agent" && !target ? admissionBlocker() : null;
  if (blocked) throw new ApiError(429, `machine is full: ${blocked}. Try again later, or pass "queue": true to start it when there is room.`);
  const typeEnv: Record<string, string> = JSON.parse(type.env || "{}");
  // Results go in <cwd>/out/. Not made in the home folder or / (a session reopened there), where it would just be litter.
  const outDir = outDirOf(cwd);
  if (!opts.resumeSession && cwd !== homedir() && cwd !== "/") { try { mkdirSync(outDir, { recursive: true }); } catch { /* read-only cwd: the run still starts */ } }
  // `env` is what the run record keeps; the config's env (secrets) only goes to the process: machine < type < config < run.
  const env: Record<string, string> = { LOFIWAVE_OUT_DIR: outDir, ...typeEnv, ...(opts.env ?? {}) };
  const configEnv: Record<string, string> = runConfig
    ? { LOFIWAVE_CONFIG: runConfig.name, ...(runConfig.instructions.trim() ? { LOFIWAVE_INSTRUCTIONS: runConfig.instructions } : {}), ...runConfig.env }
    : {};
  const launchEnv: Record<string, string> = { LOFIWAVE_OUT_DIR: outDir, ...typeEnv, ...configEnv, ...(opts.env ?? {}) };
  const t = now();
  const timeoutSec = opts.timeoutSec ?? opts.workflow?.timeout_sec ?? 0;
  const meta: Record<string, any> = { ...(opts.meta ?? {}), timeout_sec: timeoutSec, template_len };
  if (opts.resumeSession) meta.resume_session = opts.resumeSession;
  if (opts.stopWhenIdle && interactive) meta.stop_when_idle = true;
  if (args.includes(chatSettingsPath())) { meta.approvals = true; meta.live = true; }
  if (opts.idleStopSec !== undefined) meta.idle_stop_sec = opts.idleStopSec;
  else if (opts.stopWhenIdle === false) meta.idle_stop_sec = 0;
  // Who started it: the logged-in person (or "api" for the token), when it comes from a request; scheduled runs have none.
  const by = actor.getStore() ?? opts.meta?.started_by;
  if (by) meta.started_by = by;
  // Commits made in this run are authored by the person who started it (GIT_AUTHORS), when we know them.
  const author = by ? config.gitAuthors.get(by.trim().split(/\s+/)[0].toLowerCase()) : undefined;
  const gitEnv: Record<string, string> = author
    ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
    : {};
  if (author) meta.git_author = `${author.name} <${author.email}>`;
  if (runConfig) meta.config = runConfig.name;
  if (docker) {
    // The container gets the run's env by name (docker reads the values from the pane's environment), and of
    // lofiwave's own only the run id: its token and URL stay out of the container.
    const name = containerName();
    ({ command, args, template_len } = wrapInDocker(docker, { command, args, template_len }, {
      name, cwd, interactive, envKeys: Object.keys({ ...gitEnv, ...launchEnv, AGENT_CONSOLE_RUN_ID: "" }),
    }));
    meta.template_len = template_len;
    meta.docker = { image: docker.image, container: name };
  }
  if (target) {
    meta.target = target.name; meta.target_kind = target.kind;
    // The folder on this machine its transcript is filed under, so "Resume here" opens it there.
    const local = opts.cwd?.trim();
    if (local && existsSync(local) && statSync(local).isDirectory()) meta.local_cwd = local;
    if (targetSession) meta.claude_session = targetSession;
  }
  // In a container the agent's registry and transcripts are out of reach (its pid here is docker's): the screen is all there is.
  const isCodex = basename(command) === "codex" && !target;
  const isClaude = basename(command) === "claude";
  // meta.trust: false (opted out), or how the folder came to be trusted: already | trusted | skipped | failed, later accepted.
  // A run on a target has no folder here to trust.
  if (opts.trust === false || target) meta.trust = false;
  else if (isClaude) meta.trust = trustClaudeFolder(cwd);

  let id: number;
  if (opts.runId) {
    const upd = db.prepare(
      "UPDATE runs SET command = ?, args = ?, env = ?, status = 'running', started_at = ?, meta = ? WHERE id = ? AND status = 'queued'",
    ).run(command, JSON.stringify(args), JSON.stringify(env), t, JSON.stringify(meta), opts.runId);
    if (!upd.changes) throw new ApiError(409, `run ${opts.runId} is no longer queued`);
    id = opts.runId;
  } else {
    const ins = db.prepare(
      `INSERT INTO runs (workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger, status, started_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      opts.workflow?.id ?? null, opts.workflow?.name ?? null, type.name, cwd, command, JSON.stringify(args),
      opts.prompt ?? "", JSON.stringify(env), opts.trigger, t, JSON.stringify(meta),
    );
    id = Number(ins.lastInsertRowid);
  }
  starting.add(id);
  const logPath = join(logDir, `run-${id}.log`);
  if (interactive) { meta.interactive = true; if (!e2b) meta.tmux = tmuxSessionName(id); }
  if (e2b) meta.e2b = { tag: `lofiwave-${id}` };
  db.prepare("UPDATE runs SET log_path = ?, meta = ? WHERE id = ?").run(logPath, JSON.stringify(meta), id);

  const sink = Bun.file(logPath).writer();
  const header = `# lofiwave run ${id} | ${new Date(t).toISOString()} | ${target ? `target=${target.name} (${target.kind}) | ` : ""}cwd=${cwd}\n# $ ${[command, ...args].map(shellQuote).join(" ")}\n` +
    (interactive && e2b ? `# interactive: a PTY in the run's E2B sandbox (open it from Sessions); the screen is captured here when it ends\n` : "") +
    (interactive && !e2b ? `# interactive: tmux session "${meta.tmux}" (attach with: tmux attach -t ${meta.tmux}); the screen is captured here when it ends\n` : "") + "\n";
  sink.write(header);
  sink.flush();

  const childEnv = {
    ...process.env, ...gitEnv, ...launchEnv,
    AGENT_CONSOLE_RUN_ID: String(id),
    // Lets scripts/claude-session-hook.sh (a Claude Code SessionStart/SessionEnd hook) report the session back.
    AGENT_CONSOLE_URL: `http://127.0.0.1:${config.port}`,
    AGENT_CONSOLE_TOKEN: config.authToken,
  };

  const fail = async (msg: string) => {
    starting.delete(id);
    sink.write(`\n${msg}\n`);
    await sink.end();
    db.prepare("UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ?").run(now(), msg, id);
    throw new ApiError(400, msg);
  };

  let markDone!: () => void;
  const done = new Promise<void>((res) => (markDone = res));
  let entry: LiveEntry;
  let exited: Promise<number | null>;

  if (e2b) {
    // Nothing runs here: the agent runs in its own sandbox, and we follow it (src/e2b.ts).
    entry = { pid: 0, done };
    const write = (s: string) => { sink.write(s.endsWith("\n") ? s : s + "\n"); sink.flush(); };
    let h: E2BHandle;
    try {
      h = runE2B({
        runId: id, c: e2b, command, args, env: launchEnv, interactive, sessionId: targetSession || undefined,
        inputDir: opts.inputDir, outDir: join(config.dataDir, "runs", String(id), "out"),
        forbiddenValues: [config.authToken], write,
        onMeta: (patch) => { meta.e2b = { ...meta.e2b, ...patch }; db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id); },
        saveTranscript: (sid, data) => saveTranscript(id, meta, sid, data, "e2b", write),
      });
    } catch (e: any) {
      await fail(e?.message ?? String(e));
    }
    entry.cancel = h!.cancel;
    exited = h!.done.then((r) => {
      if (r.message) write(`# e2b: ${r.message}`);
      if (r.failed) entry.error = r.message || "the sandbox run failed to start";
      else if (r.message) entry.lostWhy = r.message;
      return r.code;
    });
  } else if (interactive) {
    // A detached tmux session owns the pty; we track the pane's process and poll its exit status.
    const sess = meta.tmux as string;
    // The config's secrets stay off tmux's argv (which `ps` shows): a 0600 file the pane's shell sources, removes, and execs from.
    const secretKeys = runConfig ? Object.keys(runConfig.env).filter((k) => !(k in (opts.env ?? {}))) : [];
    const secretFile = secretKeys.length ? join(config.dataDir, "runs", String(id), "env.sh") : "";
    if (secretFile) {
      mkdirSync(dirname(secretFile), { recursive: true });
      writeFileSync(secretFile, secretKeys.map((k) => `export ${k}=${shellQuote(runConfig!.env[k])}\n`).join(""), { mode: 0o600 });
    }
    const envFlags = Object.entries({ ...gitEnv, ...launchEnv, PATH: childEnv.PATH ?? "", AGENT_CONSOLE_RUN_ID: childEnv.AGENT_CONSOLE_RUN_ID, AGENT_CONSOLE_URL: childEnv.AGENT_CONSOLE_URL, AGENT_CONSOLE_TOKEN: childEnv.AGENT_CONSOLE_TOKEN })
      .filter(([k]) => !secretKeys.includes(k)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const paneCmd = secretFile ? ["sh", "-c", '. "$0"; rm -f "$0"; exec "$@"', secretFile, command, ...args] : [command, ...args];
    const created = await tmux("new-session", "-d", "-s", sess, "-c", cwd, "-x", "180", "-y", "48", ...envFlags, "--", ...paneCmd);
    if (created.code !== 0) { if (secretFile) rmSync(secretFile, { force: true }); await fail(`failed to start tmux session: ${created.err || created.out}`); }
    await tmux("set-option", "-t", tmuxTarget(sess), "remain-on-exit", "on");
    const pane = await tmux("display-message", "-p", "-t", tmuxTarget(sess), "#{pane_pid}");
    const pid = Number(pane.out);
    if (!pid) await fail(`could not read the tmux pane pid: ${pane.err || pane.out}`);
    entry = { pid, tmux: sess, done };
    // Record the pid now, not after the window opens: until it is in the row, the process list counts this
    // process as started outside the console and offers to take it over (a second copy of the same session).
    db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(pid, id);
    // Show the session on this machine's desktop too. Failing to find a terminal is not fatal:
    // the run keeps going in tmux, and the console's own screen view still works.
    const term = await openTerminalForTmux(tmuxTarget(sess), { terminal: opts.terminal });
    if (term.opened) {
      meta.terminal = term.app;
      sink.write(`# window: attached in ${term.app}\n`);
    } else if (term.error) {
      meta.terminal_error = term.error;
      sink.write(`# window: no terminal window opened (${term.error}); attach with: tmux attach -t ${sess}\n`);
    }
    if (term.opened || term.error) { sink.flush(); db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id); }
    // Started with a prompt: it is about to work on it, whatever the registry says in the first second.
    if (opts.prompt?.trim()) messagedAt.set(id, t);
    exited = watchPane({ id, sess, pid, meta, entry, sink, cwd, startedAt: t, isCodex, isClaude, resumeSession: opts.resumeSession, prompt: opts.prompt });
  } else {
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([command, ...args], { cwd, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e: any) {
      await fail(`failed to spawn "${command}": ${e?.message ?? e}`);
    }
    entry = { pid: proc!.pid, proc: proc!, done };
    const pump = async (stream: ReadableStream<Uint8Array> | undefined | null) => {
      if (!stream) return;
      for await (const chunk of stream) { sink.write(chunk); sink.flush(); }
    };
    const io = Promise.all([pump(proc!.stdout as any), pump(proc!.stderr as any)]);
    exited = proc!.exited.then(async (code) => {
      // Grandchildren may still hold the pipes open; don't wait on them forever.
      await Promise.race([io.catch(() => {}), Bun.sleep(3000)]);
      return code;
    });
  }

  if (entry.pid) db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(entry.pid, id);
  if (opts.workflow) db.prepare("UPDATE workflows SET last_run_at = ? WHERE id = ?").run(t, opts.workflow.id);
  live.set(id, entry);
  starting.delete(id);
  if (timeoutSec > 0) {
    entry.timer = setTimeout(() => {
      entry.killedBy = "timeout";
      sink.write(`\n# lofiwave: timeout after ${timeoutSec}s, ${entry.cancel ? "cancelling it" : "killing process tree"}\n`);
      stopEntry(entry, true).catch(() => {});
    }, timeoutSec * 1000);
  }

  finishRun({ id, entry, sink, logPath, meta, cwd, isCodex, interactive, onTarget: Boolean(target), startedAt: t, resumeSession: opts.resumeSession, prompt: opts.prompt }, exited, markDone);

  return getRun(id);
}

/** Where a run's log goes: the open file writer of a new run, or appends to the log of one picked up after a restart. */
type Sink = { write(s: string | Uint8Array): unknown; flush(): unknown; end(): unknown };
const saveMeta = (id: number, meta: Record<string, any>) => db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);

type Watch = {
  id: number; sess: string; pid: number; meta: Record<string, any>; entry: LiveEntry; sink: Sink; cwd: string;
  startedAt: number; isCodex: boolean; isClaude: boolean; resumeSession?: string; prompt?: string;
};

/**
 * Follow an interactive run's tmux pane until its program exits; resolves with the exit status (null: unknown).
 * Along the way: record a Codex session, pick up the Remote Control link, answer the folder trust dialog, keep the
 * run's activity current, and end a claude run that has sat idle with nobody watching.
 */
async function watchPane(w: Watch): Promise<number | null> {
  const { id, sess, pid, meta, entry, sink } = w;
  let ticks = 0;
  // Idle stop: claude's own registry says busy while it works, waiting on a permission prompt, idle when done.
  let sawBusy = false, idleSince = 0;
  for (;;) {
    await Bun.sleep(1000);
    ticks++;
    const q = await tmux("display-message", "-p", "-t", tmuxTarget(sess), "#{pane_dead} #{pane_dead_status} #{session_attached}");
    if (q.code !== 0) {
      if (sessionGone(q.err)) return null;              // session vanished (killed from outside)
      continue;                                         // tmux had a bad moment (e.g. no memory to start it): look again
    }
    const [dead, status, attached] = q.out.split(" ");
    if (dead === "1") return status === "" ? null : Number(status);
    // Codex has no hook: find its thread in Codex's index and record the session.
    if (w.isCodex && !meta.codex_session && ticks % 3 === 0) {
      const found = findCodexRunSession(id, w.startedAt, w.cwd, "tui", { resumeSession: w.resumeSession, prompt: w.prompt } as StartOptions);
      if (found) {
        meta.codex_session = found.session_id;
        if (found.mismatch) {
          meta.resume_mismatch = { asked: w.resumeSession, got: found.session_id };
          sink.write(`\n# lofiwave: asked codex to resume ${w.resumeSession}, but it started a new session ${found.session_id}\n`); sink.flush();
          db.prepare("UPDATE sessions SET source = 'resume failed' WHERE run_id = ? AND session_id = ?").run(id, w.resumeSession!);
        }
        saveMeta(id, meta);
        recordSession(id, { session_id: found.session_id, agent: "codex", cwd: w.cwd, transcript_path: found.path, source: found.source });
      }
    }
    if (ticks % 2) continue;

    const reg = w.isClaude ? claudeActivity(pid, id) : null;
    if (w.isClaude) noteClaudeSession(id, pid, w.cwd);
    // The screen, early on (the Remote Control link, the trust dialog) and whenever no registry says what the agent is doing.
    let screen: string | null = null;
    if (!reg || ticks <= 120) {
      const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(sess));
      if (cap.code === 0) screen = cap.out;
    }
    if (screen !== null) {
      // Claude Code prints its Remote Control link once it is up; keep it on the run so the UI can open the session in the Claude app.
      const m = !meta.remote_url && /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(screen);
      if (m) { meta.remote_url = m[0]; saveMeta(id, meta); }
      // Pre-trusting the folder covers claude; this catches the rest (no config file yet, codex's own trust prompt).
      if (meta.trust !== false && ticks <= 120 && TRUST_PROMPT.test(screen) && (await acceptTrustPrompt(sess, screen))) {
        meta.trust = "accepted";
        saveMeta(id, meta);
        sink.write("# lofiwave: answered the folder trust prompt (trust: false on the run turns this off)\n");
        sink.flush();
      }
    }
    let act = screen !== null && TRUST_PROMPT.test(screen) ? screenActivity(screen) : reg ?? (screen !== null ? screenActivity(screen) : null);
    // A quiet screen right after a message (or the trust answer) is the agent not having started yet, as with the registry.
    const sent = messagedAt.get(id) ?? 0;
    if (!reg && act?.activity === "idle" && Date.now() - sent < 15_000) act = { activity: "working", since: sent };
    if (act) noteActivity(id, act);

    // Only claude's registry is trusted to say "idle" for this: a screen that looks quiet may be a long tool call.
    const stopAfter = idleStopSecOf(meta, w.isClaude);
    if (stopAfter > 0 && reg && act && !entry.killedBy) {
      if (act.activity === "idle" && (sawBusy || !meta.stop_when_idle)) {
        idleSince ||= Date.now();
        // Someone watching (a browser terminal or the simple view, a desktop window, tmux attach) may be about to type.
        if (Number(attached) > 0 || Date.now() - (screenSeenAt.get(sess) ?? 0) < 30_000) idleSince = Date.now();
        if (Date.now() - idleSince >= stopAfter * 1000) {
          entry.killedBy = "idle";
          // claude clears its screen on the way out: keep what it showed last (its answer) before closing it.
          const last = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(sess));
          if (last.code === 0) sink.write(last.out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
          sink.write(`\n# lofiwave: finished, idle for ${stopAfter}s; closing the session\n`);
          killTree(pid, false).catch(() => {});
        }
      } else {
        if (act.activity !== "idle") sawBusy = true;
        idleSince = 0;
      }
    }
  }
}

/** Once a run's process has exited: save the screen (interactive), record the final status, and resolve `done`. */
async function finishRun(r: {
  id: number; entry: LiveEntry; sink: Sink; logPath: string; meta: Record<string, any>; cwd: string; isCodex: boolean;
  interactive: boolean; onTarget: boolean; startedAt: number; resumeSession?: string; prompt?: string;
}, exited: Promise<number | null>, markDone: () => void) {
  const { id, entry, sink, logPath, meta } = r;
  const code = await exited;
  if (entry.timer) clearTimeout(entry.timer);
  // Stopping `docker run -t` (killing its process tree) leaves the container running: remove it.
  if (meta.docker?.container) await removeContainer(meta.docker.container);
  if (entry.tmux) {
    // Keep what was on screen (scrollback included) as the run's record, then drop the dead session.
    const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(entry.tmux), "-S", "-2000");
    if (cap.code === 0) sink.write(cap.out.replace(/^Pane is dead.*$/m, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
    await tmux("kill-session", "-t", tmuxTarget(entry.tmux));
  }
  const status = entry.error ? "error" : entry.killedBy === "timeout" ? "timeout" : entry.killedBy === "idle" ? "success" : entry.killedBy ? "killed" : code === 0 ? "success" : code === null ? "lost" : "failed";
  sink.write(`\n# lofiwave: exited with code ${code ?? "unknown"} (${status})\n`);
  await sink.end();
  if (r.isCodex && !meta.codex_session) {
    // `codex exec` prints "session id: <uuid>" in its header (with --json: a thread.started event first), so look at
    // the start of the log, not only the end. Colours are stripped first. Failing that, Codex's index.
    const opts = { resumeSession: r.resumeSession, prompt: r.prompt } as StartOptions;
    const text = stripAnsi(readHead(logPath, 64 * 1024) + "\n" + readTail(logPath, 64 * 1024));
    const m = /session id:\s*([0-9a-f-]{36})/.exec(text) ?? /"thread\.started","thread_id":"([0-9a-f-]{36})"/.exec(text);
    const found = m ? { session_id: m[1], path: codexRolloutPath(m[1]), source: "startup" } : findCodexRunSession(id, r.startedAt, r.cwd, r.interactive ? "tui" : "exec", opts);
    if (found) recordSession(id, { session_id: found.session_id, agent: "codex", cwd: r.cwd, transcript_path: found.path, source: found.source });
    // Asked to resume and never seen using that thread (a wrong id: codex exits with "No saved session found").
    if (r.resumeSession && found?.source !== "resume") db.prepare("UPDATE sessions SET source = 'resume failed' WHERE run_id = ? AND session_id = ? AND source = 'resume requested'").run(id, r.resumeSession);
  }
  live.delete(id);
  activities.delete(id);
  messagedAt.delete(id);
  notedSessions.delete(id);
  db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?")
    .run(status, now(), code, readTail(logPath, config.outputTailBytes), entry.error ?? (code === null && !entry.killedBy ? (entry.lostWhy ? entry.lostWhy : r.onTarget ? "the sandbox run ended without a result" : "tmux session disappeared") : ""), id);
  markDone();
}

/**
 * Pick up an interactive run again after the console restarted (its tmux session outlived the old server): follow its
 * pane like a new run's, so it gets its activity, idle stop and a real final status. Only when the session's pane is
 * still that run's process: another lofiwave on this machine (another DATA_DIR) may have a session of the same name.
 */
async function refollow(r: RunRow, meta: Record<string, any>): Promise<"following" | "not-ours"> {
  const q = await tmux("display-message", "-p", "-t", tmuxTarget(meta.tmux), "#{pane_pid}");
  if (q.code !== 0 || Number(q.out) !== r.pid) return "not-ours";
  let markDone!: () => void;
  const done = new Promise<void>((res) => (markDone = res));
  const entry: LiveEntry = { pid: r.pid!, tmux: meta.tmux, done };
  const logPath = r.log_path || join(logDir, `run-${r.id}.log`);
  const sink: Sink = { write: (s) => { try { appendFileSync(logPath, s); } catch { /* log dir gone */ } }, flush() {}, end() {} };
  sink.write(`\n# lofiwave: following this session again after a console restart\n`);
  if (meta.orphan) { delete meta.orphan; saveMeta(r.id, meta); }
  live.set(r.id, entry);
  const isCodex = basename(r.command) === "codex";
  const exited = watchPane({ id: r.id, sess: meta.tmux, pid: r.pid!, meta, entry, sink, cwd: r.cwd, startedAt: r.started_at, isCodex, isClaude: basename(r.command) === "claude", resumeSession: meta.resume_session, prompt: r.prompt });
  finishRun({ id: r.id, entry, sink, logPath, meta, cwd: r.cwd, isCodex, interactive: true, onTarget: false, startedAt: r.started_at, resumeSession: meta.resume_session, prompt: r.prompt }, exited, markDone);
  return "following";
}

// ---------------------------------------------------------------- activity

const TRUST_PROMPT = /Yes, I trust this folder|Do you trust the (?:files|contents) (?:in|of) this (?:folder|directory)/i;

/** What a TUI without a registry (or one showing the trust dialog) is doing, from its screen. */
function screenActivity(screen: string): ActivityState {
  if (TRUST_PROMPT.test(screen)) return { activity: "waiting_input", since: 0, waiting_for: "trust" };
  // claude and codex both show this while a turn runs.
  if (/esc to interrupt/i.test(screen)) return { activity: "working", since: 0 };
  return { activity: "idle", since: 0 };
}

/** From claude's registry: busy / waiting / idle, since when. Null when claude hasn't written one (yet). */
function claudeActivity(pid: number, runId: number): ActivityState | null {
  const e = claudeRegistry().byPid.get(pid);
  if (!e?.status) return null;
  const since = e.statusUpdatedAt ?? Date.now();
  if (e.status === "waiting") return { activity: "waiting_input", since, waiting_for: e.waitingFor };
  if (e.status !== "idle") return { activity: "working", since };
  // A message sent after it went idle that it hasn't picked up yet: it is about to work.
  const sent = messagedAt.get(runId) ?? 0;
  if (sent > since && Date.now() - sent < 15_000) return { activity: "working", since: sent };
  return { activity: "idle", since };
}

function noteActivity(id: number, a: ActivityState) {
  const cur = activities.get(id);
  // A screen reading has no time of its own (since 0): it has been doing this since we first saw it.
  const same = cur && cur.activity === a.activity && cur.waiting_for === a.waiting_for;
  activities.set(id, { ...a, since: a.since || (cur && same ? cur.since : Date.now()) });
}

/** A run's activity for the API: from its pane watcher, else claude's registry, else assume a running run works. */
export function activityOf(run: RunRow): { activity: Activity; activity_since: number; waiting_for?: string } {
  if (run.status !== "running") return { activity: "done", activity_since: run.ended_at ?? run.started_at };
  const a = activities.get(run.id) ?? (run.pid ? claudeActivity(run.pid, run.id) : null) ?? { activity: "working" as Activity, since: run.started_at };
  return { activity: a.activity, activity_since: a.since, ...(a.waiting_for ? { waiting_for: a.waiting_for } : {}) };
}

/** Seconds a run may sit idle, with nobody watching, before it ends; 0 = never. */
function idleStopSecOf(meta: Record<string, any>, isClaude: boolean): number {
  if (typeof meta.idle_stop_sec === "number") return meta.idle_stop_sec;
  if (meta.stop_when_idle) return config.idleStopSec;
  return isClaude && meta.interactive ? config.agentIdleStopSec : 0;
}

/**
 * Long-poll: resolve once the run is idle (its turn is over, or it waits on a prompt, or it ended) or done (ended),
 * or at the deadline. `after`: only an idle that began at or after this time counts, so a caller that just sent a
 * message doesn't get the idle from before it.
 */
export async function waitForRun(id: number, until: "idle" | "done", timeoutMs: number, after = 0, signal?: AbortSignal): Promise<{ run: RunRow; reached: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = getRun(id);
    const a = activityOf(run);
    const reached = until === "done" ? run.status !== "running" : a.activity === "done" || (a.activity !== "working" && a.activity_since >= after);
    const left = deadline - Date.now();
    if (reached || left <= 0 || signal?.aborted) return { run, reached };
    await Promise.race([Bun.sleep(Math.min(1000, left)), live.get(id)?.done ?? Bun.sleep(1000)]);
  }
}

// ---------------------------------------------------------------- typing into a pane

/**
 * Answer a trust dialog on screen: move the selection to its "Yes" option and press Enter. The options are not
 * numbered the same in every version, so walk down the list until the selected line (❯ / ›) says Yes.
 */
async function acceptTrustPrompt(sess: string, screen: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const selected = screen.split("\n").find((l) => /^\s*[❯›>]\s/.test(l)) ?? "";
    if (/\byes\b/i.test(selected)) { await tmux("send-keys", "-t", tmuxTarget(sess), "Enter"); return true; }
    await tmux("send-keys", "-t", tmuxTarget(sess), "Down");
    await Bun.sleep(250);
    const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(sess));
    if (cap.code !== 0) return false;
    screen = cap.out;
  }
  return false;
}

/**
 * Put text into a pane. Short single-line text is typed; anything longer goes in as one bracketed paste (tmux
 * paste-buffer -p), so the TUI knows exactly where it ends: typed fast, a long message looks like a paste to claude,
 * and an Enter that arrives while it is still taking the "paste" in becomes part of it instead of sending it.
 */
async function putText(sess: string, text: string, runId: number) {
  if (text.length < 100 && !/[\r\n]/.test(text)) return tmux("send-keys", "-t", tmuxTarget(sess), "-l", "--", text);
  const buf = `lofiwave-${runId}`;
  const loaded = await tmuxWith(["load-buffer", "-b", buf, "-"], text);
  if (loaded.code !== 0) return loaded;
  return tmux("paste-buffer", "-p", "-r", "-d", "-b", buf, "-t", tmuxTarget(sess));
}

/** The text in claude's input box (between the last two rules at the bottom of its screen), or null if there is no such box. */
function inputBox(screen: string): string | null {
  const lines = screen.split("\n");
  const rules = lines.flatMap((l, i) => (/^\s*─{8,}/.test(l) ? [i] : []));
  if (rules.length < 2) return null;
  const [top, bottom] = rules.slice(-2);
  return lines.slice(top + 1, bottom).join(" ").replace(/^\s*❯/, "").replace(/\s+/g, " ").trim();
}

/**
 * Put a message into the pane and press Enter, then check it went: in claude, the input box empties once the message
 * is sent (or queued, if it was mid-turn). If the text is still there, Enter again (twice at most).
 * delivered: null when the TUI has no input box we can read (not claude), so it can't be checked.
 */
async function deliver(runId: number, sess: string, text: string): Promise<{ delivered: boolean | null; attempts: number }> {
  const screen = async () => { const c = await tmux("capture-pane", "-p", "-t", tmuxTarget(sess)); return c.code === 0 ? c.out : null; };
  const before = await screen();
  const put = await putText(sess, text, runId);
  if (put.code !== 0) throw new ApiError(500, `tmux could not type into ${sess}: ${put.err}`);
  const tail = text.replace(/\s+/g, " ").trim().slice(-24);
  // Our text is still in the box: it ends with it (the cursor is at the end), or claude folded it into a paste marker.
  const holds = (box: string) => /\[Pasted text #\d+/.test(box) || (tail !== "" && box.endsWith(tail));
  // Enter only once the text has landed (a busy or slow TUI takes a moment to draw it).
  let box: string | null = null;
  for (let i = 0; i < 25; i++) {
    await Bun.sleep(100);
    const s = await screen();
    if (s === null) continue;
    box = inputBox(s);
    if (box !== null ? holds(box) : s !== before) break;
  }
  if (box === null) {
    await tmux("send-keys", "-t", tmuxTarget(sess), "Enter");
    return { delivered: null, attempts: 1 };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tmux("send-keys", "-t", tmuxTarget(sess), "Enter");
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(250);
      const s = await screen();
      const b = s === null ? null : inputBox(s);
      if (b !== null && !holds(b)) return { delivered: true, attempts: attempt };
    }
  }
  return { delivered: false, attempts: 3 };
}

/**
 * Send a message to an interactive agent, as if typed into its prompt and sent, and check that it arrived. A claude
 * that is mid-turn queues it and reads it when the turn ends (`queued`). Refused while the agent waits on a prompt
 * (a permission, the trust dialog): Enter would answer that instead; use keys for it.
 */
export async function sendMessage(run: RunRow, text: string): Promise<{ delivered: boolean | null; queued: boolean; attempts: number; sent_at: number }> {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.e2b && meta.interactive) {
    if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
    if (!text.trim()) throw new ApiError(400, "text is required");
    const sent_at = Date.now();
    await sendKeys(run, text, [], true);
    return { delivered: null, queued: false, attempts: 1, sent_at };
  }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
  if (!text.trim()) throw new ApiError(400, "text is required");
  const act = activityOf(run);
  if (act.activity === "waiting_input") throw new ApiError(409, `run ${run.id} is waiting on a prompt${act.waiting_for ? ` (${act.waiting_for})` : ""}; answer it with POST /api/runs/${run.id}/keys first`);
  const sent_at = Date.now();
  const r = await deliver(run.id, meta.tmux, text);
  if (r.delivered !== false) { messagedAt.set(run.id, sent_at); if (live.has(run.id)) noteActivity(run.id, { activity: "working", since: sent_at }); }
  return { ...r, queued: r.delivered === true && act.activity === "working", sent_at };
}

/** Current contents of an interactive run's terminal (last `lines` of scrollback + screen). `error`: tmux couldn't read it this time. */
export async function screenOf(run: RunRow, lines = 200, cols = 0): Promise<{ text: string; alive: boolean; cols: number; error?: string }> {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.e2b && meta.interactive) {
    const t = e2bTerms.get(run.id);
    if (!t) return { text: "", alive: false, cols: 0 };
    if (cols >= 40 && cols <= 220 && cols !== t.cols && run.status === "running" && !t.viewers.size) await t.resize(cols, cols < 100 ? 40 : 48);
    return { text: t.screen.text(lines).replace(/\n{3,}/g, "\n\n"), alive: run.status === "running", cols: t.cols };
  }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  if (run.status === "running") screenSeenAt.set(meta.tmux, Date.now());
  let width = 0;
  const size = await tmux("display-message", "-p", "-t", tmuxTarget(meta.tmux), "#{window_width}");
  if (size.code === 0) width = Number(size.out) || 0;
  // A phone can't show 180 columns: resize the window to the viewer's width and the TUI reflows (SIGWINCH), like a real terminal would.
  if (cols >= 40 && cols <= 220 && width && cols !== width && run.status === "running" && !ttyViewers.has(meta.tmux)) {
    const r = await tmux("resize-window", "-t", tmuxTarget(meta.tmux), "-x", String(cols), "-y", String(cols < 100 ? 40 : 48));
    if (r.code === 0) width = cols;
  }
  const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(meta.tmux), "-S", String(-lines));
  // An empty screen is not an unreadable one (tmux couldn't run, e.g. out of memory): say which.
  if (cap.code !== 0) return { text: "", alive: run.status === "running" && !sessionGone(cap.err), cols: width, error: cap.err || "could not read the screen" };
  // TUIs pin their input box to the bottom of the pane; collapse the padding so the useful part fits on a phone.
  return { text: cap.out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), alive: run.status === "running", cols: width };
}

/**
 * The pane's scrollback plus screen with colors (escape sequences kept, wrapped lines joined), for a viewer's
 * private scrolled-back view. Read-only: unlike scrolling inside tmux (copy-mode, shared by every viewer of the
 * pane), this moves nobody else's screen.
 */
export async function historyOf(run: RunRow, lines = 5000): Promise<{ text: string; own_scroll: boolean }> {
  const meta = JSON.parse(run.meta || "{}");
  // A sandbox's terminal: plain text from the headless screen (no colors).
  if (meta.e2b && meta.interactive) { const t = e2bTermOf(run); return { text: t.screen.text(lines), own_scroll: t.screen.altOn }; }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  const cap = await tmux("capture-pane", "-p", "-e", "-J", "-t", tmuxTarget(meta.tmux), "-S", String(-lines));
  if (cap.code !== 0) throw new ApiError(409, `run ${run.id} has no terminal`);
  // A full-screen app (claude's TUI) draws on the alternate screen, so tmux keeps no history: the app owns its scrolling.
  const st = await tmux("display-message", "-p", "-t", tmuxTarget(meta.tmux), "#{alternate_on} #{history_size}");
  const [alt, size] = st.out.trim().split(" ");
  return { text: cap.out.replace(/(\n(\x1b\[[0-9;]*m|\s)*)+$/, ""), own_scroll: alt === "1" && size === "0" };
}

/**
 * Type text and/or named keys (tmux names: Up, Down, Escape, C-c, Tab ...) into an interactive run's terminal, then
 * optionally Enter. Text followed by Enter (and no keys) is a message: it goes through `deliver`, which waits for the
 * text to land before pressing Enter and checks it was sent.
 */
export async function sendKeys(run: RunRow, text: string, keys: string[], enter: boolean): Promise<{ delivered?: boolean | null; attempts?: number }> {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.e2b && meta.interactive) {
    if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
    const bytes = keys.map((k) => { const b = keyBytes(k); if (b === null) throw new ApiError(400, `bad key name: ${k}`); return b; });
    const t = e2bTermOf(run);
    if (text) await t.input(text);
    for (const b of bytes) await t.input(b);
    // Like typing: a TUI that sees text and Enter in one read can take the Enter as part of a paste.
    if (enter) { if (text) await Bun.sleep(150); await t.input("\r"); }
    return {};
  }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
  for (const k of keys) if (!/^[A-Za-z0-9-]+$/.test(k)) throw new ApiError(400, `bad key name: ${k}`);
  // (Not while it waits on a prompt: there the text answers a menu, and pressing Enter again could answer the next one.)
  if (text && enter && !keys.length && activityOf(run).activity !== "waiting_input") {
    const sent = Date.now();
    const r = await deliver(run.id, meta.tmux, text);
    if (r.delivered !== false) { messagedAt.set(run.id, sent); if (live.has(run.id)) noteActivity(run.id, { activity: "working", since: sent }); }
    return r;
  }
  if (text) {
    const r = await putText(meta.tmux, text, run.id);
    if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
    if (keys.length || enter) await Bun.sleep(150);   // let the TUI take the text in before keys that act on it
  }
  for (const k of keys) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new ApiError(400, `bad key name: ${k}`);
    const r = await tmux("send-keys", "-t", tmuxTarget(meta.tmux), k);
    if (r.code !== 0) throw new ApiError(400, `tmux did not accept key "${k}": ${r.err}`);
  }
  if (enter) {
    await tmux("send-keys", "-t", tmuxTarget(meta.tmux), "Enter");
    // Probably an answer to a prompt: it is about to work, until its pane watcher next says otherwise.
    messagedAt.set(run.id, Date.now());
    if (live.has(run.id)) noteActivity(run.id, { activity: "working", since: Date.now() });
  }
  return {};
}

export async function killRun(id: number, force = false): Promise<RunRow> {
  const run = getRun(id);
  if (run.status === "queued") {
    // Never started: just take it out of the queue.
    db.prepare("UPDATE runs SET status = 'killed', ended_at = ?, error = 'cancelled while queued' WHERE id = ? AND status = 'queued'").run(now(), id);
    return getRun(id);
  }
  const entry = live.get(id);
  if (run.status === "running" && entry?.cancel) {
    entry.killedBy = "user";
    await entry.cancel();
    await Promise.race([entry.done, Bun.sleep(3000)]);
    return getRun(id);
  }
  if (run.status !== "running" || !run.pid) throw new ApiError(409, `run ${id} is not running`);
  if (entry) entry.killedBy = "user";
  await killTree(run.pid, force);
  if (entry) {
    // Give the exit handler a moment to record the final status.
    await Promise.race([entry.done, Bun.sleep(force ? 2000 : 5000)]);
  } else {
    // Orphan from a previous server instance: we can't await exit, so poll briefly.
    for (let i = 0; i < 20 && pidAlive(run.pid); i++) await Bun.sleep(100);
    if (!pidAlive(run.pid)) {
      const meta = JSON.parse(run.meta || "{}");
      if (meta.tmux) {
        // Nobody is polling this session any more: save its screen and drop it, like the live path does.
        const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(meta.tmux), "-S", "-2000");
        if (cap.code === 0 && run.log_path) appendFileSync(run.log_path, cap.out.replace(/^Pane is dead.*$/m, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n\n# lofiwave: killed (orphan)\n");
        await tmux("kill-session", "-t", tmuxTarget(meta.tmux));
      }
      if (meta.docker?.container) await removeContainer(meta.docker.container);
      db.prepare("UPDATE runs SET status = 'killed', ended_at = ? WHERE id = ?").run(now(), id);
    }
  }
  return getRun(id);
}

export async function restartRun(id: number): Promise<RunRow> {
  const run = getRun(id);
  if (run.status === "running") await killRun(id, false);
  const wf = run.workflow_id
    ? db.query<WorkflowRow, [number]>("SELECT * FROM workflows WHERE id = ?").get(run.workflow_id)
    : null;
  const type = getType(run.type_name);
  const meta = JSON.parse(run.meta || "{}");
  const finalArgs: string[] = JSON.parse(run.args || "[]");
  const templateLen: number = meta.template_len ?? JSON.parse(type.args || "[]").length;
  const extraArgs = finalArgs.slice(templateLen);
  // The record's env holds the type's env too; leave out what the type sets anyway, so the config's env still wins over it.
  const typeEnv: Record<string, string> = JSON.parse(type.env || "{}");
  const env = Object.fromEntries(Object.entries(JSON.parse(run.env || "{}") as Record<string, string>).filter(([k, v]) => k !== "LOFIWAVE_OUT_DIR" && typeEnv[k] !== v));
  return startRun({
    typeName: run.type_name, cwd: run.cwd, prompt: run.prompt, extraArgs,
    env, trigger: "restart", config: meta.config || undefined, workflow: wf, timeoutSec: meta.timeout_sec ?? 0,
    interactive: Boolean(meta.interactive), resumeSession: meta.resume_session, stopWhenIdle: meta.stop_when_idle ? true : undefined,
    idleStopSec: typeof meta.idle_stop_sec === "number" ? meta.idle_stop_sec : undefined, trust: meta.trust !== false,
    target: meta.target,
    meta: { group: meta.group, parent_run: meta.parent_run },   // a restarted worker stays in its swarm
  });
}

/** An interactive e2b run's live terminal (throws when it isn't up). */
function e2bTermOf(run: RunRow) {
  const t = e2bTerms.get(run.id);
  if (!t) throw new ApiError(409, `run ${run.id}'s sandbox terminal isn't attached (still starting, or ended)`);
  return t;
}

/** Reopen a recorded session interactively (tmux) using the agent type's resume_args. */
export async function resumeSession(runId: number, sessionId: string): Promise<RunRow> {
  const run = getRun(runId);
  const s = db.query<{ agent: string; cwd: string }, [number, string]>("SELECT agent, cwd FROM sessions WHERE run_id = ? AND session_id = ?").get(runId, sessionId);
  if (!s) throw new ApiError(404, `session ${sessionId} not found on run ${runId}`);
  // The run's own type if it is that agent (keeps its env/extra config), else the built-in type for the agent.
  const own = getType(run.type_name);
  const typeName = basename(own.command) === s.agent ? own.name : s.agent;
  // It keeps its config too, while that still exists.
  const cfg = JSON.parse(run.meta || "{}").config;
  const config = cfg && db.query("SELECT 1 FROM configs WHERE name = ?").get(cfg) ? cfg : undefined;
  return resumeAgentSession({ agent: s.agent, sessionId, cwd: s.cwd || run.cwd, typeName, env: JSON.parse(run.env || "{}"), config });
}

/**
 * Reopen any agent session by id, whether or not the console started it (e.g. a claude session from a terminal, seen on the
 * Agents tab). If that session is still open elsewhere, claude forks a copy that continues the conversation under a new id.
 */
/**
 * Reopen a session here. `replacePid`: the process that has it open now (taking it over); it is stopped first, so
 * two agents never write one transcript. Refused when that pid is on a different session.
 */
export async function resumeAgentSession(o: { agent: string; sessionId: string; cwd?: string; typeName?: string; env?: Record<string, string>; terminal?: string; replacePid?: number; config?: string }): Promise<RawRun> {
  const typeName = o.typeName ?? o.agent;
  const type = getType(typeName);
  if (!JSON.parse(type.resume_args || "[]").length) throw new ApiError(400, `process type "${typeName}" has no resume_args template`);
  if (o.replacePid && pidAlive(o.replacePid)) {
    const onIt = claudeRegistry(true).byPid.get(o.replacePid)?.sessionId;
    if (onIt && onIt !== o.sessionId) throw new ApiError(409, `pid ${o.replacePid} is on session ${onIt}, not ${o.sessionId}`);
    await stopAndWait(o.replacePid);
  }
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : (type.default_cwd || process.env.HOME || "/");
  const run = await startRun({ typeName, cwd, trigger: "resume", resumeSession: o.sessionId, env: o.env ?? {}, terminal: o.terminal, config: o.config });
  // Until the agent reports back (claude's hook, codex's index), remember what we asked it to reopen. Codex's is
  // confirmed (or marked failed) once its index shows the thread in use: see findCodexRunSession.
  recordSession(run.id, { session_id: o.sessionId, agent: o.agent, cwd, source: o.agent === "codex" ? "resume requested" : "resume" });
  return getRun(run.id);
}
type RawRun = RunRow;

/** Stop a process (through its run, when it is one of ours) and wait for it to exit, so a reopen never runs alongside it. */
async function stopAndWait(pid: number): Promise<void> {
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE pid = ? AND status = 'running'").get(pid);
  if (run) await killRun(run.id, false);
  else await killTree(pid, false);
  for (let i = 0; i < 50 && pidAlive(pid); i++) await Bun.sleep(200);
  if (pidAlive(pid)) throw new ApiError(500, `pid ${pid} did not exit after SIGTERM; not reopening the session alongside it`);
}

/**
 * Turn Remote Control on for a claude session that is already running, so it shows up in the Claude app.
 *
 * - In a tmux pane (an interactive run of ours, or any claude whose registry entry names a pane), or on macOS in an
 *   iTerm or Terminal.app tab: type `/remote-control` into it. Whatever was half-typed is cleared first with Ctrl+U,
 *   which claude keeps for Ctrl+Y.
 * - Anywhere else (another terminal app, a headless run) there is nothing to type into. With `replace`, stop that
 *   process and reopen the same conversation here in tmux with the type's resume_args (which carry --remote-control).
 */
export async function enableRemoteControl(pid: number, o: { replace?: boolean; terminal?: string } = {}): Promise<{ status: "already" | "enabled" | "pending" | "replaced"; web_url: string; run?: RunRow }> {
  const entry = claudeRegistry(true).byPid.get(pid);
  if (!entry) throw new ApiError(404, `pid ${pid} is not a running claude session (nothing in ~/.claude/sessions for it)`);
  if (entry.bridgeSessionId) return { status: "already", web_url: claudeWebUrl(entry.bridgeSessionId) };
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE pid = ? AND status = 'running'").get(pid);
  const meta = run ? JSON.parse(run.meta || "{}") : {};

  // The pane to type into: our own run's tmux session, else the pane claude says it is in — if that pane really is this pid.
  let target: string = meta.tmux ? tmuxTarget(meta.tmux) : "";
  if (!target && entry.tmux) {
    const pane = entry.tmux.split(".").pop() ?? "";
    const q = pane.startsWith("%") ? await tmux("display-message", "-p", "-t", pane, "#{pane_pid}") : null;
    if (q?.code === 0 && Number(q.out) === pid) target = pane;
  }

  // Not in tmux: on macOS, the iTerm or Terminal.app tab it is the foreground program of (null everywhere else).
  const tab = target ? null : await macTabOf(pid);

  if (target || tab) {
    if (entry.status === "busy") throw new ApiError(409, "the session is working right now; enable Remote Control once it is idle");
    if (tab) {
      try { await typeIntoMacTab(tab, "\x15/remote-control"); }  // \x15 is Ctrl+U
      catch (e: any) { throw new ApiError(500, `could not type into the ${tab.app} tab: ${e.message}`); }
    } else {
      for (const keys of [["C-u"], ["-l", "--", "/remote-control"]]) {
        const r = await tmux("send-keys", "-t", target, ...keys);
        if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
      }
      await Bun.sleep(300);                               // let the slash-command menu catch up before Enter picks it
      await tmux("send-keys", "-t", target, "Enter");
    }
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(500);
      const bridge = claudeRegistry(true).byPid.get(pid)?.bridgeSessionId;
      if (bridge) {
        const web_url = claudeWebUrl(bridge);
        if (run) { meta.remote_url = web_url; db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), run.id); }
        return { status: "enabled", web_url };
      }
    }
    return { status: "pending", web_url: "" };
  }

  if (!o.replace) throw new ApiError(409, `pid ${pid} is not in a tmux pane or terminal tab the console can type into. Pass replace: true to stop it and reopen the conversation here with Remote Control.`);
  await stopAndWait(pid);
  const own = run ? getType(run.type_name) : null;
  const typeName = own && basename(own.command) === "claude" ? own.name : "claude";
  const env = run ? JSON.parse(run.env || "{}") : {};
  const cwd = entry.cwd || run?.cwd || "";
  // A session nobody has typed into yet has no transcript, and `claude --resume` refuses it: start a fresh one there instead.
  const resumed = claudeTranscriptPath(entry.sessionId, cwd)
    ? await resumeAgentSession({ agent: "claude", sessionId: entry.sessionId, cwd, terminal: o.terminal, typeName, env })
    : await startRun({ typeName, cwd: existsSync(cwd) ? cwd : getType(typeName).default_cwd || process.env.HOME || "/", env, interactive: true, terminal: o.terminal, trigger: "manual" });
  return { status: "replaced", web_url: "", run: resumed };
}

/**
 * The codex session a run of ours is on, from Codex's thread index (0.16x runs threads in a shared app-server daemon,
 * so the run's own processes don't hold the rollout). A resume counts once the asked-for thread is used after the
 * run started; if instead a new thread shows up, the resume failed (`mismatch`). Threads other runs recorded are
 * never taken. Without a readable index, the old guess: the newest rollout in the folder.
 */
function findCodexRunSession(runId: number, startedAt: number, cwd: string, kind: "tui" | "exec", opts: StartOptions): { session_id: string; path: string; source: string; mismatch?: boolean } | null {
  if (!codexIndexReadable()) {
    if (opts.resumeSession) return { session_id: opts.resumeSession, path: codexRolloutPath(opts.resumeSession), source: "resume" };
    const f = discoverCodexSession(startedAt, cwd);
    return f && { ...f, source: "startup" };
  }
  if (opts.resumeSession) {
    const t = codexThreadTouched(opts.resumeSession, startedAt);
    if (t) return { session_id: t.id, path: t.rollout_path, source: "resume" };
  }
  const claimed = new Set(db.query<{ session_id: string }, [number]>("SELECT session_id FROM sessions WHERE agent = 'codex' AND run_id != ?").all(runId).map((r) => r.session_id));
  if (opts.resumeSession) claimed.add(opts.resumeSession);
  const t = findCodexThread({ startedAt, cwd, kind, exclude: claimed, prompt: opts.resumeSession ? "" : opts.prompt });
  if (!t) return null;
  return { session_id: t.id, path: t.rollout_path, source: "startup", mismatch: Boolean(opts.resumeSession) };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");

export function readHead(path: string | null, bytes: number): string {
  if (!path || !existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

export function readTail(path: string | null, bytes: number): string {
  if (!path || !existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** Read log bytes from `offset`; returns new data plus the new offset (for polling clients). */
export function readLogFrom(path: string | null, offset: number, maxBytes = 512 * 1024) {
  if (!path || !existsSync(path)) return { data: "", offset: 0, size: 0 };
  const size = statSync(path).size;
  const start = Math.min(Math.max(0, offset), size);
  const len = Math.min(size - start, maxBytes);
  if (len === 0) return { data: "", offset: start, size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { data: buf.toString("utf8"), offset: start + len, size };
  } finally { closeSync(fd); }
}

/** Called at startup and periodically: fix up runs whose process we no longer control. */
export function reconcileRuns() {
  const running = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running'").all();
  for (const r of running) {
    // Still starting: opening its terminal window (osascript) can take seconds, longer if the app is slow to answer.
    if (live.has(r.id) || starting.has(r.id)) continue;
    const meta = JSON.parse(r.meta || "{}");
    if (meta.target) { reattachE2B(r); continue; }
    // An interactive run whose tmux session outlived the old server: follow it again. If its program exited meanwhile,
    // the pane (remain-on-exit) still holds the exit status.
    if (meta.tmux && r.pid) {
      starting.add(r.id);
      refollow(r, meta)
        .then((how) => { if (how === "not-ours") settleUnfollowed(r, meta, false); })
        .catch((e) => console.error(`[runs] could not follow run ${r.id} again`, e))
        .finally(() => starting.delete(r.id));
      continue;
    }
    settleUnfollowed(r, meta, true);
  }
}

/** A running run nobody follows: an orphan while its process lives, else lost. `ownSession`: its tmux session may be dropped. */
function settleUnfollowed(r: RunRow, meta: Record<string, any>, ownSession: boolean) {
  if (r.pid && pidAlive(r.pid)) {
    if (!meta.orphan) { meta.orphan = true; saveMeta(r.id, meta); }
    return;
  }
  if (meta.tmux && ownSession) tmux("kill-session", "-t", tmuxTarget(meta.tmux)).catch(() => {});
  db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?")
    .run(now(), "process disappeared while the console was not running", readTail(r.log_path, config.outputTailBytes), r.id);
}

/**
 * File a transcript that came back from a target where claude looks for it on this machine (under the run's local
 * folder, else the home folder), and record it as the run's session: the run then has Transcript and "Resume here"
 * like a local one.
 */
function saveTranscript(runId: number, meta: Record<string, any>, sessionId: string, data: Buffer, source: string, write: (s: string) => void) {
  try {
    const cwd = meta.local_cwd || process.env.HOME || "/";
    const path = claudeTranscriptHome(sessionId, cwd);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    recordSession(runId, { session_id: sessionId, agent: "claude", cwd, transcript_path: path, source });
    write(`# lofiwave: transcript saved to ${path} (${data.length} bytes); "Resume here" continues it in ${cwd}`);
  } catch (e: any) {
    write(`# lofiwave: couldn't save the transcript: ${e?.message ?? e}`);
  }
}

/** startRun's TargetErrors as ApiErrors. */
function asApiErr<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof TargetError) throw new ApiError(e.status, e.message); throw e; }
}

/**
 * An e2b run that was going when the console restarted: its sandbox kept running (until its time to live ran out),
 * so connect to it again (resuming it if it paused) and pick its process back up by tag.
 */
function reattachE2B(r: RunRow) {
  const meta = JSON.parse(r.meta || "{}");
  const write = (s: string) => { if (r.log_path) appendFileSync(r.log_path, s.endsWith("\n") ? s : s + "\n"); };
  const lose = (why: string) => db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?").run(now(), why, readTail(r.log_path, config.outputTailBytes), r.id);
  let c: E2BConfig;
  try { c = e2bConfig(getTarget(meta.target)); } catch { lose(`target "${meta.target}" no longer exists`); return; }
  if (!meta.e2b?.sandbox_id) { lose("the console restarted before the sandbox was created"); return; }
  let h: E2BHandle;
  try {
    h = runE2B({
      runId: r.id, c, command: r.command, args: JSON.parse(r.args || "[]"), env: {}, interactive: Boolean(meta.interactive),
      sessionId: meta.claude_session || undefined, outDir: join(config.dataDir, "runs", String(r.id), "out"),
      forbiddenValues: [config.authToken], write, attach: { sandboxId: meta.e2b.sandbox_id, tmux: Boolean(meta.e2b.tmux) },
      onMeta: (patch) => { meta.e2b = { ...meta.e2b, ...patch }; db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), r.id); },
      saveTranscript: (sid, data) => saveTranscript(r.id, meta, sid, data, "e2b", write),
    });
  } catch (e: any) { lose(e?.message ?? String(e)); return; }
  let markDone!: () => void;
  const done = new Promise<void>((res) => (markDone = res));
  const entry: LiveEntry = { pid: 0, done, cancel: h.cancel };
  live.set(r.id, entry);
  (async () => {
    const res = await h.done;
    if (res.message) write(`# e2b: ${res.message}`);
    const status = entry.killedBy === "timeout" ? "timeout" : entry.killedBy ? "killed" : res.code === 0 ? "success" : res.code === null ? "lost" : "failed";
    write(`\n# lofiwave: exited with code ${res.code ?? "unknown"} (${status})`);
    live.delete(r.id);
    db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?").run(status, now(), res.code, readTail(r.log_path, config.outputTailBytes), res.code === null && !entry.killedBy ? res.message : "", r.id);
    markDone();
  })();
}

/** A target's ApiError: the same status and message. */
function targetOf(name: string) {
  try { return getTarget(name); } catch (e) { if (e instanceof TargetError) throw new ApiError(e.status, e.message); throw e; }
}

export function isLive(id: number) { return live.has(id); }
export function liveRunIds() { return [...live.keys()]; }

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { hydrate };
