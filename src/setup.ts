/**
 * First-run setup: is Claude Code installed here, and signed in? The UI asks on load and offers to install it or
 * sign in, both as interactive runs, so the installer and `claude auth login` show up as a terminal in the browser.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { ApiError, startRun, tmuxPath } from "./runner";
import type { RunRow } from "./db";

/** Where Claude Code's native installer puts it, and the older npm-local install: found even when not on PATH. */
const KNOWN_CLAUDE = [join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude")];

export function claudeBin(): string | null {
  return Bun.which("claude") ?? KNOWN_CLAUDE.find((p) => existsSync(p)) ?? null;
}

async function output(argv: string[], timeoutMs = 10_000): Promise<{ code: number | null; out: string }> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(timer);
  return { code, out: out.trim() };
}

export type ClaudeSetup = {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null when this claude can't say (one without `claude auth status`). */
  logged_in: boolean | null;
  auth_method?: string;
  email?: string;
  subscription?: string;
};

export async function claudeSetup(): Promise<ClaudeSetup> {
  const path = claudeBin();
  if (!path) return { installed: false, path: null, version: null, logged_in: null };
  const [ver, st] = await Promise.all([output([path, "--version"]), output([path, "auth", "status", "--json"])]);
  const version = ver.out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  // `auth status` prints JSON either way and exits 1 when signed out.
  let s: any = null;
  try { s = JSON.parse(st.out); } catch {}
  if (!s || typeof s.loggedIn !== "boolean") return { installed: true, path, version, logged_in: null };
  return { installed: true, path, version, logged_in: s.loggedIn, auth_method: s.authMethod, email: s.email, subscription: s.subscriptionType };
}

/** Claude Code's official installer (https://code.claude.com/docs/en/setup), into ~/.local/bin. */
const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";

export async function startClaudeSetup(step: "install" | "login"): Promise<RunRow> {
  if (!tmuxPath()) throw new ApiError(400, "setup runs need tmux on PATH (brew install tmux)");
  const bin = claudeBin();
  if (step === "login" && !bin) throw new ApiError(400, "Claude Code isn't installed yet");
  return startRun({
    typeName: "claude",
    cwd: homedir(),
    command: step === "install" ? { command: "/bin/bash", args: ["-c", INSTALL] } : { command: bin!, args: ["auth", "login"] },
    label: step === "install" ? "Install Claude Code" : "Sign in to Claude",
    setup: `claude-${step}`,
    interactive: true,
    terminal: "none",
    // Nothing to trust: these run in the home folder and aren't Claude sessions.
    trust: false,
    trigger: "manual",
  });
}
