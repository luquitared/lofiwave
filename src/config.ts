import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, "data"));
// Logs hold whole agent transcripts, and the token lives here: owner-only.
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/**
 * The API can start agents and kill processes, so it always needs a token, even on localhost: any web page open in
 * a browser on this machine can send requests to 127.0.0.1. Without AUTH_TOKEN one is generated once and kept in
 * DATA_DIR/auth-token.
 */
function loadToken(): { token: string; generated: boolean; file: string } {
  const file = join(dataDir, "auth-token");
  const fromEnv = process.env.AUTH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, generated: false, file: "" };
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return { token: t, generated: false, file };
  }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return { token: t, generated: true, file };
}
const auth = loadToken();

export const config = {
  root: ROOT,
  /** Local-only unless HOST says otherwise (e.g. 0.0.0.0 to reach it over Tailscale). */
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT ?? 7770),
  dataDir,
  authToken: auth.token,
  /** Where the generated token is kept ('' when it comes from AUTH_TOKEN); `tokenGenerated` = made on this start. */
  tokenFile: auth.file,
  tokenGenerated: auth.generated,
  /** Shared team password. Set: people log in with a name + this password (a session cookie); the token still works. */
  password: process.env.PASSWORD?.trim() || "",
  /**
   * Git identity per signed-in person, so commits made in their runs carry their name:
   * GIT_AUTHORS="lucas=Lucas N <lucas@x.com>, seth=Seth N <seth@x.com>". Keys match the first word of the
   * sign-in name, case-insensitively. Anyone else (and scheduled/API runs) gets git's own config.
   */
  gitAuthors: parseGitAuthors(process.env.GIT_AUTHORS ?? ""),
  /**
   * Permission mode every claude run starts in (headless, interactive, restart and resume): passed as
   * `--permission-mode <mode>` unless the run's args already pick one. E.g. `bypassPermissions` on a sandbox VM.
   */
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE?.trim() || "",
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
  /** How much of the end of a run's log is copied into runs.output when it finishes. */
  outputTailBytes: Number(process.env.OUTPUT_TAIL_BYTES ?? 64 * 1024),
};

function parseGitAuthors(spec: string): Map<string, { name: string; email: string }> {
  const out = new Map<string, { name: string; email: string }>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^([^=\s]+)\s*=\s*(.+?)\s*<([^>]+)>$/);
    if (m) out.set(m[1].toLowerCase(), { name: m[2], email: m[3] });
    else if (part.trim()) console.warn(`GIT_AUTHORS: can't read "${part.trim()}" (want key=Name <email>)`);
  }
  return out;
}

export const logDir = join(config.dataDir, "logs");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
export const dbPath = join(config.dataDir, "agent-console.sqlite");
