/**
 * Opens a real terminal window on an interactive run's tmux session, so a session started
 * from the console also shows up on the machine's desktop (iTerm/Terminal on macOS, one of
 * the usual emulators on Linux). The tmux session stays the source of truth: the window is
 * just another client attached to it, and closing it leaves the run alone.
 */
import { existsSync } from "node:fs";

/** `auto` (default) picks the first terminal that is installed; `none`/`off` disables the window; anything else names one (e.g. `iterm`, `kitty`). */
const preference = (process.env.OPEN_TERMINAL ?? process.env.AGENT_CONSOLE_TERMINAL ?? "auto").trim().toLowerCase();

export type TerminalResult = { opened: boolean; app: string; error?: string };

const quiet = (cmd: string[]) => Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

async function run(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = quiet(cmd);
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, err: err.trim() };
}

/** Detached: the emulator must outlive this call (and the console process). */
function launch(cmd: string[]): void {
  Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

const appleQuote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

async function macApp(name: string): Promise<boolean> {
  const r = await run(["osascript", "-e", `id of application "${appleQuote(name)}"`]);
  return r.code === 0;
}

/** macOS: iTerm first (the user's own terminal), then Terminal.app. */
async function openMac(shellCmd: string, want: string): Promise<TerminalResult> {
  const tryITerm = want === "auto" || want === "iterm" || want === "iterm2";
  const tryTerminal = want === "auto" || want === "terminal" || want === "terminal.app" || want === "apple terminal";
  if (!tryITerm && !tryTerminal) return { opened: false, app: want, error: `unknown terminal "${want}" for macOS (use iterm, terminal, or none)` };

  if (tryITerm && ((await macApp("iTerm")) || existsSync("/Applications/iTerm.app"))) {
    const script = `tell application "iTerm"
  activate
  create window with default profile command "${appleQuote(shellCmd)}"
end tell`;
    const r = await run(["osascript", "-e", script]);
    if (r.code === 0) return { opened: true, app: "iTerm" };
    if (!tryTerminal) return { opened: false, app: "iTerm", error: r.err };
    // iTerm is installed but refused (locked screen, no automation permission): fall through to Terminal.
  }
  if (tryTerminal) {
    const script = `tell application "Terminal"
  activate
  do script "${appleQuote(shellCmd)}"
end tell`;
    const r = await run(["osascript", "-e", script]);
    if (r.code === 0) return { opened: true, app: "Terminal" };
    return { opened: false, app: "Terminal", error: r.err };
  }
  return { opened: false, app: want, error: "iTerm is not installed" };
}

/**
 * Linux emulators, best first. `argv` takes the command as separate words; `shell` takes it as one
 * string (those emulators only accept a single --command argument).
 */
const LINUX: { id: string; bin: string; argv?: (cmd: string[]) => string[]; shell?: (cmd: string) => string[] }[] = [
  { id: "wezterm", bin: "wezterm", argv: (c) => ["start", "--", ...c] },
  { id: "kitty", bin: "kitty", argv: (c) => [...c] },
  { id: "alacritty", bin: "alacritty", argv: (c) => ["-e", ...c] },
  { id: "ghostty", bin: "ghostty", argv: (c) => ["-e", ...c] },
  { id: "foot", bin: "foot", argv: (c) => [...c] },
  { id: "gnome-terminal", bin: "gnome-terminal", argv: (c) => ["--", ...c] },
  { id: "konsole", bin: "konsole", argv: (c) => ["-e", ...c] },
  { id: "tilix", bin: "tilix", shell: (c) => ["-e", c] },
  { id: "xfce4-terminal", bin: "xfce4-terminal", shell: (c) => ["--command", c] },
  { id: "mate-terminal", bin: "mate-terminal", argv: (c) => ["--", ...c] },
  { id: "terminator", bin: "terminator", shell: (c) => ["-x", c] },
  { id: "urxvt", bin: "urxvt", argv: (c) => ["-e", ...c] },
  { id: "xterm", bin: "xterm", argv: (c) => ["-e", ...c] },
  { id: "x-terminal-emulator", bin: "x-terminal-emulator", argv: (c) => ["-e", ...c] },
];

function openLinux(argvCmd: string[], shellCmd: string, want: string): TerminalResult {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { opened: false, app: "", error: "no DISPLAY/WAYLAND_DISPLAY: nothing to open a window on" };
  }
  const candidates = want === "auto" ? LINUX : LINUX.filter((t) => t.id === want || t.bin === want);
  if (!candidates.length) {
    return { opened: false, app: want, error: `unknown terminal "${want}" (known: ${LINUX.map((t) => t.id).join(", ")})` };
  }
  for (const t of candidates) {
    const bin = Bun.which(t.bin);
    if (!bin) continue;
    launch([bin, ...(t.argv ? t.argv(argvCmd) : t.shell!(shellCmd))]);
    return { opened: true, app: t.id };
  }
  return {
    opened: false,
    app: want,
    error: want === "auto" ? `no terminal emulator found on PATH (tried ${LINUX.map((t) => t.id).join(", ")})` : `${want} is not on PATH`,
  };
}

/** Attach a desktop terminal window to `session`. Never throws: a missing terminal is reported, not fatal. */
export async function openTerminalForTmux(session: string, opts: { terminal?: string } = {}): Promise<TerminalResult> {
  const want = (opts.terminal || preference).trim().toLowerCase() || "auto";
  if (want === "none" || want === "off" || want === "false" || want === "0") return { opened: false, app: "", error: "" };
  const tmuxBin = Bun.which("tmux") ?? "tmux";
  const argvCmd = [tmuxBin, "attach-session", "-t", session];
  const shellCmd = `${shellQuote(tmuxBin)} attach-session -t ${shellQuote(session)}`;
  try {
    if (process.platform === "darwin") return await openMac(shellCmd, want);
    if (process.platform === "linux") return openLinux(argvCmd, shellCmd, want);
    return { opened: false, app: "", error: `opening a terminal window is not supported on ${process.platform}` };
  } catch (e: any) {
    return { opened: false, app: want, error: e?.message ?? String(e) };
  }
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
