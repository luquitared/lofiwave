/** SQLite: one row per user, holding their machine (E2B sandbox) and the two secrets that reach it. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "./config";

export const db = new Database(join(config.dataDir, "hosted.sqlite"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  google_sub TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  -- the machine: an E2B sandbox running lofiwave on port 7770
  sandbox_id TEXT,
  traffic_token TEXT,     -- E2B's e2b-traffic-access-token for the sandbox's public URLs
  lw_token TEXT,          -- lofiwave's AUTH_TOKEN inside it
  machine_status TEXT NOT NULL DEFAULT 'none',  -- none | creating | ready | error
  machine_error TEXT
);
`);

export type UserRow = {
  id: number; email: string; name: string; google_sub: string | null; created_at: number; last_seen_at: number | null;
  sandbox_id: string | null; traffic_token: string | null; lw_token: string | null;
  machine_status: "none" | "creating" | "ready" | "error"; machine_error: string | null;
};

export const now = () => Date.now();
export const getUser = (id: number) => db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
export const userCount = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;

/** The user with this email, created on first sign-in. */
export function upsertUser(email: string, name: string, sub: string | null): UserRow {
  const cur = db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(email);
  if (cur) {
    db.prepare("UPDATE users SET name = ?, google_sub = COALESCE(?, google_sub), last_seen_at = ? WHERE id = ?").run(name || cur.name, sub, now(), cur.id);
    return getUser(cur.id)!;
  }
  const id = Number(db.prepare("INSERT INTO users (email, name, google_sub, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(email, name, sub, now(), now()).lastInsertRowid);
  return getUser(id)!;
}
