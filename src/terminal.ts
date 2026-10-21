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

async function run(cmd: string[], timeout?: number): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() || (p.signalCode ? `timed out after ${timeout} ms (is macOS asking for permission to control the app?)` : "") };
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

/** A tab in iTerm or Terminal.app, by its terminal device (e.g. /dev/ttys003). */
export type MacTab = { app: "iTerm" | "Terminal"; tty: string };

// Each script takes the tty as its first argument and never launches the app: it only looks if it is running.
const FIND_TAB: Record<MacTab["app"], string> = {
  iTerm: `on run argv
  if application "iTerm" is not running then return ""
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then return "found"
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`,
  Terminal: `on run argv
  if application "Terminal" is not running then return ""
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then return "found"
      end repeat
    end repeat
  end tell
  return ""
end run`,
};

// Type argv[2] into the tab, then Enter. iTerm writes the text as typed and presses Enter a beat later, so a slash
// command's menu can catch up first; Terminal.app's `do script` can only send the text and Enter together.
const TYPE_INTO_TAB: Record<MacTab["app"], string> = {
  iTerm: `on run argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then
            tell s to write text (item 2 of argv) newline no
            delay 0.3
            tell s to write text "" newline yes
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "no iTerm tab on " & item 1 of argv
end run`,
  Terminal: `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          do script (item 2 of argv) in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "no Terminal tab on " & item 1 of argv
end run`,
};

/**
 * macOS: the iTerm or Terminal.app tab that `pid` runs in, if it is the program in front there (not a background
 * job, where typing would go to the shell instead). null on other platforms, or when it isn't in either app.
 */
export async function macTabOf(pid: number): Promise<MacTab | null> {
  if (process.platform !== "darwin") return null;
  const ps = await run(["ps", "-o", "tty=,stat=", "-p", String(pid)], 5000);
  const [dev, stat] = ps.out.split(/\s+/);
  if (ps.code !== 0 || !dev || dev === "??" || !stat?.includes("+")) return null;
  const tty = `/dev/${dev}`;
  for (const app of ["iTerm", "Terminal"] as const) {
    const r = await run(["osascript", "-e", FIND_TAB[app], tty], 10_000);
    if (r.out === "found") return { app, tty };
  }
  return null;
}

/** Type `text` into a tab found by macTabOf, then press Enter. Throws when the app refuses (no automation permission). */
export async function typeIntoMacTab(tab: MacTab, text: string): Promise<void> {
  const r = await run(["osascript", "-e", TYPE_INTO_TAB[tab.app], tab.tty, text], 10_000);
  if (r.code !== 0) throw new Error(`${tab.app}: ${r.err || "osascript failed"}`);
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

/** Attach a desktop terminal window to tmux `target` (an exact one: see tmuxTarget). Never throws: a missing terminal is reported, not fatal. */
export async function openTerminalForTmux(target: string, opts: { terminal?: string } = {}): Promise<TerminalResult> {
  const want = (opts.terminal || preference).trim().toLowerCase() || "auto";
  if (want === "none" || want === "off" || want === "false" || want === "0") return { opened: false, app: "", error: "" };
  const tmuxBin = Bun.which("tmux") ?? "tmux";
  const argvCmd = [tmuxBin, "attach-session", "-t", target];
  const shellCmd = `${shellQuote(tmuxBin)} attach-session -t ${shellQuote(target)}`;
  try {
    if (process.platform === "darwin") return await openMac(shellCmd, want);
    if (process.platform === "linux") return openLinux(argvCmd, shellCmd, want);
    return { opened: false, app: "", error: `opening a terminal window is not supported on ${process.platform}` };
  } catch (e: any) {
    return { opened: false, app: want, error: e?.message ?? String(e) };
  }
}

// A leading "=" gets quoted: zsh (Terminal.app's default shell) expands =word to a command's path, so =ac-4: would break.
function shellQuote(s: string): string {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
