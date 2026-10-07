import { Database } from "bun:sqlite";
import { dbPath } from "./config";

export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS process_types (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  command     TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '[]',   -- JSON array, may contain {prompt} and {cwd}
  env         TEXT NOT NULL DEFAULT '{}',   -- JSON object
  detect      TEXT NOT NULL DEFAULT '',     -- regex tested against OS process command lines
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  type_name     TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  prompt        TEXT NOT NULL DEFAULT '',
  extra_args    TEXT NOT NULL DEFAULT '[]', -- JSON array
  env           TEXT NOT NULL DEFAULT '{}', -- JSON object
  schedule      TEXT NOT NULL DEFAULT '',   -- cron expression or '' for manual only
  enabled       INTEGER NOT NULL DEFAULT 1,
  timeout_sec   INTEGER NOT NULL DEFAULT 0, -- 0 = no timeout
  allow_overlap INTEGER NOT NULL DEFAULT 0,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  workflow_id   INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  workflow_name TEXT,
  type_name     TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  command       TEXT NOT NULL,
  args          TEXT NOT NULL DEFAULT '[]', -- JSON array of the final argv (after command)
  prompt        TEXT NOT NULL DEFAULT '',
  env           TEXT NOT NULL DEFAULT '{}',
  trigger       TEXT NOT NULL,              -- manual | schedule | restart | api
  status        TEXT NOT NULL,              -- running | success | failed | killed | timeout | lost | error
  pid           INTEGER,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  exit_code     INTEGER,
  log_path      TEXT,
  output        TEXT NOT NULL DEFAULT '',   -- tail of the log, filled in when the run ends
  error         TEXT NOT NULL DEFAULT '',
  meta          TEXT NOT NULL DEFAULT '{}'  -- JSON: timeout_sec, orphan, etc.
);
CREATE INDEX IF NOT EXISTS runs_workflow_idx ON runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);

-- Agent sessions (Claude Code today) reported back by a hook in the child process,
-- so a run can be tied to the transcript on disk and resumed later.
CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  agent           TEXT NOT NULL DEFAULT 'claude',
  cwd             TEXT NOT NULL DEFAULT '',
  transcript_path TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT '',   -- startup | resume | clear | compact ...
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  end_reason      TEXT NOT NULL DEFAULT '',
  UNIQUE(run_id, session_id)
);
CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions(run_id, started_at);
`);

// ---- migrations for columns added after the first release
const typeCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(process_types)").all().map((c) => c.name));
if (!typeCols.has("kind")) db.exec("ALTER TABLE process_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'");
if (!typeCols.has("default_cwd")) db.exec("ALTER TABLE process_types ADD COLUMN default_cwd TEXT NOT NULL DEFAULT ''");
if (!typeCols.has("url")) db.exec("ALTER TABLE process_types ADD COLUMN url TEXT NOT NULL DEFAULT ''"); // where the app's UI is; {host} = the console's own host
if (!typeCols.has("interactive_args")) {
  // Args template used when a run is started with interactive=true (a tmux session that stays open).
  // '' means "same as args". Built-ins get templates that open the agent's own TUI.
  db.exec("ALTER TABLE process_types ADD COLUMN interactive_args TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE process_types SET interactive_args = '["{prompt}","--remote-control"]' WHERE name = 'claude' AND builtin = 1`);
  db.exec(`UPDATE process_types SET interactive_args = '["{prompt}"]' WHERE name = 'codex' AND builtin = 1`);
}
if (!typeCols.has("resume_args")) {
  // Args template for reopening a recorded session interactively ({session} = the agent's session id).
  db.exec("ALTER TABLE process_types ADD COLUMN resume_args TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE process_types SET resume_args = '["--resume","{session}","--remote-control"]' WHERE name = 'claude' AND builtin = 1`);
  db.exec(`UPDATE process_types SET resume_args = '["resume","{session}"]' WHERE name = 'codex' AND builtin = 1`);
}
// sessions.session_id started out UNIQUE; a resumed session legitimately belongs to several runs.
const sessionsUniqueOnIdOnly = db.query<{ name: string; unique: number }, []>("PRAGMA index_list(sessions)").all()
  .some((i) => i.unique === 1 && db.query<{ name: string }, [string]>(`PRAGMA index_info(${i.name})`).all(i.name).map((c) => c.name).join(",") === "session_id");
if (sessionsUniqueOnIdOnly) {
  db.exec(`
    CREATE TABLE sessions_new (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, session_id TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude', cwd TEXT NOT NULL DEFAULT '', transcript_path TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(run_id, session_id)
    );
    INSERT INTO sessions_new SELECT * FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
    CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions(run_id, started_at);
  `);
}
db.exec("UPDATE process_types SET kind = 'agent' WHERE builtin = 1 AND kind = 'app'");

export const now = () => Date.now();

export type ProcessTypeRow = {
  id: number; name: string; description: string; command: string; args: string; env: string;
  detect: string; builtin: number; kind: string; default_cwd: string; url: string; interactive_args: string; resume_args: string; created_at: number; updated_at: number;
};
export type WorkflowRow = {
  id: number; name: string; type_name: string; cwd: string; prompt: string; extra_args: string; env: string;
  schedule: string; enabled: number; timeout_sec: number; allow_overlap: number;
  next_run_at: number | null; last_run_at: number | null; created_at: number; updated_at: number;
};
export type SessionRow = {
  id: number; run_id: number; session_id: string; agent: string; cwd: string; transcript_path: string;
  model: string; source: string; started_at: number; ended_at: number | null; end_reason: string;
};
export type RunRow = {
  id: number; workflow_id: number | null; workflow_name: string | null; type_name: string; cwd: string;
  command: string; args: string; prompt: string; env: string; trigger: string; status: string; pid: number | null;
  started_at: number; ended_at: number | null; exit_code: number | null; log_path: string | null;
  output: string; error: string; meta: string;
};

export const ACTIVE_STATUSES = ["running"];

/** Parse the JSON columns of a row so API consumers get real arrays/objects. */
export function hydrate<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  for (const k of ["args", "interactive_args", "resume_args", "extra_args", "env", "meta"]) {
    if (typeof out[k] === "string") {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as-is */ }
    }
  }
  for (const k of ["enabled", "allow_overlap", "builtin"]) {
    if (typeof out[k] === "number") out[k] = out[k] === 1;
  }
  return out;
}

const BUILTIN_TYPES = [
  {
    name: "claude",
    description: "Claude Code. Prompt is passed with -p (headless) or as the first message (interactive); interactive sessions get Remote Control. Permission prompts are on: add e.g. --permission-mode acceptEdits (or --dangerously-skip-permissions) to its args to let it run unattended.",
    command: "claude",
    args: ["-p", "{prompt}"],
    interactive_args: ["{prompt}", "--remote-control"],
    resume_args: ["--resume", "{session}", "--remote-control"],
    env: {},
    detect: "(^|/|\\s)claude(\\s|$)",
  },
  {
    name: "codex",
    description: "OpenAI Codex CLI (non-interactive). Add e.g. --full-auto or --skip-git-repo-check via extra args.",
    command: "codex",
    args: ["exec", "{prompt}"],
    interactive_args: ["{prompt}"],
    resume_args: ["resume", "{session}"],
    env: {},
    detect: "(^|/|\\s)codex(\\s|$)",
  },
];

export function seedBuiltinTypes() {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO process_types (name, description, command, args, interactive_args, resume_args, env, detect, builtin, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'agent', ?, ?)`,
  );
  const t = now();
  for (const b of BUILTIN_TYPES) {
    insert.run(b.name, b.description, b.command, JSON.stringify(b.args), JSON.stringify(b.interactive_args ?? []), JSON.stringify(b.resume_args ?? []), JSON.stringify(b.env), b.detect, t, t);
  }
}
seedBuiltinTypes();
