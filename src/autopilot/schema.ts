/**
 * Tables for unattended work (docs/autopilot.md): programmes and their standing context, asks and the rules learned
 * from their answers, guards, the commitments ledger, and the log of what happened.
 *
 * A live run rewrites its `meta` from memory, so nothing here is kept in it after the run has started: what a run
 * belongs to and what became of it are rows of their own, keyed by the run id.
 */
import { db } from "../db";

db.exec(`
-- A line of work run by several agents over time: a goal, a folder, a standing brief every worker gets, a budget.
CREATE TABLE IF NOT EXISTS programmes (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',
  folder        TEXT NOT NULL DEFAULT '',       -- where its workers' folders live; PROGRAMME.md is written here
  brief         TEXT NOT NULL DEFAULT '',       -- the standing brief, as it stands now
  brief_version INTEGER NOT NULL DEFAULT 0,
  budget_usd    REAL,                           -- cap for the whole programme; NULL = none
  status        TEXT NOT NULL DEFAULT 'active', -- active | paused | done
  summary       TEXT NOT NULL DEFAULT '',       -- where it stands, rewritten by the controller (or a person)
  summary_at    INTEGER,
  summary_by    TEXT NOT NULL DEFAULT '',
  controller_workflow INTEGER,                  -- the workflow that runs its controller, if set up
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Every version of a programme's standing brief.
CREATE TABLE IF NOT EXISTS programme_briefs (
  id           INTEGER PRIMARY KEY,
  programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',        -- what changed, in a line
  by           TEXT NOT NULL DEFAULT '',
  at           INTEGER NOT NULL,
  UNIQUE(programme_id, version)
);

-- Which programme a run works for, as which worker, with what budget, and which brief version it has been given.
CREATE TABLE IF NOT EXISTS programme_runs (
  run_id       INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  worker       TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'worker',  -- worker | controller
  budget_usd   REAL,
  brief_seen   INTEGER NOT NULL DEFAULT 0,
  status_line  TEXT NOT NULL DEFAULT '',        -- the worker's own one-line status
  status_at    INTEGER,
  end_noted    INTEGER NOT NULL DEFAULT 0       -- its end has been logged and announced
);
CREATE INDEX IF NOT EXISTS programme_runs_prog_idx ON programme_runs(programme_id);

-- What a run said became of it: done, blocked or failed, with a summary and its report. Any run, not only workers.
CREATE TABLE IF NOT EXISTS run_outcomes (
  run_id      INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL,                    -- done | blocked | failed
  summary     TEXT NOT NULL DEFAULT '',
  report_path TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL
);

-- Standing instructions. scope 'global': every programme run (applies 'programme') or every agent run ('all').
-- scope 'programme': that programme's own rules and the lessons its workers and people recorded.
CREATE TABLE IF NOT EXISTS rules (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'global',  -- global | programme
  programme_id INTEGER REFERENCES programmes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'rule',    -- rule | lesson
  applies      TEXT NOT NULL DEFAULT 'programme', -- programme | all (global rules only)
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  by           TEXT NOT NULL DEFAULT '',
  run_id       INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- A programme's record: decisions (who decided what, when), published outputs and the figures others quote.
-- A new entry with the same kind and key supersedes the old one, which is kept.
CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY,
  programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                   -- decision | output | figure
  key          TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  value        TEXT NOT NULL DEFAULT '',        -- figure: the number; output: its version
  path         TEXT NOT NULL DEFAULT '',
  run_id       INTEGER,
  ask_id       INTEGER,
  by           TEXT NOT NULL DEFAULT '',
  at           INTEGER NOT NULL,
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS entries_prog_idx ON entries(programme_id, kind, at);

-- Something an agent needs from a person: a question, an approval, more budget. Answered by a person or by a rule.
CREATE TABLE IF NOT EXISTS asks (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  programme_id  INTEGER REFERENCES programmes(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'question', -- question | approval | budget
  class         TEXT NOT NULL DEFAULT '',       -- what kind of decision it is, for rules: merge, deploy, budget, ...
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  options       TEXT NOT NULL DEFAULT '[]',     -- JSON [{id, label, detail, recommended}]
  amount        REAL,                           -- budget asks: the new cap asked for, in USD
  for_person    TEXT NOT NULL DEFAULT '',       -- who should answer, when it is someone in particular
  status        TEXT NOT NULL DEFAULT 'open',   -- open | answered | cancelled
  answer_option TEXT NOT NULL DEFAULT '',       -- the chosen option's id
  answer_text   TEXT NOT NULL DEFAULT '',
  answered_by   TEXT NOT NULL DEFAULT '',       -- a person's name, or the rule's author for a rule
  answered_via  TEXT NOT NULL DEFAULT '',       -- person | rule
  policy_id     INTEGER,
  answered_at   INTEGER,
  delivered     INTEGER,                        -- the answer reached the run: 1, 0 (not yet), NULL (nothing to deliver to)
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_status_idx ON asks(status, created_at);

-- A standing answer: asks of this class (in this programme, or anywhere) are answered without asking again.
CREATE TABLE IF NOT EXISTS policies (
  id              INTEGER PRIMARY KEY,
  programme_id    INTEGER REFERENCES programmes(id) ON DELETE CASCADE,  -- NULL = everywhere
  class           TEXT NOT NULL,
  answer          TEXT NOT NULL,                -- the option to choose, by id or label
  max_amount      REAL,                         -- only asks up to this amount (required for budget asks)
  note            TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL DEFAULT '',
  from_ask        INTEGER,
  created_at      INTEGER NOT NULL,
  applied_count   INTEGER NOT NULL DEFAULT 0,
  last_applied_at INTEGER
);

-- Money a run says it spent, by bucket (aws, gemini, ...).
CREATE TABLE IF NOT EXISTS spend (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  programme_id INTEGER REFERENCES programmes(id) ON DELETE CASCADE,
  bucket       TEXT NOT NULL DEFAULT '',
  amount_usd   REAL NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_run_idx ON spend(run_id);

-- Commands an agent may not run, checked before each Bash call of an interactive claude run (src/autopilot/guards.ts).
CREATE TABLE IF NOT EXISTS guards (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  pattern    TEXT NOT NULL,                     -- a regex tested against the command
  unless     TEXT NOT NULL DEFAULT '',          -- a regex that lets a matching command through
  "when"     TEXT NOT NULL DEFAULT 'always',    -- always | over_budget
  message    TEXT NOT NULL DEFAULT '',          -- what the agent is told
  enabled    INTEGER NOT NULL DEFAULT 1,
  builtin    INTEGER NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at INTEGER NOT NULL
);

-- People on the team, so an item or an ask can be addressed to one and a follow-up can reach them.
CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,              -- as items name them
  login      TEXT NOT NULL DEFAULT '',          -- their lofiwave sign-in name
  slack_id   TEXT NOT NULL DEFAULT '',          -- for a direct message (needs a Slack bot token)
  notes      TEXT NOT NULL DEFAULT '',          -- role, language, what to know when writing to them
  created_at INTEGER NOT NULL
);

-- The commitments ledger: what is open, who holds it, by when. Also holds product signals (kind 'signal').
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  programme_id INTEGER REFERENCES programmes(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'do',      -- do | decide | verify | risk | signal
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  owner        TEXT NOT NULL DEFAULT '',        -- a person's name, 'agent', or '' (nobody yet)
  priority     TEXT NOT NULL DEFAULT 'med',     -- high | med | low
  due_at       INTEGER,
  status       TEXT NOT NULL DEFAULT 'open',    -- open | done | dropped
  source       TEXT NOT NULL DEFAULT '',        -- where it came from: a Slack link, a session, a run
  source_key   TEXT NOT NULL DEFAULT '',        -- stable id of the source, so an intake pass doesn't add it twice
  note         TEXT NOT NULL DEFAULT '',
  nudged_at    INTEGER,
  nudges       INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS items_status_idx ON items(status, owner);
CREATE UNIQUE INDEX IF NOT EXISTS items_source_idx ON items(source_key) WHERE source_key != '';

-- What happened, for the digest and for anyone asking later: asks, answers, rule applications, ends, guard hits.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  programme_id INTEGER,
  run_id       INTEGER,
  ref          TEXT NOT NULL DEFAULT '',        -- e.g. ask:12, item:4, policy:2
  actor        TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);

-- Messages lofiwave owes a run (an answer, a changed brief, a wake-up), kept until they are typed into it.
CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  ref          TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(delivered_at, run_id);

-- Settings changed from the UI (where notifications go, the digest's schedule). Values may be secrets.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Stalls already announced, so a parked run is announced once per stall, not on every tick.
CREATE TABLE IF NOT EXISTS stall_notes (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  since  INTEGER NOT NULL,
  what   TEXT NOT NULL
);
`);

const wfCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(workflows)").all().map((c) => c.name));
// A workflow can work for a programme (its controller, a scheduled sweep): '' = none, else a programmes.slug.
if (!wfCols.has("programme")) db.exec("ALTER TABLE workflows ADD COLUMN programme TEXT NOT NULL DEFAULT ''");

export type ProgrammeRow = {
  id: number; slug: string; name: string; goal: string; folder: string; brief: string; brief_version: number;
  budget_usd: number | null; status: string; summary: string; summary_at: number | null; summary_by: string;
  controller_workflow: number | null; created_by: string; created_at: number; updated_at: number;
};
export type ProgrammeRunRow = {
  run_id: number; programme_id: number; worker: string; role: string; budget_usd: number | null; brief_seen: number;
  status_line: string; status_at: number | null; end_noted: number;
};
export type OutcomeRow = { run_id: number; outcome: string; summary: string; report_path: string; at: number };
export type RuleRow = {
  id: number; scope: string; programme_id: number | null; kind: string; applies: string; title: string; body: string;
  enabled: number; by: string; run_id: number | null; created_at: number; updated_at: number;
};
export type EntryRow = {
  id: number; programme_id: number; kind: string; key: string; title: string; body: string; value: string; path: string;
  run_id: number | null; ask_id: number | null; by: string; at: number; superseded_by: number | null;
};
export type AskRow = {
  id: number; run_id: number | null; programme_id: number | null; kind: string; class: string; title: string; body: string;
  options: string; amount: number | null; for_person: string; status: string; answer_option: string; answer_text: string;
  answered_by: string; answered_via: string; policy_id: number | null; answered_at: number | null; delivered: number | null;
  created_by: string; created_at: number;
};
export type PolicyRow = {
  id: number; programme_id: number | null; class: string; answer: string; max_amount: number | null; note: string;
  enabled: number; created_by: string; from_ask: number | null; created_at: number; applied_count: number; last_applied_at: number | null;
};
export type GuardRow = {
  id: number; name: string; pattern: string; unless: string; when: string; message: string; enabled: number; builtin: number;
  hits: number; last_hit_at: number | null; created_at: number;
};
export type PersonRow = { id: number; name: string; login: string; slack_id: string; notes: string; created_at: number };
export type ItemRow = {
  id: number; programme_id: number | null; kind: string; title: string; body: string; owner: string; priority: string;
  due_at: number | null; status: string; source: string; source_key: string; note: string; nudged_at: number | null; nudges: number;
  created_by: string; created_at: number; updated_at: number; closed_at: number | null;
};
export type EventRow = { id: number; at: number; kind: string; programme_id: number | null; run_id: number | null; ref: string; actor: string; text: string };
export type OutboxRow = { id: number; run_id: number; text: string; ref: string; created_at: number; delivered_at: number | null; attempts: number; error: string };
