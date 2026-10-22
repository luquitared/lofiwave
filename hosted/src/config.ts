/** Settings, from the environment or `KEY=VALUE` lines in `.env` (Bun loads it). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const env = process.env;
const dataDir = resolve(env.DATA_DIR || join(import.meta.dir, "..", "data"));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** SESSION_SECRET, or one generated once into data/session-secret: it signs the login cookie. */
function sessionSecret(): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const f = join(dataDir, "session-secret");
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(f, "utf8").trim();
}

const list = (v: string | undefined) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  port: Number(env.PORT || 7780),
  host: env.HOST || "127.0.0.1",
  /** The address people open, e.g. https://lofiwave.example.com (Google redirects back to it). */
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 7780}`).replace(/\/$/, ""),
  dataDir,
  sessionSecret: sessionSecret(),
  googleClientId: env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
  /** Sign in with any email, no Google (local testing only: refused unless HOST is loopback). */
  devLogin: env.DEV_LOGIN === "1",
  /** Who may sign up: exact emails and `@domain` entries. Empty: anyone with a verified Google account. */
  allow: list(env.ALLOW_EMAILS),
  /** Most machines this deployment will create; sign-ups past it are refused. */
  maxUsers: Number(env.MAX_USERS || 50),
  e2bApiKey: env.E2B_API_KEY || "",
  template: env.TEMPLATE || "lofiwave",
  /** How long a machine stays awake with nobody using it and no agent working, before E2B pauses it. */
  idleSec: Number(env.IDLE_SEC || 600),
  /** How often running machines are checked for working agents. */
  keeperIntervalMs: Number(env.KEEPER_INTERVAL_MS || 60_000),
  /** Passed to every machine's lofiwave (e.g. bypassPermissions: the machine is the user's own sandbox). */
  claudePermissionMode: env.CLAUDE_PERMISSION_MODE || "",
};

export const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
