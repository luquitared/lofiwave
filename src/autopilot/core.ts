/**
 * Shared by the autopilot modules: settings, the event log, notifications to people, and the outbox of messages owed
 * to runs.
 */
import { db, now, type RunRow } from "../db";
import { ApiError, sendMessage, activityOf } from "../runner";
import { transcriptMark, recordMessage } from "../messages";
import { actor, KEY_ACTOR_PREFIX, TOKEN_ACTOR } from "../auth";
import type { EventRow, OutboxRow, PersonRow } from "./schema";
import "./schema";

// ---------------------------------------------------------------- settings

/** Settings and the environment variable each falls back to. `secret`: listed masked. */
export const SETTINGS: Record<string, { env: string; secret?: boolean; def?: string; help: string }> = {
  public_url: { env: "PUBLIC_URL", help: "This console's address as people reach it (https://…), for links in notifications" },
  slack_webhook_url: { env: "SLACK_WEBHOOK_URL", secret: true, help: "A Slack incoming webhook: notifications go to its channel" },
  slack_bot_token: { env: "SLACK_BOT_TOKEN", secret: true, help: "A Slack bot token (chat:write): notifications to slack_channel, and direct messages to people with a Slack id" },
  slack_channel: { env: "SLACK_CHANNEL", help: "Channel id or name the bot posts to" },
  telegram_bot_token: { env: "TELEGRAM_BOT_TOKEN", secret: true, help: "A Telegram bot token" },
  telegram_chat_id: { env: "TELEGRAM_CHAT_ID", help: "The Telegram chat the bot writes to" },
  webhook_url: { env: "NOTIFY_WEBHOOK_URL", secret: true, help: "Any URL: each notification is POSTed to it as JSON" },
  digest_cron: { env: "DIGEST_CRON", help: "When to send the digest (cron, e.g. 0 9,18 * * *); empty = never" },
  stall_waiting_min: { env: "STALL_WAITING_MIN", def: "10", help: "Announce a run that has waited on a prompt this many minutes (0 = never)" },
  stall_idle_min: { env: "STALL_IDLE_MIN", def: "30", help: "Announce a programme worker idle this many minutes without reporting done or blocked (0 = never)" },
  nudge_days: { env: "NUDGE_DAYS", def: "2", help: "Follow up on an open item with its owner every this many days once it is due (0 = never)" },
  me: { env: "LOFIWAVE_ME", help: "The person notifications are for when nobody is named (a name from People)" },
};

export function setting(key: string): string {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  if (row && row.value !== "") return row.value;
  const s = SETTINGS[key];
  return (s && process.env[s.env]?.trim()) || s?.def || "";
}
export const settingNum = (key: string) => { const n = Number(setting(key)); return Number.isFinite(n) ? n : 0; };

const MASK = "••••";
export function settingsOut() {
  return Object.entries(SETTINGS).map(([key, s]) => {
    const stored = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "";
    const value = setting(key);
    return { key, help: s.help, secret: Boolean(s.secret), value: s.secret && value ? `${MASK}${value.length >= 12 ? value.slice(-4) : ""}` : value, source: stored ? "saved" : value && value !== s.def ? "env" : value ? "default" : "" };
  });
}
export function saveSettings(patch: Record<string, unknown>) {
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in SETTINGS)) throw new ApiError(400, `unknown setting "${key}"`);
    if (typeof v !== "string") throw new ApiError(400, `${key} must be a string`);
    if (v.startsWith(MASK)) continue;                       // a masked value sent back: keep what is stored
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, v.trim());
  }
}

// ---------------------------------------------------------------- who is acting

/** The caller as a person would read it: a sign-in name, "agent" for a run's own token, or the API key's name. */
export function who(): string {
  const a = actor.getStore() ?? "";
  return a === TOKEN_ACTOR ? "api" : a.startsWith(KEY_ACTOR_PREFIX) ? a.slice(KEY_ACTOR_PREFIX.length) : a;
}
/** True when the request came with a person's sign-in (a cookie), not the token or a key. */
export const isPerson = () => { const a = actor.getStore() ?? ""; return Boolean(a) && a !== TOKEN_ACTOR && !a.startsWith(KEY_ACTOR_PREFIX); };

// ---------------------------------------------------------------- events

const eventListeners = new Set<(e: EventRow) => void>();
export function onEvent(fn: (e: EventRow) => void) { eventListeners.add(fn); return () => eventListeners.delete(fn); }

export function logEvent(e: { kind: string; text: string; programme_id?: number | null; run_id?: number | null; ref?: string; actor?: string }): EventRow {
  const id = Number(db.prepare("INSERT INTO events (at, kind, programme_id, run_id, ref, actor, text) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(now(), e.kind, e.programme_id ?? null, e.run_id ?? null, e.ref ?? "", e.actor ?? who(), e.text).lastInsertRowid);
  const row = db.query<EventRow, [number]>("SELECT * FROM events WHERE id = ?").get(id)!;
  for (const fn of eventListeners) { try { fn(row); } catch (err) { console.error("[events]", err); } }
  return row;
}

export function eventsSince(since: number, o: { programme_id?: number; limit?: number } = {}): EventRow[] {
  return o.programme_id
    ? db.query<EventRow, [number, number, number]>("SELECT * FROM events WHERE at >= ? AND programme_id = ? ORDER BY id DESC LIMIT ?").all(since, o.programme_id, o.limit ?? 200)
    : db.query<EventRow, [number, number]>("SELECT * FROM events WHERE at >= ? ORDER BY id DESC LIMIT ?").all(since, o.limit ?? 200);
}

// ---------------------------------------------------------------- notifications

export type Note = { title: string; text?: string; link?: string; to?: string; kind: string };
type Sent = { channel: string; ok: boolean; error?: string; at: number };
const lastSent: Sent[] = [];
export const notifyLog = () => lastSent.slice(-20).reverse();

export const personByName = (name: string) => (name ? db.query<PersonRow, [string, string]>("SELECT * FROM people WHERE name = ? COLLATE NOCASE OR login = ? COLLATE NOCASE").get(name, name) : null);

/** A link into this console, when its public address is known. */
export function linkTo(hash: string): string {
  const base = setting("public_url").replace(/\/+$/, "");
  return base ? `${base}/#${hash}` : "";
}

async function post(channel: string, url: string, init: RequestInit, check?: (res: Response) => Promise<string | null>) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const err = !res.ok ? `HTTP ${res.status}` : check ? await check(res) : null;
    lastSent.push({ channel, ok: !err, error: err ?? undefined, at: now() });
    if (err) console.warn(`[notify] ${channel}: ${err}`);
  } catch (e: any) {
    lastSent.push({ channel, ok: false, error: String(e?.message ?? e), at: now() });
    console.warn(`[notify] ${channel}: ${e?.message ?? e}`);
  }
  if (lastSent.length > 100) lastSent.splice(0, lastSent.length - 100);
}

/**
 * Tell people something: to every channel that is set up. `to` names a person; with a Slack bot token and their Slack
 * id it also goes to them directly. Never throws and never blocks the caller: a dead webhook must not hold up a run.
 */
export function notify(n: Note): Promise<void> {
  const text = [n.title, n.text, n.link].filter(Boolean).join("\n");
  const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
  const jobs: Promise<void>[] = [];
  const hook = setting("slack_webhook_url");
  const slackText = `*${n.title}*${n.text ? `\n${n.text}` : ""}${n.link ? `\n<${n.link}|Open in lofiwave>` : ""}`;
  if (hook) jobs.push(post("slack webhook", hook, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ text: slackText }) }));
  const bot = setting("slack_bot_token");
  if (bot) {
    const api = (process.env.SLACK_API_URL || "https://slack.com/api").replace(/\/+$/, "");
    const person = n.to ? personByName(n.to) : null;
    const targets = [...new Set([person?.slack_id, setting("slack_channel")].filter(Boolean))] as string[];
    for (const channel of targets)
      jobs.push(post(`slack ${channel}`, `${api}/chat.postMessage`, { method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${bot}` }, body: JSON.stringify({ channel, text: slackText }) },
        async (res) => { const b: any = await res.json().catch(() => ({})); return b.ok === false ? String(b.error ?? "slack said no") : null; }));
  }
  const tg = setting("telegram_bot_token"), chat = setting("telegram_chat_id");
  if (tg && chat) {
    const api = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "");
    jobs.push(post("telegram", `${api}/bot${tg}/sendMessage`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }));
  }
  const url = setting("webhook_url");
  if (url) jobs.push(post("webhook", url, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...n, text: n.text ?? "", at: now() }) }));
  return Promise.all(jobs).then(() => {});
}
export const notifyChannels = () => [setting("slack_webhook_url") && "slack webhook", setting("slack_bot_token") && "slack bot", setting("telegram_bot_token") && setting("telegram_chat_id") && "telegram", setting("webhook_url") && "webhook"].filter(Boolean) as string[];

// ---------------------------------------------------------------- outbox: messages owed to runs

/** Every message lofiwave types into a run starts with this, so the agent (and the chat view) can tell it from a person. */
export const LW = "[lofiwave]";

/**
 * Queue a message for a run and try to deliver it now. It stays queued while the run waits on a prompt (Enter would
 * answer that instead) and is tried again on every tick, until the run ends.
 */
export function owe(runId: number, text: string, ref = ""): number {
  const id = Number(db.prepare("INSERT INTO outbox (run_id, text, ref, created_at) VALUES (?, ?, ?, ?)").run(runId, text.startsWith(LW) ? text : `${LW} ${text}`, ref, now()).lastInsertRowid);
  flushOutbox(runId).catch((e) => console.error("[outbox]", e));
  return id;
}

const flushing = new Set<number>();
/** Deliver what is owed to one run (or to every run), oldest first. Returns the outbox ids delivered. */
export async function flushOutbox(runId?: number): Promise<number[]> {
  const pending = runId
    ? db.query<OutboxRow, [number]>("SELECT * FROM outbox WHERE delivered_at IS NULL AND run_id = ? ORDER BY id").all(runId)
    : db.query<OutboxRow, []>("SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY id").all();
  const done: number[] = [];
  const stuck = new Set<number>();
  for (const m of pending) {
    if (stuck.has(m.run_id) || flushing.has(m.run_id)) continue;
    const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(m.run_id);
    if (!run || run.status !== "running") {
      // Nothing to type into any more: an ended run reads its answer when it is resumed (GET /api/asks/:id), not here.
      if (run && run.status !== "queued") db.prepare("UPDATE outbox SET delivered_at = ?, error = 'the run had ended' WHERE id = ?").run(now(), m.id);
      continue;
    }
    const meta = JSON.parse(run.meta || "{}");
    if (!meta.tmux && !(meta.e2b && meta.interactive)) { db.prepare("UPDATE outbox SET delivered_at = ?, error = 'the run is not interactive' WHERE id = ?").run(now(), m.id); continue; }
    if (activityOf(run).activity === "waiting_input") { stuck.add(m.run_id); continue; }
    flushing.add(m.run_id);
    try {
      const mark = transcriptMark(run);
      const sent = await sendMessage(run, m.text);
      if (sent.delivered === false) { stuck.add(m.run_id); db.prepare("UPDATE outbox SET attempts = attempts + 1, error = 'not delivered' WHERE id = ?").run(m.id); continue; }
      recordMessage(run, m.text, sent, mark, "lofiwave");
      db.prepare("UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, error = '' WHERE id = ?").run(now(), m.id);
      done.push(m.id);
      for (const fn of deliveredListeners) { try { fn(m); } catch (e) { console.error("[outbox]", e); } }
    } catch (e: any) {
      stuck.add(m.run_id);
      db.prepare("UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?").run(String(e?.message ?? e).slice(0, 300), m.id);
    } finally { flushing.delete(m.run_id); }
  }
  return done;
}
const deliveredListeners = new Set<(m: OutboxRow) => void>();
export function onDelivered(fn: (m: OutboxRow) => void) { deliveredListeners.add(fn); }

export const pendingFor = (runId: number) => db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM outbox WHERE delivered_at IS NULL AND run_id = ?").get(runId)!.n;

/** The run a request is about: `run_id` in the body, else the X-Lofiwave-Run header an agent's own calls carry. */
export function callerRun(req: Request, explicit?: unknown): RunRow | null {
  const raw = explicit ?? req.headers.get("x-lofiwave-run");
  if (raw === undefined || raw === null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "run_id must be a run's id");
  const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
  if (!run) throw new ApiError(404, `run ${id} not found`);
  return run;
}

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "" : `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, "")}`);
