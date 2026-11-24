/**
 * Keys: the API keys, tokens and passwords this machine's agents use, kept in lofiwave's database with the value
 * encrypted (AES-256-GCM). The master key is not in the database: it is LOFIWAVE_KEYS_KEY (base64 or hex, 32 bytes)
 * or, by default, a 0600 file at ~/.config/lofiwave/keys.key (LOFIWAVE_KEYS_KEY_FILE moves it), made on first use.
 * A copy of the data folder alone doesn't give the keys away; losing the master key loses them.
 *
 * Everything else about a key (its name, env var, service, note, fields, tags) is plain, so it can be searched.
 * A fingerprint (an HMAC of the value under the master key) finds where a stored key is also written on disk, in
 * .env files and shell profiles (scan()), without keeping those values anywhere.
 *
 * Who can read a value: anyone who can use this console (signed-in people, the console token, API keys, runs).
 * Every read is logged in secret_events with who did it and for what (reveal, copy, env, write).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { db, now } from "./db";
import { ApiError } from "./runner";

db.exec(`
CREATE TABLE IF NOT EXISTS secrets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,           -- what people and agents call it: openai-personal, stripe-live
  env         TEXT NOT NULL DEFAULT '',       -- the env var it usually goes in: OPENAI_API_KEY
  service     TEXT NOT NULL DEFAULT '',       -- openai, stripe, supabase…
  value_enc   TEXT NOT NULL,                  -- base64(iv | tag | ciphertext), AES-256-GCM
  key_id      TEXT NOT NULL,                  -- which master key encrypted it (sha256 prefix)
  fingerprint TEXT NOT NULL,                  -- HMAC-SHA256(master, value), hex prefix: matches copies on disk
  hint        TEXT NOT NULL DEFAULT '',       -- sk-…a1b2: enough to tell keys apart, not to use one
  note        TEXT NOT NULL DEFAULT '',
  fields      TEXT NOT NULL DEFAULT '{}',     -- JSON {account, project, url, …}: values that go with the key
  tags        TEXT NOT NULL DEFAULT '[]',     -- JSON array
  source      TEXT NOT NULL DEFAULT '',       -- where it was imported from (a file), or ''
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE TABLE IF NOT EXISTS secret_events (
  id        INTEGER PRIMARY KEY,
  secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  action    TEXT NOT NULL,                    -- created, updated, reveal, copy, env, write
  actor     TEXT NOT NULL DEFAULT '',
  run_id    INTEGER,
  detail    TEXT NOT NULL DEFAULT '',
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS secret_events_by_secret ON secret_events(secret_id, at);
`);

export type SecretRow = {
  id: number; name: string; env: string; service: string; value_enc: string; key_id: string; fingerprint: string; hint: string;
  note: string; fields: string; tags: string; source: string; created_by: string; created_at: number; updated_at: number; used_at: number | null;
};

// ---------------------------------------------------------------- the master key and encryption

let master: { key: Buffer; id: string } | null = null;

export function keyFile(): string {
  return resolve(process.env.LOFIWAVE_KEYS_KEY_FILE?.trim() || join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "lofiwave", "keys.key"));
}

function decodeKey(s: string, where: string): Buffer {
  const t = s.trim();
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (b.length !== 32) throw new ApiError(500, `${where} must be 32 bytes, base64 or hex (it is ${b.length})`);
  return b;
}

function masterKey() {
  if (master) return master;
  let key: Buffer;
  if (process.env.LOFIWAVE_KEYS_KEY?.trim()) key = decodeKey(process.env.LOFIWAVE_KEYS_KEY, "LOFIWAVE_KEYS_KEY");
  else {
    const file = keyFile();
    if (existsSync(file)) key = decodeKey(readFileSync(file, "utf8"), file);
    else {
      key = randomBytes(32);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(file, 0o600);
    }
  }
  master = { key, id: createHash("sha256").update(key).digest("hex").slice(0, 12) };
  return master;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey().key, iv);
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function decrypt(row: SecretRow): string {
  const m = masterKey();
  if (row.key_id !== m.id) throw new ApiError(500, `key "${row.name}" was encrypted with another master key (${row.key_id}, this one is ${m.id}): restore ${keyFile()} or LOFIWAVE_KEYS_KEY`);
  const b = Buffer.from(row.value_enc, "base64");
  const d = createDecipheriv("aes-256-gcm", m.key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const fingerprint = (value: string) => createHmac("sha256", masterKey().key).update(value).digest("hex").slice(0, 32);

/** "sk-proj-…a1b2": a recognizable prefix (sk-, ghp_, xoxb-) and the last four, for long values only. */
export function hintOf(value: string): string {
  const v = value.trim();
  if (v.length < 12) return "•".repeat(Math.min(v.length, 8));
  const url = v.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):[^@\s]+@([^/\s?#]+)/i);
  if (url) return `${url[1]}${url[2]}:•••@${url[3]}`;
  // The prefix only on long values, where it is a key's type (sk-proj-, ghp_) and not a good part of the value.
  const prefix = v.length >= 24 ? v.match(/^[A-Za-z]{2,8}[-_](?:[A-Za-z]{2,8}[-_])?/)?.[0] ?? "" : "";
  return `${prefix}…${v.slice(-4)}`;
}

// ---------------------------------------------------------------- records

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,79}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Words the routes use after /api/secrets/: a key can't be called one of them. */
const RESERVED = new Set(["scan", "import"]);

export function checkName(name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n)) throw new ApiError(400, `key name "${n}" may only have letters, digits and _ . : @ - (up to 80, starting with a letter or digit)`);
  if (RESERVED.has(n.toLowerCase())) throw new ApiError(400, `"${n}" is reserved; pick another name`);
  return n;
}

export function getSecret(name: string): SecretRow {
  const row = db.query<SecretRow, [string]>("SELECT * FROM secrets WHERE name = ?").get(name)
    ?? db.query<SecretRow, [string]>("SELECT * FROM secrets WHERE name = ? COLLATE NOCASE").get(name);
  if (!row) throw new ApiError(404, `no key called "${name}" (lw keys search <text>)`);
  return row;
}

export function secretOut(r: SecretRow) {
  return {
    id: r.id, name: r.name, env: r.env, service: r.service, hint: r.hint, note: r.note,
    fields: JSON.parse(r.fields || "{}") as Record<string, string>, tags: JSON.parse(r.tags || "[]") as string[],
    source: r.source, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, used_at: r.used_at,
    files: whereCount(r.fingerprint),
  };
}

function logEvent(secretId: number, action: string, who: { actor: string; run: number | null }, detail = "") {
  db.prepare("INSERT INTO secret_events (secret_id, action, actor, run_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(secretId, action, who.actor, who.run, detail.slice(0, 300), now());
}

export type Who = { actor: string; run: number | null };
export type SecretInput = { name?: string; value?: string; env?: string; service?: string; note?: string; fields?: Record<string, string>; tags?: string[]; source?: string };

function cleanFields(f: unknown): Record<string, string> {
  if (f === undefined || f === null) return {};
  if (typeof f !== "object" || Array.isArray(f)) throw new ApiError(400, "fields must be an object of string values");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (!k.trim()) continue;
    if (v === null || v === "") continue;   // an empty value removes the field
    if (typeof v !== "string") throw new ApiError(400, `field "${k}" must be a string`);
    out[k.trim().slice(0, 60)] = v.slice(0, 2000);
  }
  return out;
}
function cleanEnv(e: unknown): string {
  const s = typeof e === "string" ? e.trim() : "";
  if (s && !ENV_RE.test(s)) throw new ApiError(400, `env "${s}" isn't a valid variable name`);
  return s;
}

export function listSecrets(q = ""): ReturnType<typeof secretOut>[] {
  const rows = db.query<SecretRow, []>("SELECT * FROM secrets ORDER BY COALESCE(used_at, updated_at) DESC").all();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (r: SecretRow) => [r.name, r.env, r.service, r.note, r.fields, r.tags, r.source, r.hint].join("\n").toLowerCase();
  return rows.filter((r) => words.every((w) => hay(r).includes(w))).map(secretOut);
}

export function createSecret(b: SecretInput, who: Who) {
  const name = checkName(String(b.name ?? ""));
  const value = typeof b.value === "string" ? b.value.replace(/\r?\n$/, "") : "";
  if (!value) throw new ApiError(400, "value is required (and can't be empty)");
  if (db.query("SELECT 1 FROM secrets WHERE name = ? COLLATE NOCASE").get(name)) throw new ApiError(409, `a key called "${name}" already exists (lw keys set ${name} … changes it)`);
  const t = now(), m = masterKey(), fp = fingerprint(value);
  const twin = db.query<{ name: string }, [string]>("SELECT name FROM secrets WHERE fingerprint = ?").get(fp);
  const ins = db.prepare(
    `INSERT INTO secrets (name, env, service, value_enc, key_id, fingerprint, hint, note, fields, tags, source, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, cleanEnv(b.env), String(b.service ?? "").trim().slice(0, 60), encrypt(value), m.id, fp, hintOf(value), String(b.note ?? "").slice(0, 10_000),
    JSON.stringify(cleanFields(b.fields)), JSON.stringify((b.tags ?? []).map(String).filter(Boolean)), String(b.source ?? ""), who.actor, t, t);
  const id = Number(ins.lastInsertRowid);
  logEvent(id, "created", who, b.source ? `from ${b.source}` : "");
  return { ...secretOut(getSecret(name)), same_value_as: twin?.name ?? null };
}

/** Change a key: any of its fields, its value, or its name (`name`). `fields` merges (an empty value drops one). */
export function updateSecret(name: string, b: SecretInput & { rename?: string; replace_fields?: boolean }, who: Who) {
  const cur = getSecret(name);
  const sets: string[] = [], args: any[] = [], changed: string[] = [];
  const set = (col: string, v: any) => { sets.push(`${col} = ?`); args.push(v); changed.push(col); };
  if (b.rename !== undefined && b.rename !== cur.name) {
    const n = checkName(b.rename);
    if (db.query("SELECT 1 FROM secrets WHERE name = ? COLLATE NOCASE AND id != ?").get(n, cur.id)) throw new ApiError(409, `a key called "${n}" already exists`);
    set("name", n);
  }
  if (typeof b.value === "string") {
    const v = b.value.replace(/\r?\n$/, "");
    if (!v) throw new ApiError(400, "value can't be empty");
    set("value_enc", encrypt(v)); sets.push("key_id = ?", "fingerprint = ?", "hint = ?"); args.push(masterKey().id, fingerprint(v), hintOf(v));
  }
  if (b.env !== undefined) set("env", cleanEnv(b.env));
  if (b.service !== undefined) set("service", String(b.service).trim().slice(0, 60));
  if (b.note !== undefined) set("note", String(b.note).slice(0, 10_000));
  if (b.tags !== undefined) set("tags", JSON.stringify(b.tags.map(String).filter(Boolean)));
  if (b.fields !== undefined) {
    const old = JSON.parse(cur.fields || "{}");
    const merged = b.replace_fields ? {} : { ...old };
    for (const [k, v] of Object.entries(b.fields ?? {})) { if (v === "" || v === null) delete merged[k.trim()]; }
    set("fields", JSON.stringify({ ...merged, ...cleanFields(b.fields) }));
  }
  if (!sets.length) return secretOut(cur);
  db.prepare(`UPDATE secrets SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, now(), cur.id);
  logEvent(cur.id, "updated", who, changed.map((c) => (c === "value_enc" ? "value" : c)).join(", "));
  return secretOut(db.query<SecretRow, [number]>("SELECT * FROM secrets WHERE id = ?").get(cur.id)!);
}

export function deleteSecret(name: string) {
  const cur = getSecret(name);
  db.prepare("DELETE FROM secrets WHERE id = ?").run(cur.id);
}

const USES = new Set(["reveal", "copy", "env", "write"]);
/** The value, for one use (reveal, copy, env, write), logged with who asked. */
export function readValue(name: string, use: string, who: Who, detail = "") {
  const cur = getSecret(name);
  const u = USES.has(use) ? use : "reveal";
  const value = decrypt(cur);
  db.prepare("UPDATE secrets SET used_at = ? WHERE id = ?").run(now(), cur.id);
  logEvent(cur.id, u, who, detail);
  return { name: cur.name, env: cur.env, value };
}

export function secretDetail(name: string) {
  const cur = getSecret(name);
  const events = db.query<{ action: string; actor: string; run_id: number | null; detail: string; at: number }, [number]>(
    "SELECT action, actor, run_id, detail, at FROM secret_events WHERE secret_id = ? ORDER BY at DESC, id DESC LIMIT 30").all(cur.id);
  return { ...secretOut(cur), events, where: whereFiles(cur.fingerprint), scanned_at: scanCache?.at ?? null };
}

// ---------------------------------------------------------------- what's on this computer: .env files and shell profiles

export type Found = { file: string; var: string; line: number };
export type FoundGroup = { fingerprint: string; hint: string; vars: string[]; files: Found[]; stored: string | null };

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "Library", ".Trash", ".cache", "venv", ".venv", "env", "__pycache__", "dist", "build", "out",
  ".next", ".nuxt", ".turbo", ".vercel", ".output", "target", ".npm", ".bun", ".cargo", ".rustup", ".pnpm-store", "go", "Applications",
  "Pictures", "Music", "Movies", "Photos", ".docker", ".local", ".gradle", ".m2", ".android", "Pods", "DerivedData", ".Spotlight-V100",
  "vendor", "site-packages", ".terraform", "coverage", ".nvm", ".pyenv", ".rbenv", ".conda", "miniconda3", "anaconda3", ".ollama",
]);
const PROFILE_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];
const ENV_FILE = /^(\.env(\.[\w.-]+)?|\.dev\.vars|\.envrc)$/;
const NOT_REAL = /\.(example|sample|template|dist|defaults?)$/i;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|DSN|CREDENTIALS?|AUTH|PRIVATE)(_|$)|^(PASSWORD|TOKEN|SECRET)/;
const PLACEHOLDER = /^(x+|\*+|\.\.\.|changeme|change[-_]me|todo|none|null|undefined|true|false|your[-_ ].*|<.*>|\$\{?.*\}?|sk-\.\.\..*|replace.*|test|dev|secret|password)$/i;

function scanRoots(): string[] {
  const env = process.env.KEYS_SCAN_ROOTS?.trim();
  return (env ? env.split(":") : [homedir()]).map((p) => resolve(p.replace(/^~(?=\/|$)/, homedir()))).filter(Boolean);
}

/** NAME=value lines that look like secrets: by name (…_KEY, …_TOKEN) or a URL with a password in it. */
export function parseEnvText(text: string, all = false): { var: string; value: string; line: number }[] {
  const out: { var: string; value: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if (/^["']/.test(v)) { const q = v[0]; const end = v.indexOf(q, 1); v = end > 0 ? v.slice(1, end) : v.slice(1); }
    else v = v.replace(/\s+#.*$/, "").trim();
    const name = m[1];
    const urlWithPassword = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i.test(v);
    if (all) { if (v) out.push({ var: name, value: v, line: i + 1 }); return; }
    if (!urlWithPassword && !SECRET_NAME.test(name.toUpperCase())) return;
    if (v.length < 8 || PLACEHOLDER.test(v) || /\s/.test(v)) return;
    out.push({ var: name, value: v, line: i + 1 });
  });
  return out;
}

async function findEnvFiles(deadline: number): Promise<string[]> {
  const files: string[] = [];
  const home = homedir();
  const roots = scanRoots();
  // Shell profiles too, when home is being scanned.
  if (roots.some((r) => home === r || home.startsWith(`${r}/`))) for (const f of PROFILE_FILES) { const p = join(home, f); if (existsSync(p)) files.push(p); }
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || dirs > 40_000 || Date.now() > deadline) return;
    dirs++;
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const subs: string[] = [];
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !(depth === 0 && e.name.startsWith(".") && e.name !== ".config")) subs.push(join(dir, e.name)); }
      else if (e.isFile() && ENV_FILE.test(e.name) && !NOT_REAL.test(e.name)) files.push(join(dir, e.name));
    }
    for (let i = 0; i < subs.length; i += 16) await Promise.all(subs.slice(i, i + 16).map((s) => walk(s, depth + 1)));
  };
  for (const r of roots) await walk(r, 0);
  return [...new Set(files)];
}

type ScanResult = { at: number; groups: FoundGroup[]; files: number; took_ms: number };
let scanCache: ScanResult | null = null;
let scanning: Promise<ScanResult> | null = null;
const SCAN_TTL_MS = 10 * 60_000;

/** Every secret-looking value in .env files and shell profiles under the scan roots, grouped by value. Cached. */
export function scan(refresh = false): Promise<ScanResult> {
  if (!refresh && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return Promise.resolve(scanCache);
  scanning ??= (async (): Promise<ScanResult> => {
    const t0 = Date.now();
    const files = await findEnvFiles(t0 + 15_000);
    const groups = new Map<string, FoundGroup>();
    for (const f of files) {
      let text: string;
      try { if ((await stat(f)).size > 512 * 1024) continue; text = await readFile(f, "utf8"); } catch { continue; }
      for (const e of parseEnvText(text)) {
        const fp = fingerprint(e.value);
        const g = groups.get(fp) ?? { fingerprint: fp, hint: hintOf(e.value), vars: [], files: [], stored: null };
        if (!g.vars.includes(e.var)) g.vars.push(e.var);
        g.files.push({ file: f, var: e.var, line: e.line });
        groups.set(fp, g);
      }
    }
    scanCache = { at: Date.now(), groups: [...groups.values()], files: files.length, took_ms: Date.now() - t0 };
    return scanCache;
  })().finally(() => { scanning = null; });
  return scanning;
}

/** The scan, with each group marked by the stored key that has the same value. */
export async function scanOut(refresh = false) {
  const s = await scan(refresh);
  const stored = new Map(db.query<{ name: string; fingerprint: string }, []>("SELECT name, fingerprint FROM secrets").all().map((r) => [r.fingerprint, r.name]));
  const home = homedir();
  const groups = s.groups.map((g) => ({ ...g, stored: stored.get(g.fingerprint) ?? null, files: g.files.map((f) => ({ ...f, file: f.file.replace(home, "~") })) }))
    .sort((a, b) => Number(Boolean(a.stored)) - Number(Boolean(b.stored)) || a.vars[0].localeCompare(b.vars[0]) || b.files.length - a.files.length);
  return { scanned_at: s.at, files: s.files, took_ms: s.took_ms, roots: scanRoots().map((r) => r.replace(home, "~")), groups };
}

function whereFiles(fp: string): Found[] {
  const home = homedir();
  return (scanCache?.groups.find((g) => g.fingerprint === fp)?.files ?? []).map((f) => ({ ...f, file: f.file.replace(home, "~") }));
}
function whereCount(fp: string): number | null {
  if (!scanCache) return null;
  return scanCache.groups.find((g) => g.fingerprint === fp)?.files.length ?? 0;
}

/** Store a value found on disk: read from `file` (a .env file or profile) at `var`, never sent by the caller. */
export async function importFound(b: { file: string; var: string } & SecretInput, who: Who) {
  const file = resolve(String(b.file ?? "").replace(/^~(?=\/|$)/, homedir()));
  const v = String(b.var ?? "");
  if (!file || !v) throw new ApiError(400, "file and var are required");
  if (!existsSync(file) || !statSync(file).isFile()) throw new ApiError(404, `no file at ${file}`);
  const found = parseEnvText(readFileSync(file, "utf8"), true).findLast((e) => e.var === v);
  if (!found) throw new ApiError(404, `${v} isn't set in ${file}`);
  const name = b.name?.trim() || suggestName(v, file);
  return createSecret({ ...b, name, value: found.value, env: b.env ?? v, source: file.replace(homedir(), "~") }, who);
}

/** A free name for a key from its env var and the folder it was found in: openai-api-key, openai-api-key-myproject. */
export function suggestName(envVar: string, file = ""): string {
  const base = envVar.toLowerCase().replace(/_/g, "-").replace(/^(next-public|vite|expo-public|react-app)-/, "");
  const taken = (n: string) => Boolean(db.query("SELECT 1 FROM secrets WHERE name = ? COLLATE NOCASE").get(n));
  if (!taken(base)) return base;
  const folder = file ? dirname(file).split("/").pop()!.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") : "";
  if (folder && !taken(`${base}-${folder}`)) return `${base}-${folder}`;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}
