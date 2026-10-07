/**
 * A real terminal for an interactive run: each WebSocket gets its own `tmux attach` on a pty (Bun's built-in
 * `terminal` spawn option), raw bytes both ways. Every viewer is a separate tmux client on the same session, so
 * several people can watch and type at once. The window follows the viewer with the latest input (tmux
 * `window-size latest`); the browser keeps that meaningful by not sending bare mouse motion (hovering over a tab
 * must not steal the size) and by reporting focus (focus-events), so clicking into a terminal claims it.
 *
 * Wire protocol: server → client binary frames are terminal output. Client → server text frames are JSON:
 * {"t":"i","d":"<input>"} for keystrokes/paste, {"t":"r","cols":N,"rows":N} for a resize.
 */
import type { ServerWebSocket, Subprocess } from "bun";
import { db, type RunRow } from "./db";
import { ApiError } from "./runner";

export type TtyData = { runId: number; session: string; cols: number; rows: number; user: string; proc?: Subprocess };

const clamp = (n: number, lo: number, hi: number, def: number) => (Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : def);

/** Validate the run and build the socket's data; throws ApiError (sent back as an HTTP error before upgrading). */
export function ttyFor(runId: number, url: URL, user: string): TtyData {
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const meta = JSON.parse(run.meta || "{}");
  if (!meta.tmux) throw new ApiError(400, `run ${runId} is not interactive`);
  if (run.status !== "running") throw new ApiError(409, `run ${runId} is not running`);
  return {
    runId, session: meta.tmux, user,
    cols: clamp(Number(url.searchParams.get("cols")), 20, 400, 120),
    rows: clamp(Number(url.searchParams.get("rows")), 5, 200, 40),
  };
}

const dec = new TextDecoder();
/** How many live terminals each tmux session has; the simple view leaves the window size alone while there are any. */
export const ttyViewers = new Map<string, number>();
const addViewer = (s: string, n: number) => { const v = (ttyViewers.get(s) ?? 0) + n; if (v > 0) ttyViewers.set(s, v); else ttyViewers.delete(s); };

export const ttySocket = {
  async open(ws: ServerWebSocket<TtyData>) {
    const d = ws.data;
    // The simple (polling) view resizes the window by hand, which pins it to "manual"; give sizing back to tmux.
    await Bun.spawn(["tmux", "set-option", "-t", d.session, "window-size", "latest"], { stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["tmux", "set-option", "-t", d.session, "mouse", "on"], { stdout: "ignore", stderr: "ignore" }).exited;
    // Ask clients for focus in/out reports: focusing a viewer then counts as its activity.
    await Bun.spawn(["tmux", "set-option", "-s", "focus-events", "on"], { stdout: "ignore", stderr: "ignore" }).exited;
    // Viewers bigger than the window (someone else typed last, so the window is their size) see tmux's filler there:
    // blank, rather than the default dot pattern.
    await Bun.spawn(["tmux", "set-option", "-w", "-t", d.session, "fill-character", " "], { stdout: "ignore", stderr: "ignore" }).exited;
    if (ws.readyState !== 1) return;
    addViewer(d.session, 1);
    d.proc = Bun.spawn(["tmux", "attach-session", "-t", d.session], {
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: d.cols, rows: d.rows,
        data(_t, bytes) { if (ws.readyState === 1) ws.sendBinary(bytes); },
      },
    });
    d.proc.exited.then(() => { if (ws.readyState === 1) ws.close(1000, "session ended"); });
  },
  message(ws: ServerWebSocket<TtyData>, msg: string | Buffer) {
    const term = ws.data.proc?.terminal;
    if (!term) return;
    let m: any;
    try { m = JSON.parse(typeof msg === "string" ? msg : dec.decode(msg)); } catch { return; }
    if (m.t === "i" && typeof m.d === "string") term.write(m.d);
    else if (m.t === "r") term.resize(clamp(m.cols, 20, 400, ws.data.cols), clamp(m.rows, 5, 200, ws.data.rows));
  },
  close(ws: ServerWebSocket<TtyData>) {
    // Detach this viewer only: the tmux session (and the agent in it) keeps running.
    const p = ws.data.proc;
    if (p) addViewer(ws.data.session, -1);
    if (p && p.exitCode === null) { p.terminal?.close(); p.kill(); }
  },
};
