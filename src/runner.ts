/**
 * Starts and tracks managed processes ("runs"). Every process started through the
 * console — ad-hoc or from a workflow — is a row in `runs` with its own log file.
 */
import { join, basename, dirname } from "node:path";
import { existsSync, statSync, openSync, readSync, closeSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db, now, hydrate, type ProcessTypeRow, type RunRow, type WorkflowRow } from "./db";
import { config, logDir } from "./config";
import { killTree, pidAlive } from "./procs";
import { discoverCodexSession, codexRolloutPath, codexIndexReadable, findCodexThread, codexThreadTouched, claudeRegistry, claudeWebUrl, claudeTranscriptPath, claudeTranscriptHome } from "./agents";
import { openTerminalForTmux, macTabOf, typeIntoMacTab } from "./terminal";
import { actor } from "./auth";
import { ttyViewers } from "./tty";
import { chatSettingsPath } from "./chat/settings";
import { getTarget, targetConfig, startCloudRunJob, followCloudRun, cancelCloudRun, jobName, TargetError, TranscriptCatcher, e2bConfig, type CloudRunHandle, type E2BConfig } from "./targets";
import { runE2B, sandboxEnv, e2bTerms, type E2BHandle } from "./e2b";
import { keyBytes } from "./vtscreen";

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
  /** Interactive claude runs: end the run once the agent has finished its work and sat idle (config.idleStopSec). */
  stopWhenIdle?: boolean;
  /**
   * Run on this target (a targets.name) instead of this machine; `cwd` is ignored (the target says where). Headless,
   * except on an e2b target, where an interactive run gets a live terminal in its sandbox.
   */
  target?: string;
  /** e2b targets: a local folder uploaded to the sandbox's `<workdir>/in/` before the agent starts. */
  inputDir?: string;
};

/** Stop a live entry: on its target, or its local process tree. */
function stopEntry(entry: LiveEntry, force: boolean): Promise<void> {
  return entry.cancel ? entry.cancel() : killTree(entry.pid, force);
}

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
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.replace(/\n$/, ""), err: err.trim() };
}

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

export function buildCommand(type: ProcessTypeRow, opts: { cwd: string; prompt?: string; extraArgs?: string[]; interactive?: boolean; resumeSession?: string; permissionMode?: string }) {
  const templateArgs = templateFor(type, Boolean(opts.interactive), Boolean(opts.resumeSession));
  const prompt = opts.prompt ?? "";
  const needsPrompt = templateArgs.some((a) => a.includes("{prompt}")) || type.command.includes("{prompt}");
  // Interactive sessions can start empty: the user types (or Remote Control sends) the first message. Drop {prompt} args then.
  if (needsPrompt && !prompt.trim() && !opts.interactive) throw new ApiError(400, `process type "${type.name}" requires a prompt`);
  const vars = { prompt, cwd: opts.cwd, session: opts.resumeSession ?? "" };
  const kept = prompt.trim() ? templateArgs : templateArgs.filter((a) => !a.includes("{prompt}"));
  const command = substitute(type.command, vars);
  const templ = kept.map((a) => substitute(a, vars));
  const extra = opts.extraArgs ?? [];
  // The configured default mode goes in with the template (so restarts don't count it as an extra arg); args that pick a mode win.
  const picksMode = [...templ, ...extra].some((a) => a === "--dangerously-skip-permissions" || a === "--permission-mode" || a.startsWith("--permission-mode="));
  const mode = opts.permissionMode || config.claudePermissionMode;
  if (mode && basename(command) === "claude" && !picksMode) templ.push("--permission-mode", mode);
  // The same for codex's sandbox (CODEX_SANDBOX_MODE). --full-auto is gone from Codex but still counts as a choice.
  const picksSandbox = [...templ, ...extra].some((a) => /^(-s|--sandbox(=.*)?|--dangerously-bypass-approvals-and-sandbox|--full-auto|--approve-for-me)$/.test(a) || /^sandbox_mode\s*=/.test(a));
  if (config.codexSandboxMode && basename(command) === "codex" && !picksSandbox) templ.push("--sandbox", config.codexSandboxMode);
  // Interactive claude runs get lofiwave's hooks and statusline (src/chat/settings.ts): approvals, streaming text, usage
  // and per-turn checkpoints in the chat view. They merge with the user's and the project's hooks. A run that brings
  // its own --settings is left alone.
  const picksSettings = [...templ, ...extra].some((a) => a === "--settings" || a.startsWith("--settings="));
  if ((opts.interactive || opts.resumeSession) && basename(command) === "claude" && !picksSettings) templ.push("--settings", chatSettingsPath());
  return { command, args: [...templ, ...extra], template_len: templ.length };
}

export async function startRun(opts: StartOptions): Promise<RunRow> {
  const type = getType(opts.typeName);
  const target = opts.target ? targetOf(opts.target) : null;
  const e2b = target?.kind === "e2b" ? asApiErr(() => e2bConfig(target)) : null;
  if (target && opts.resumeSession) throw new ApiError(400, `runs on target "${target.name}" can't resume a session`);
  if (target && opts.interactive && !e2b) throw new ApiError(400, `runs on target "${target.name}" are headless: they can't be interactive`);
  if (opts.inputDir && !e2b) throw new ApiError(400, "input_dir is for runs on an e2b target");
  if (opts.inputDir && (!existsSync(opts.inputDir) || !statSync(opts.inputDir).isDirectory())) throw new ApiError(400, `input_dir does not exist: ${opts.inputDir}`);
  // On a target, the process runs in the target's folder (a container's workdir, or the repo it clones).
  const tc = target ? targetConfig(target) : null;
  const cwd = e2b ? e2b.workdir : tc ? (tc.repo ? tc.workdir || "/workspace" : tc.workdir || "/") : opts.cwd?.trim();
  if (!cwd) throw new ApiError(400, "cwd is required");
  if (!target && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new ApiError(400, `cwd does not exist: ${cwd}`);
  const interactive = Boolean(opts.interactive) || Boolean(opts.resumeSession);
  if (interactive && !e2b && !tmuxPath()) throw new ApiError(400, "interactive runs need tmux on PATH (brew install tmux / apt install tmux)");
  let { command, args, template_len } = buildCommand(type, { ...opts, cwd, permissionMode: e2b?.permission_mode });
  // Remote Control needs a claude.ai login: in a sandbox that only has an API key, leave it out.
  if (e2b && !sandboxEnv(e2b, { ...JSON.parse(type.env || "{}"), ...(opts.env ?? {}) }, [config.authToken]).CLAUDE_CODE_OAUTH_TOKEN) {
    const drop = args.slice(0, template_len).filter((a) => a === "--remote-control").length;
    if (drop) { args = [...args.slice(0, template_len).filter((a) => a !== "--remote-control"), ...args.slice(template_len)]; template_len -= drop; }
  }
  // A claude run on a target gets a session id picked here, so its transcript can come back as a session of this run
  // (the container prints it into the logs at the end; see TRANSCRIPT_MARK). It goes in with the template, so a restart
  // picks a new one rather than carrying this one as an extra arg.
  const picksSession = args.some((a) => ["--session-id", "--resume", "-r", "--continue", "-c"].includes(a) || a.startsWith("--session-id="));
  const cloudSession = target && basename(command) === "claude" && !picksSession ? randomUUID() : "";
  if (cloudSession) { args = [...args.slice(0, template_len), "--session-id", cloudSession, ...args.slice(template_len)]; template_len += 2; }
  const typeEnv: Record<string, string> = JSON.parse(type.env || "{}");
  const env = { ...typeEnv, ...(opts.env ?? {}) };
  const t = now();
  const timeoutSec = opts.timeoutSec ?? opts.workflow?.timeout_sec ?? 0;
  const meta: Record<string, any> = { timeout_sec: timeoutSec, template_len };
  if (opts.resumeSession) meta.resume_session = opts.resumeSession;
  if (opts.stopWhenIdle && interactive) meta.stop_when_idle = true;
  if (args.includes(chatSettingsPath())) { meta.approvals = true; meta.live = true; }
  // Who started it: the logged-in person (or "api" for the token), when it comes from a request; scheduled runs have none.
  const by = actor.getStore();
  if (by) meta.started_by = by;
  if (target) {
    meta.target = target.name; meta.target_kind = target.kind;
    // The folder on this machine its transcript is filed under, so "Resume here" opens it there.
    const local = opts.cwd?.trim();
    if (local && existsSync(local) && statSync(local).isDirectory()) meta.local_cwd = local;
    if (cloudSession) meta.claude_session = cloudSession;
  }
  const isCodex = basename(command) === "codex" && !target;

  const ins = db.prepare(
    `INSERT INTO runs (workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger, status, started_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    opts.workflow?.id ?? null, opts.workflow?.name ?? null, type.name, cwd, command, JSON.stringify(args),
    opts.prompt ?? "", JSON.stringify(env), opts.trigger, t, JSON.stringify(meta),
  );
  const id = Number(ins.lastInsertRowid);
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

  // Commits made in this run are authored by the person who started it (GIT_AUTHORS), when we know them.
  const author = by ? config.gitAuthors.get(by.trim().split(/\s+/)[0].toLowerCase()) : undefined;
  const gitEnv: Record<string, string> = author
    ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
    : {};
  if (author) meta.git_author = `${author.name} <${author.email}>`;

  const childEnv = {
    ...process.env, ...gitEnv, ...env,
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
        runId: id, c: e2b, command, args, env, interactive, sessionId: cloudSession || undefined,
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
  } else if (target) {
    // Nothing runs here: the job starts on the target (that takes a while, so in the background) and we follow it.
    // Only the run's own env goes along: not this machine's environment, and never the console's token.
    entry = { pid: 0, done };
    const job = jobName(opts.workflow ? `wf-${opts.workflow.id}` : `${type.name}-adhoc`);
    let handle: CloudRunHandle | null = null;
    const write = (s: string) => { sink.write(s.endsWith("\n") ? s : s + "\n"); sink.flush(); };
    let cancelled = false;
    entry.cancel = async () => { cancelled = true; if (handle) await cancelCloudRun(target, handle); };
    exited = (async () => {
      try {
        handle = await startCloudRunJob(target, { job, command, args, env, timeoutSec, runId: id, sessionId: cloudSession || undefined }, write);
        meta.cloud_run = handle;
        db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
        if (cancelled) await cancelCloudRun(target, handle).catch(() => {});
        const catcher = cloudSession ? new TranscriptCatcher(cloudSession) : undefined;
        const r = await followCloudRun(target, handle, write, { catcher });
        if (r.message) write(`# cloud run: ${r.message}`);
        if (catcher) saveCloudTranscript(id, meta, catcher, write);
        return r.code;
      } catch (e: any) {
        if (cancelled && !handle) return null;
        entry.error = e?.message ?? String(e);
        write(`# cloud run: ${entry.error}`);
        return null;
      }
    })();
  } else if (interactive) {
    // A detached tmux session owns the pty; we track the pane's process and poll its exit status.
    const sess = meta.tmux as string;
    const envFlags = Object.entries({ ...gitEnv, ...env, PATH: childEnv.PATH ?? "", AGENT_CONSOLE_RUN_ID: childEnv.AGENT_CONSOLE_RUN_ID, AGENT_CONSOLE_URL: childEnv.AGENT_CONSOLE_URL, AGENT_CONSOLE_TOKEN: childEnv.AGENT_CONSOLE_TOKEN })
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const created = await tmux("new-session", "-d", "-s", sess, "-c", cwd, "-x", "180", "-y", "48", ...envFlags, "--", command, ...args);
    if (created.code !== 0) await fail(`failed to start tmux session: ${created.err || created.out}`);
    await tmux("set-option", "-t", tmuxTarget(sess), "remain-on-exit", "on");
    const pane = await tmux("display-message", "-p", "-t", tmuxTarget(sess), "#{pane_pid}");
    const pid = Number(pane.out);
    if (!pid) await fail(`could not read the tmux pane pid: ${pane.err || pane.out}`);
    entry = { pid, tmux: sess, done };
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
    exited = (async () => {
      let ticks = 0;
      // stop_when_idle: claude's own registry says busy while it works, waiting on a permission prompt, idle when done.
      let sawBusy = false, idleSince = 0;
      for (;;) {
        await Bun.sleep(1000);
        const q = await tmux("display-message", "-p", "-t", tmuxTarget(sess), "#{pane_dead} #{pane_dead_status}");
        // Session vanished (killed from outside). With other sessions still on the server, display-message -p exits 0
        // and prints the format with every field empty (here " ") instead of failing.
        if (q.code !== 0 || !q.out.trim()) return null;
        const [dead, status] = q.out.split(" ");
        if (dead === "1") return status === "" ? null : Number(status);
        // Codex has no hook: find its thread in Codex's index and record the session.
        if (isCodex && !meta.codex_session && ticks % 3 === 0) {
          const found = findCodexRunSession(id, t, cwd, "tui", opts);
          if (found) {
            meta.codex_session = found.session_id;
            if (found.mismatch) {
              meta.resume_mismatch = { asked: opts.resumeSession, got: found.session_id };
              sink.write(`\n# lofiwave: asked codex to resume ${opts.resumeSession}, but it started a new session ${found.session_id}\n`); sink.flush();
              db.prepare("UPDATE sessions SET source = 'resume failed' WHERE run_id = ? AND session_id = ?").run(id, opts.resumeSession!);
            }
            db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
            recordSession(id, { session_id: found.session_id, agent: "codex", cwd, transcript_path: found.path, source: found.source });
          }
        }
        if (meta.stop_when_idle && !entry.killedBy && ticks % 3 === 0) {
          const st = claudeRegistry().byPid.get(pid)?.status;
          if (st === "idle" && sawBusy) {
            idleSince ||= Date.now();
            // Someone with the terminal open may be about to type: wait until they close it.
            if (Date.now() - idleSince >= config.idleStopSec * 1000 && !ttyViewers.has(sess)) {
              entry.killedBy = "idle";
              // claude clears its screen on the way out: keep what it showed last (its answer) before closing it.
              const last = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(sess));
              if (last.code === 0) sink.write(last.out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
              sink.write(`\n# lofiwave: finished, idle for ${config.idleStopSec}s; closing the session\n`);
              killTree(pid, false).catch(() => {});
            }
          } else if (st) {
            if (st !== "idle") sawBusy = true;
            idleSince = 0;
          }
        }
        // Claude Code prints its Remote Control link once it is up; keep it on the run so the UI can open the session in the Claude app.
        ticks++;
        if (!meta.remote_url && ticks < 120 && ticks % 2 === 0) {
          const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(sess));
          const m = cap.code === 0 ? /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(cap.out) : null;
          if (m) { meta.remote_url = m[0]; db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id); }
        }
      }
    })();
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

  (async () => {
    const code = await exited;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.tmux) {
      // Keep what was on screen (scrollback included) as the run's record, then drop the dead session.
      const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(entry.tmux), "-S", "-2000");
      if (cap.code === 0) sink.write(cap.out.replace(/^Pane is dead.*$/m, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
      await tmux("kill-session", "-t", tmuxTarget(entry.tmux));
    }
    const status = entry.error ? "error" : entry.killedBy === "timeout" ? "timeout" : entry.killedBy === "idle" ? "success" : entry.killedBy ? "killed" : code === 0 ? "success" : code === null ? "lost" : "failed";
    sink.write(`\n# lofiwave: exited with code ${code ?? "unknown"} (${status})\n`);
    await sink.end();
    if (isCodex && !meta.codex_session) {
      // `codex exec` prints "session id: <uuid>" in its header (with --json: a thread.started event first), so look at
      // the start of the log, not only the end. Colours are stripped first. Failing that, Codex's index.
      const text = stripAnsi(readHead(logPath, 64 * 1024) + "\n" + readTail(logPath, 64 * 1024));
      const m = /session id:\s*([0-9a-f-]{36})/.exec(text) ?? /"thread\.started","thread_id":"([0-9a-f-]{36})"/.exec(text);
      const found = m ? { session_id: m[1], path: codexRolloutPath(m[1]), source: "startup" } : findCodexRunSession(id, t, cwd, interactive ? "tui" : "exec", opts);
      if (found) recordSession(id, { session_id: found.session_id, agent: "codex", cwd, transcript_path: found.path, source: found.source });
      // Asked to resume and never seen using that thread (a wrong id: codex exits with "No saved session found").
      if (opts.resumeSession && found?.source !== "resume") db.prepare("UPDATE sessions SET source = 'resume failed' WHERE run_id = ? AND session_id = ? AND source = 'resume requested'").run(id, opts.resumeSession);
    }
    live.delete(id);
    db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?")
      .run(status, now(), code, readTail(logPath, config.outputTailBytes), entry.error ?? (code === null && !entry.killedBy ? (entry.lostWhy ? entry.lostWhy : target ? "the execution ended without a result (cancelled outside lofiwave?)" : "tmux session disappeared") : ""), id);
    markDone();
  })();

  return getRun(id);
}

/** Current contents of an interactive run's terminal (last `lines` of scrollback + screen). */
export async function screenOf(run: RunRow, lines = 200, cols = 0): Promise<{ text: string; alive: boolean; cols: number }> {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.e2b && meta.interactive) {
    const t = e2bTerms.get(run.id);
    if (!t) return { text: "", alive: false, cols: 0 };
    if (cols >= 40 && cols <= 220 && cols !== t.cols && run.status === "running" && !t.viewers.size) await t.resize(cols, cols < 100 ? 40 : 48);
    return { text: t.screen.text(lines).replace(/\n{3,}/g, "\n\n"), alive: run.status === "running", cols: t.cols };
  }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  let width = 0;
  const size = await tmux("display-message", "-p", "-t", tmuxTarget(meta.tmux), "#{window_width}");
  if (size.code === 0) width = Number(size.out) || 0;
  // A phone can't show 180 columns: resize the window to the viewer's width and the TUI reflows (SIGWINCH), like a real terminal would.
  if (cols >= 40 && cols <= 220 && width && cols !== width && run.status === "running" && !ttyViewers.has(meta.tmux)) {
    const r = await tmux("resize-window", "-t", tmuxTarget(meta.tmux), "-x", String(cols), "-y", String(cols < 100 ? 40 : 48));
    if (r.code === 0) width = cols;
  }
  const cap = await tmux("capture-pane", "-p", "-J", "-t", tmuxTarget(meta.tmux), "-S", String(-lines));
  if (cap.code !== 0) return { text: "", alive: false, cols: width };
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

/** Type text and/or named keys (tmux names: Up, Down, Escape, C-c, Tab ...) into an interactive run's terminal, then optionally Enter. */
export async function sendKeys(run: RunRow, text: string, keys: string[], enter: boolean): Promise<void> {
  const meta = JSON.parse(run.meta || "{}");
  if (meta.e2b && meta.interactive) {
    if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
    const bytes = keys.map((k) => { const b = keyBytes(k); if (b === null) throw new ApiError(400, `bad key name: ${k}`); return b; });
    const t = e2bTermOf(run);
    if (text) await t.input(text);
    for (const b of bytes) await t.input(b);
    // Like typing: a TUI that sees text and Enter in one read can take the Enter as part of a paste.
    if (enter) { if (text) await Bun.sleep(150); await t.input("\r"); }
    return;
  }
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
  if (text) {
    const r = await tmux("send-keys", "-t", tmuxTarget(meta.tmux), "-l", "--", text);
    if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
  }
  for (const k of keys) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new ApiError(400, `bad key name: ${k}`);
    const r = await tmux("send-keys", "-t", tmuxTarget(meta.tmux), k);
    if (r.code !== 0) throw new ApiError(400, `tmux did not accept key "${k}": ${r.err}`);
  }
  if (enter) await tmux("send-keys", "-t", tmuxTarget(meta.tmux), "Enter");
}

export async function killRun(id: number, force = false): Promise<RunRow> {
  const run = getRun(id);
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
  return startRun({
    typeName: run.type_name, cwd: run.cwd, prompt: run.prompt, extraArgs,
    env: JSON.parse(run.env || "{}"), trigger: "restart", workflow: wf, timeoutSec: meta.timeout_sec ?? 0,
    interactive: Boolean(meta.interactive), resumeSession: meta.resume_session, stopWhenIdle: Boolean(meta.stop_when_idle),
    target: meta.target,
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
  return resumeAgentSession({ agent: s.agent, sessionId, cwd: s.cwd || run.cwd, typeName, env: JSON.parse(run.env || "{}") });
}

/**
 * Reopen any agent session by id, whether or not the console started it (e.g. a claude session from a terminal, seen on the
 * Agents tab). If that session is still open elsewhere, claude forks a copy that continues the conversation under a new id.
 */
export async function resumeAgentSession(o: { agent: string; sessionId: string; cwd?: string; typeName?: string; env?: Record<string, string>; terminal?: string }): Promise<RawRun> {
  const typeName = o.typeName ?? o.agent;
  const type = getType(typeName);
  if (!JSON.parse(type.resume_args || "[]").length) throw new ApiError(400, `process type "${typeName}" has no resume_args template`);
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : (type.default_cwd || process.env.HOME || "/");
  const run = await startRun({ typeName, cwd, trigger: "resume", resumeSession: o.sessionId, env: o.env ?? {}, terminal: o.terminal });
  // Until the agent reports back (claude's hook, codex's index), remember what we asked it to reopen. Codex's is
  // confirmed (or marked failed) once its index shows the thread in use: see findCodexRunSession.
  recordSession(run.id, { session_id: o.sessionId, agent: o.agent, cwd, source: o.agent === "codex" ? "resume requested" : "resume" });
  return getRun(run.id);
}
type RawRun = RunRow;

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
  if (run) await killRun(run.id, false);
  else await killTree(pid, false);
  for (let i = 0; i < 50 && pidAlive(pid); i++) await Bun.sleep(200);
  if (pidAlive(pid)) throw new ApiError(500, `pid ${pid} did not exit after SIGTERM; not reopening the session alongside it`);
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
    const m = JSON.parse(r.meta || "{}");
    if (m.target && m.target_kind === "e2b") { reattachE2B(r); continue; }
    if (m.target) { reattachRemote(r); continue; }
    if (r.pid && pidAlive(r.pid)) {
      const meta = JSON.parse(r.meta || "{}");
      if (!meta.orphan) {
        meta.orphan = true;
        db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), r.id);
      }
      continue;
    }
    const meta = JSON.parse(r.meta || "{}");
    if (meta.tmux) tmux("kill-session", "-t", tmuxTarget(meta.tmux)).catch(() => {});
    db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?")
      .run(now(), "process disappeared while the console was not running", readTail(r.log_path, config.outputTailBytes), r.id);
  }
}

/**
 * File the transcript a cloud run handed back where claude looks for it on this machine (under the run's local folder,
 * else the home folder), and record it as the run's session: the run then has Transcript and "Resume here" like a local one.
 */
function saveCloudTranscript(runId: number, meta: Record<string, any>, catcher: TranscriptCatcher, write: (s: string) => void) {
  if (!catcher.started) { write("# lofiwave: no transcript came back from the container (it was stopped before claude wrote one, or the image lacks sh/base64/fold/awk)"); return; }
  try {
    saveTranscript(runId, meta, catcher.sessionId, catcher.result(), "cloud-run", write);
  } catch (e: any) {
    write(`# lofiwave: couldn't bring the transcript back: ${e?.message ?? e}`);
  }
}

/** File a transcript that came back from a target, and record it as the run's session. */
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
      forbiddenValues: [config.authToken], write, attach: { sandboxId: meta.e2b.sandbox_id },
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

/**
 * A run on a target that was still going when the console restarted: it kept running there, so follow it again.
 * One that never got as far as starting an execution is lost.
 */
function reattachRemote(r: RunRow) {
  const meta = JSON.parse(r.meta || "{}");
  const handle: CloudRunHandle | undefined = meta.cloud_run;
  let target: ReturnType<typeof getTarget> | null = null;
  try { target = getTarget(meta.target); } catch { /* deleted since */ }
  if (!handle || !target) {
    db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?")
      .run(now(), handle ? `target "${meta.target}" no longer exists` : "the console restarted before the job started", readTail(r.log_path, config.outputTailBytes), r.id);
    return;
  }
  let markDone!: () => void;
  const done = new Promise<void>((res) => (markDone = res));
  const entry: LiveEntry = { pid: 0, done, cancel: () => cancelCloudRun(target!, handle) };
  live.set(r.id, entry);
  const write = (s: string) => { if (r.log_path) appendFileSync(r.log_path, s.endsWith("\n") ? s : s + "\n"); };
  (async () => {
    // Lines up to the log's last write are already in the file; a little overlap beats losing what Cloud Logging ingested late.
    const lastWrite = r.log_path && existsSync(r.log_path) ? statSync(r.log_path).mtimeMs : r.started_at;
    write(`# lofiwave: console restarted; following execution ${handle.execution} again`);
    const catcher = meta.claude_session ? new TranscriptCatcher(meta.claude_session) : undefined;
    const res = await followCloudRun(target!, handle, write, { resumeSince: new Date(lastWrite - 30_000).toISOString(), catcher }).catch((e) => ({ code: null, message: String(e?.message ?? e) }));
    if (res.message) write(`# cloud run: ${res.message}`);
    if (catcher) saveCloudTranscript(r.id, meta, catcher, write);
    const status = entry.killedBy ? "killed" : res.code === 0 ? "success" : res.code === null ? "lost" : "failed";
    write(`\n# lofiwave: exited with code ${res.code ?? "unknown"} (${status})`);
    live.delete(r.id);
    db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ? WHERE id = ?").run(status, now(), res.code, readTail(r.log_path, config.outputTailBytes), r.id);
    markDone();
  })();
}

export function isLive(id: number) { return live.has(id); }
export function liveRunIds() { return [...live.keys()]; }

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { hydrate };
