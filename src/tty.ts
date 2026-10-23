/**
 * A real terminal for an interactive run: each WebSocket gets its own `tmux attach` on a pty (Bun's built-in
 * `terminal` spawn option), raw bytes both ways. Every viewer is a separate tmux client on the same session, so
 * several people can watch and type at once. The window follows the viewer with the latest input (tmux
 * `window-size latest`); the browser keeps that meaningful by not sending bare mouse motion (hovering over a tab
 * must not steal the size) and by reporting focus (focus-events), so clicking into a terminal claims it.
 *
 * A run in an E2B sandbox has no tmux here: its socket is bridged to the sandbox's PTY instead (src/e2b.ts,
 * E2BTerm). Viewers share that one PTY the same way, and the last one to resize sets its size.
 *
 * Wire protocol: server → client binary frames are terminal output. Client → server text frames are JSON:
 * {"t":"i","d":"<input>"} for keystrokes/paste, {"t":"r","cols":N,"rows":N} for a resize.
 */
import type { ServerWebSocket, Subprocess } from "bun";
import { db, type RunRow } from "./db";
import { ApiError, tmuxTarget } from "./runner";
import { e2bTerms } from "./e2b";

export type TtyData = {
  runId: number; session: string; cols: number; rows: number; user: string; proc?: Subprocess;
  /** Bridged to an E2B sandbox's PTY instead of tmux. */
  e2b?: boolean;
  viewer?: { send(b: Uint8Array): void; close(reason: string): void };
};

const clamp = (n: number, lo: number, hi: number, def: number) => (Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : def);

/** Validate the run and build the socket's data; throws ApiError (sent back as an HTTP error before upgrading). */
export function ttyFor(runId: number, url: URL, user: string): TtyData {
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const meta = JSON.parse(run.meta || "{}");
  const e2b = Boolean(meta.e2b && meta.interactive);
  if (!meta.tmux && !e2b) throw new ApiError(400, `run ${runId} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${runId} is not running`);
  if (e2b && !e2bTerms.has(runId)) throw new ApiError(409, `run ${runId}'s sandbox terminal isn't attached yet`);
  return {
    runId, session: meta.tmux ?? `e2b-${runId}`, user, e2b,
    cols: clamp(Number(url.searchParams.get("cols")), 20, 400, 120),
    rows: clamp(Number(url.searchParams.get("rows")), 5, 200, 40),
  };
}

const dec = new TextDecoder();
/** How many live terminals each tmux session has; /screen leaves the window size alone while there are any. */
export const ttyViewers = new Map<string, number>();
const addViewer = (s: string, n: number) => { const v = (ttyViewers.get(s) ?? 0) + n; if (v > 0) ttyViewers.set(s, v); else ttyViewers.delete(s); };

const notice = (s: string) => new TextEncoder().encode(`\r\n\x1b[2m[lofiwave] ${s}\x1b[0m\r\n`);

/** Bridge a socket to an E2B run's PTY: replay recent output, take its size (which makes the TUI repaint), then live. */
async function openE2B(ws: ServerWebSocket<TtyData>) {
  const d = ws.data;
  const term = e2bTerms.get(d.runId);
  if (!term) { ws.close(1011, "sandbox terminal not attached"); return; }
  d.viewer = {
    send: (b) => { if (ws.readyState === 1) ws.sendBinary(b); },
    close: (reason) => { if (ws.readyState === 1) ws.close(1000, reason); },
  };
  const replay = term.replay();
  if (replay.length) ws.sendBinary(replay);
  term.viewers.add(d.viewer);
  if (term.paused) {
    ws.sendBinary(notice("the sandbox was paused while idle; resuming it…"));
    try { await term.resume(); } catch (e: any) { ws.sendBinary(notice(`couldn't resume it: ${e?.message ?? e}`)); return; }
  }
  if (d.cols !== term.cols || d.rows !== term.rows) await term.resize(d.cols, d.rows);
  else await term.redraw();
}

export const ttySocket = {
  async open(ws: ServerWebSocket<TtyData>) {
    const d = ws.data;
    if (d.e2b) return openE2B(ws);
    // /screen (run details, API clients) resizes the window by hand, which pins it to "manual"; give sizing back to tmux.
    await Bun.spawn(["tmux", "set-option", "-t", tmuxTarget(d.session), "window-size", "latest"], { stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["tmux", "set-option", "-t", tmuxTarget(d.session), "mouse", "on"], { stdout: "ignore", stderr: "ignore" }).exited;
    // Ask clients for focus in/out reports: focusing a viewer then counts as its activity.
    await Bun.spawn(["tmux", "set-option", "-s", "focus-events", "on"], { stdout: "ignore", stderr: "ignore" }).exited;
    // Viewers bigger than the window (someone else typed last, so the window is their size) see tmux's filler there:
    // blank, rather than the default dot pattern.
    await Bun.spawn(["tmux", "set-option", "-w", "-t", tmuxTarget(d.session), "fill-character", " "], { stdout: "ignore", stderr: "ignore" }).exited;
    if (ws.readyState !== 1) return;
    addViewer(d.session, 1);
    d.proc = Bun.spawn(["tmux", "attach-session", "-t", tmuxTarget(d.session)], {
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: d.cols, rows: d.rows,
        data(_t, bytes) { if (ws.readyState === 1) ws.sendBinary(bytes); },
      },
    });
    d.proc.exited.then(() => { if (ws.readyState === 1) ws.close(1000, "session ended"); });
  },
  message(ws: ServerWebSocket<TtyData>, msg: string | Buffer) {
    let m: any;
    try { m = JSON.parse(typeof msg === "string" ? msg : dec.decode(msg)); } catch { return; }
    if (ws.data.e2b) {
      const term = e2bTerms.get(ws.data.runId);
      if (!term) return;
      if (m.t === "i" && typeof m.d === "string") term.input(m.d).catch((e) => { if (ws.readyState === 1) ws.sendBinary(notice(`input not delivered: ${e?.message ?? e}`)); });
      // Focus reports are activity for tmux sizing; here only a real resize changes the PTY.
      else if (m.t === "r") term.resize(clamp(m.cols, 20, 400, ws.data.cols), clamp(m.rows, 5, 200, ws.data.rows));
      return;
    }
    const term = ws.data.proc?.terminal;
    if (!term) return;
    if (m.t === "i" && typeof m.d === "string") term.write(m.d);
    else if (m.t === "r") term.resize(clamp(m.cols, 20, 400, ws.data.cols), clamp(m.rows, 5, 200, ws.data.rows));
  },
  close(ws: ServerWebSocket<TtyData>) {
    if (ws.data.e2b) { if (ws.data.viewer) e2bTerms.get(ws.data.runId)?.viewers.delete(ws.data.viewer); return; }
    // Detach this viewer only: the tmux session (and the agent in it) keeps running.
    const p = ws.data.proc;
    if (p) addViewer(ws.data.session, -1);
    if (p && p.exitCode === null) { p.terminal?.close(); p.kill(); }
  },
};
