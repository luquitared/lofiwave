/**
 * Starts and tracks managed processes ("runs"). Every process started through the
 * console — ad-hoc or from a workflow — is a row in `runs` with its own log file.
 */
import { join, basename } from "node:path";
import { existsSync, statSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
import { db, now, hydrate, type ProcessTypeRow, type RunRow, type WorkflowRow } from "./db";
import { config, logDir } from "./config";
import { killTree, pidAlive } from "./procs";
import { discoverCodexSession, codexRolloutPath, claudeRegistry, claudeWebUrl, claudeTranscriptPath } from "./agents";
import { openTerminalForTmux } from "./terminal";
import { actor } from "./auth";
import { ttyViewers } from "./tty";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** In-memory handles for runs started by this server process. */
type LiveEntry = {
  pid: number;
  proc?: Bun.Subprocess;      // direct child (normal runs)
  tmux?: string;              // tmux session name (interactive runs)
  timer?: ReturnType<typeof setTimeout>;
  killedBy?: string;
  done: Promise<void>;
};
const live = new Map<number, LiveEntry>();

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
};

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

async function tmux(...args: string[]): Promise<{ code: number; out: string; err: string }> {
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

export function buildCommand(type: ProcessTypeRow, opts: { cwd: string; prompt?: string; extraArgs?: string[]; interactive?: boolean; resumeSession?: string }) {
  const templateArgs = templateFor(type, Boolean(opts.interactive), Boolean(opts.resumeSession));
  const prompt = opts.prompt ?? "";
  const needsPrompt = templateArgs.some((a) => a.includes("{prompt}")) || type.command.includes("{prompt}");
  // Interactive sessions can start empty: the user types (or Remote Control sends) the first message. Drop {prompt} args then.
  if (needsPrompt && !prompt.trim() && !opts.interactive) throw new ApiError(400, `process type "${type.name}" requires a prompt`);
  const vars = { prompt, cwd: opts.cwd, session: opts.resumeSession ?? "" };
  const kept = prompt.trim() ? templateArgs : templateArgs.filter((a) => !a.includes("{prompt}"));
  const args = [...kept.map((a) => substitute(a, vars)), ...(opts.extraArgs ?? [])];
  return { command: substitute(type.command, vars), args, template_len: kept.length };
}

export async function startRun(opts: StartOptions): Promise<RunRow> {
  const type = getType(opts.typeName);
  const cwd = opts.cwd?.trim();
  if (!cwd) throw new ApiError(400, "cwd is required");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ApiError(400, `cwd does not exist: ${cwd}`);
  const interactive = Boolean(opts.interactive) || Boolean(opts.resumeSession);
  if (interactive && !tmuxPath()) throw new ApiError(400, "interactive runs need tmux on PATH (brew install tmux / apt install tmux)");
  const { command, args, template_len } = buildCommand(type, opts);
  const typeEnv: Record<string, string> = JSON.parse(type.env || "{}");
  const env = { ...typeEnv, ...(opts.env ?? {}) };
  const t = now();
  const timeoutSec = opts.timeoutSec ?? opts.workflow?.timeout_sec ?? 0;
  const meta: Record<string, any> = { timeout_sec: timeoutSec, template_len };
  if (opts.resumeSession) meta.resume_session = opts.resumeSession;
  // Who started it: the logged-in person (or "api" for the token), when it comes from a request; scheduled runs have none.
  const by = actor.getStore();
  if (by) meta.started_by = by;
  const isCodex = basename(command) === "codex";

  const ins = db.prepare(
    `INSERT INTO runs (workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger, status, started_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    opts.workflow?.id ?? null, opts.workflow?.name ?? null, type.name, cwd, command, JSON.stringify(args),
    opts.prompt ?? "", JSON.stringify(env), opts.trigger, t, JSON.stringify(meta),
  );
  const id = Number(ins.lastInsertRowid);
  const logPath = join(logDir, `run-${id}.log`);
  if (interactive) { meta.interactive = true; meta.tmux = tmuxSessionName(id); }
  db.prepare("UPDATE runs SET log_path = ?, meta = ? WHERE id = ?").run(logPath, JSON.stringify(meta), id);

  const sink = Bun.file(logPath).writer();
  const header = `# agent-console run ${id} | ${new Date(t).toISOString()} | cwd=${cwd}\n# $ ${[command, ...args].map(shellQuote).join(" ")}\n` +
    (interactive ? `# interactive: tmux session "${meta.tmux}" (attach with: tmux attach -t ${meta.tmux}); the screen is captured here when it ends\n` : "") + "\n";
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
    sink.write(`\n${msg}\n`);
    await sink.end();
    db.prepare("UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ?").run(now(), msg, id);
    throw new ApiError(400, msg);
  };

  let markDone!: () => void;
  const done = new Promise<void>((res) => (markDone = res));
  let entry: LiveEntry;
  let exited: Promise<number | null>;

  if (interactive) {
    // A detached tmux session owns the pty; we track the pane's process and poll its exit status.
    const sess = meta.tmux as string;
    const envFlags = Object.entries({ ...gitEnv, ...env, PATH: childEnv.PATH ?? "", AGENT_CONSOLE_RUN_ID: childEnv.AGENT_CONSOLE_RUN_ID, AGENT_CONSOLE_URL: childEnv.AGENT_CONSOLE_URL, AGENT_CONSOLE_TOKEN: childEnv.AGENT_CONSOLE_TOKEN })
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const created = await tmux("new-session", "-d", "-s", sess, "-c", cwd, "-x", "180", "-y", "48", ...envFlags, "--", command, ...args);
    if (created.code !== 0) await fail(`failed to start tmux session: ${created.err || created.out}`);
    await tmux("set-option", "-t", sess, "remain-on-exit", "on");
    const pane = await tmux("display-message", "-p", "-t", sess, "#{pane_pid}");
    const pid = Number(pane.out);
    if (!pid) await fail(`could not read the tmux pane pid: ${pane.err || pane.out}`);
    entry = { pid, tmux: sess, done };
    // Show the session on this machine's desktop too. Failing to find a terminal is not fatal:
    // the run keeps going in tmux, and the console's own screen view still works.
    const term = await openTerminalForTmux(sess, { terminal: opts.terminal });
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
      for (;;) {
        await Bun.sleep(1000);
        const q = await tmux("display-message", "-p", "-t", sess, "#{pane_dead} #{pane_dead_status}");
        if (q.code !== 0) return null;                    // session vanished (killed from outside)
        const [dead, status] = q.out.split(" ");
        if (dead === "1") return status === "" ? null : Number(status);
        // Codex has no hook: find the rollout file it just created and record the session.
        if (isCodex && !meta.codex_session && ticks % 5 === 0) {
          const found = opts.resumeSession ? { session_id: opts.resumeSession, path: codexRolloutPath(opts.resumeSession) } : discoverCodexSession(t, cwd);
          if (found) { meta.codex_session = found.session_id; db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id); recordSession(id, { session_id: found.session_id, agent: "codex", cwd, transcript_path: found.path, source: opts.resumeSession ? "resume" : "startup" }); }
        }
        // Claude Code prints its Remote Control link once it is up; keep it on the run so the UI can open the session in the Claude app.
        ticks++;
        if (!meta.remote_url && ticks < 120 && ticks % 2 === 0) {
          const cap = await tmux("capture-pane", "-p", "-J", "-t", sess);
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

  db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(entry.pid, id);
  if (opts.workflow) db.prepare("UPDATE workflows SET last_run_at = ? WHERE id = ?").run(t, opts.workflow.id);
  live.set(id, entry);
  if (timeoutSec > 0) {
    entry.timer = setTimeout(() => {
      entry.killedBy = "timeout";
      sink.write(`\n# agent-console: timeout after ${timeoutSec}s, killing process tree\n`);
      killTree(entry.pid, true).catch(() => {});
    }, timeoutSec * 1000);
  }

  (async () => {
    const code = await exited;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.tmux) {
      // Keep what was on screen (scrollback included) as the run's record, then drop the dead session.
      const cap = await tmux("capture-pane", "-p", "-J", "-t", entry.tmux, "-S", "-2000");
      if (cap.code === 0) sink.write(cap.out.replace(/^Pane is dead.*$/m, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
      await tmux("kill-session", "-t", entry.tmux);
    }
    const status = entry.killedBy === "timeout" ? "timeout" : entry.killedBy ? "killed" : code === 0 ? "success" : code === null ? "lost" : "failed";
    sink.write(`\n# agent-console: exited with code ${code ?? "unknown"} (${status})\n`);
    await sink.end();
    if (isCodex && !meta.codex_session) {
      // `codex exec` prints "session id: <uuid>" in its header.
      const m = /session id:\s*([0-9a-f-]{36})/.exec(readTail(logPath, 64 * 1024));
      if (m) recordSession(id, { session_id: m[1], agent: "codex", cwd, transcript_path: codexRolloutPath(m[1]), source: "startup" });
    }
    live.delete(id);
    db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?")
      .run(status, now(), code, readTail(logPath, config.outputTailBytes), code === null && !entry.killedBy ? "tmux session disappeared" : "", id);
    markDone();
  })();

  return getRun(id);
}

/** Current contents of an interactive run's terminal (last `lines` of scrollback + screen). */
export async function screenOf(run: RunRow, lines = 200, cols = 0): Promise<{ text: string; alive: boolean; cols: number }> {
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  let width = 0;
  const size = await tmux("display-message", "-p", "-t", meta.tmux, "#{window_width}");
  if (size.code === 0) width = Number(size.out) || 0;
  // A phone can't show 180 columns: resize the window to the viewer's width and the TUI reflows (SIGWINCH), like a real terminal would.
  if (cols >= 40 && cols <= 220 && width && cols !== width && run.status === "running" && !ttyViewers.has(meta.tmux)) {
    const r = await tmux("resize-window", "-t", meta.tmux, "-x", String(cols), "-y", String(cols < 100 ? 40 : 48));
    if (r.code === 0) width = cols;
  }
  const cap = await tmux("capture-pane", "-p", "-J", "-t", meta.tmux, "-S", String(-lines));
  if (cap.code !== 0) return { text: "", alive: false, cols: width };
  // TUIs pin their input box to the bottom of the pane; collapse the padding so the useful part fits on a phone.
  return { text: cap.out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), alive: run.status === "running", cols: width };
}

/**
 * The pane's scrollback plus screen with colors (escape sequences kept, wrapped lines joined), for a viewer's
 * private scrolled-back view. Read-only: unlike scrolling inside tmux (copy-mode, shared by every viewer of the
 * pane), this moves nobody else's screen.
 */
export async function historyOf(run: RunRow, lines = 5000): Promise<{ text: string }> {
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  const cap = await tmux("capture-pane", "-p", "-e", "-J", "-t", meta.tmux, "-S", String(-lines));
  if (cap.code !== 0) throw new ApiError(409, `run ${run.id} has no terminal`);
  return { text: cap.out.replace(/(\n(\x1b\[[0-9;]*m|\s)*)+$/, "") };
}

/** Type text and/or named keys (tmux names: Up, Down, Escape, C-c, Tab ...) into an interactive run's terminal, then optionally Enter. */
export async function sendKeys(run: RunRow, text: string, keys: string[], enter: boolean): Promise<void> {
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux) throw new ApiError(400, `run ${run.id} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${run.id} is not running`);
  if (text) {
    const r = await tmux("send-keys", "-t", meta.tmux, "-l", "--", text);
    if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
  }
  for (const k of keys) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new ApiError(400, `bad key name: ${k}`);
    const r = await tmux("send-keys", "-t", meta.tmux, k);
    if (r.code !== 0) throw new ApiError(400, `tmux did not accept key "${k}": ${r.err}`);
  }
  if (enter) await tmux("send-keys", "-t", meta.tmux, "Enter");
}

export async function killRun(id: number, force = false): Promise<RunRow> {
  const run = getRun(id);
  if (run.status !== "running" || !run.pid) throw new ApiError(409, `run ${id} is not running`);
  const entry = live.get(id);
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
        const cap = await tmux("capture-pane", "-p", "-J", "-t", meta.tmux, "-S", "-2000");
        if (cap.code === 0 && run.log_path) appendFileSync(run.log_path, cap.out.replace(/^Pane is dead.*$/m, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n\n# agent-console: killed (orphan)\n");
        await tmux("kill-session", "-t", meta.tmux);
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
    interactive: Boolean(meta.interactive), resumeSession: meta.resume_session,
  });
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
  // Until the agent reports back (claude's hook, codex's rollout), remember what we asked it to reopen.
  recordSession(run.id, { session_id: o.sessionId, agent: o.agent, cwd, source: "resume" });
  return getRun(run.id);
}
type RawRun = RunRow;

/**
 * Turn Remote Control on for a claude session that is already running, so it shows up in the Claude app.
 *
 * - In a tmux pane (an interactive run of ours, or any claude whose registry entry names a pane): type `/remote-control`
 *   into it. Whatever was half-typed is cleared first with Ctrl+U, which claude keeps for Ctrl+Y.
 * - Anywhere else (a plain terminal window, a headless run) there is nothing to type into. With `replace`, stop that
 *   process and reopen the same conversation here in tmux with the type's resume_args (which carry --remote-control).
 */
export async function enableRemoteControl(pid: number, o: { replace?: boolean; terminal?: string } = {}): Promise<{ status: "already" | "enabled" | "pending" | "replaced"; web_url: string; run?: RunRow }> {
  const entry = claudeRegistry(true).byPid.get(pid);
  if (!entry) throw new ApiError(404, `pid ${pid} is not a running claude session (nothing in ~/.claude/sessions for it)`);
  if (entry.bridgeSessionId) return { status: "already", web_url: claudeWebUrl(entry.bridgeSessionId) };
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE pid = ? AND status = 'running'").get(pid);
  const meta = run ? JSON.parse(run.meta || "{}") : {};

  // The pane to type into: our own run's tmux session, else the pane claude says it is in — if that pane really is this pid.
  let target: string = meta.tmux ?? "";
  if (!target && entry.tmux) {
    const pane = entry.tmux.split(".").pop() ?? "";
    const q = pane.startsWith("%") ? await tmux("display-message", "-p", "-t", pane, "#{pane_pid}") : null;
    if (q?.code === 0 && Number(q.out) === pid) target = pane;
  }

  if (target) {
    if (entry.status === "busy") throw new ApiError(409, "the session is working right now; enable Remote Control once it is idle");
    for (const keys of [["C-u"], ["-l", "--", "/remote-control"]]) {
      const r = await tmux("send-keys", "-t", target, ...keys);
      if (r.code !== 0) throw new ApiError(500, `tmux send-keys failed: ${r.err}`);
    }
    await Bun.sleep(300);                                 // let the slash-command menu catch up before Enter picks it
    await tmux("send-keys", "-t", target, "Enter");
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

  if (!o.replace) throw new ApiError(409, `pid ${pid} is not in a tmux pane the console can type into. Pass replace: true to stop it and reopen the conversation here with Remote Control.`);
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
    if (live.has(r.id)) continue;
    if (r.pid && pidAlive(r.pid)) {
      const meta = JSON.parse(r.meta || "{}");
      if (!meta.orphan) {
        meta.orphan = true;
        db.prepare("UPDATE runs SET meta = ? WHERE id = ?").run(JSON.stringify(meta), r.id);
      }
      continue;
    }
    const meta = JSON.parse(r.meta || "{}");
    if (meta.tmux) tmux("kill-session", "-t", meta.tmux).catch(() => {});
    db.prepare("UPDATE runs SET status = 'lost', ended_at = ?, error = ?, output = ? WHERE id = ?")
      .run(now(), "process disappeared while the console was not running", readTail(r.log_path, config.outputTailBytes), r.id);
  }
}

export function isLive(id: number) { return live.has(id); }
export function liveRunIds() { return [...live.keys()]; }

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { hydrate };
