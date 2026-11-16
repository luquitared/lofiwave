/**
 * The commitments ledger: what is open, who holds it and by when, for agents and people alike. Items come from
 * agents (`lw item`), from intake runs reading Slack or session endings (src/autopilot/playbooks.ts), and from people.
 * An item past its date is followed up with its owner, so nobody has to send "any update?".
 *
 * A product signal (a customer or teammate asking for something) is an item of kind `signal`: the backlog a
 * programme's controller can turn into specs.
 */
import { db, now } from "../db";
import { ApiError } from "../runner";
import { logEvent, notify, linkTo, who, settingNum, setting, personByName } from "./core";
import { findProgramme } from "./programmes";
import type { ItemRow, PersonRow } from "./schema";

const KINDS = ["do", "decide", "verify", "risk", "signal"];
const PRIORITIES = ["high", "med", "low"];

/** A date as given by a person or an agent: Unix ms, an ISO date, or "3d" / "2w" from now. null clears it. */
export function parseWhen(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  const rel = /^(\d+)\s*([hdw])$/.exec(s);
  if (rel) return now() + Number(rel[1]) * { h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[rel[2] as "h" | "d" | "w"];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ApiError(400, `can't read "${s}" as a date (use 2026-11-20, or 3d / 2w from now)`);
  return t;
}

export function getItem(id: number): ItemRow {
  const i = db.query<ItemRow, [number]>("SELECT * FROM items WHERE id = ?").get(id);
  if (!i) throw new ApiError(404, `item ${id} not found`);
  return i;
}
export function itemOut(i: ItemRow) {
  const p = findProgramme(i.programme_id);
  return { ...i, programme: p ? { id: p.id, slug: p.slug, name: p.name } : null, overdue: i.status === "open" && i.due_at !== null && i.due_at < now() };
}

export type ItemBody = { title?: string; body?: string; kind?: string; owner?: string; priority?: string; due?: unknown; source?: string; source_key?: string; note?: string; programme_id?: number | null; status?: string };

export function addItem(b: ItemBody): { item: ItemRow; existed: boolean } {
  const title = (b.title ?? "").trim();
  if (!title) throw new ApiError(400, "title is required: one line a stranger could act on");
  const kind = b.kind ?? "do";
  if (!KINDS.includes(kind)) throw new ApiError(400, `kind must be one of ${KINDS.join(", ")}`);
  const priority = b.priority ?? "med";
  if (!PRIORITIES.includes(priority)) throw new ApiError(400, `priority must be one of ${PRIORITIES.join(", ")}`);
  const key = (b.source_key ?? "").trim();
  // An intake pass that reads the same message twice gets the item it made the first time.
  if (key) {
    const had = db.query<ItemRow, [string]>("SELECT * FROM items WHERE source_key = ?").get(key);
    if (had) return { item: had, existed: true };
  }
  const t = now();
  const id = Number(db.prepare("INSERT INTO items (programme_id, kind, title, body, owner, priority, due_at, source, source_key, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(b.programme_id ?? null, kind, title.slice(0, 500), (b.body ?? "").trim(), (b.owner ?? "").trim(), priority, parseWhen(b.due), (b.source ?? "").trim(), key, (b.note ?? "").trim(), who(), t, t).lastInsertRowid);
  const item = getItem(id);
  logEvent({ kind: "item", programme_id: item.programme_id, ref: `item:${id}`, text: `${kind === "signal" ? "Signal" : "Item"} added${item.owner ? ` for ${item.owner}` : ""}: ${title}` });
  return { item, existed: false };
}

export function updateItem(i: ItemRow, b: ItemBody): ItemRow {
  const status = b.status ?? i.status;
  if (!["open", "done", "dropped"].includes(status)) throw new ApiError(400, "status must be open, done or dropped");
  if (b.kind !== undefined && !KINDS.includes(b.kind)) throw new ApiError(400, `kind must be one of ${KINDS.join(", ")}`);
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) throw new ApiError(400, `priority must be one of ${PRIORITIES.join(", ")}`);
  const closing = status !== "open" && i.status === "open";
  db.prepare("UPDATE items SET title = ?, body = ?, kind = ?, owner = ?, priority = ?, due_at = ?, note = ?, programme_id = ?, status = ?, updated_at = ?, closed_at = ? WHERE id = ?")
    .run(b.title?.trim() || i.title, b.body === undefined ? i.body : b.body.trim(), b.kind ?? i.kind, b.owner === undefined ? i.owner : b.owner.trim(), b.priority ?? i.priority,
      b.due === undefined ? i.due_at : parseWhen(b.due), b.note === undefined ? i.note : b.note.trim(), b.programme_id === undefined ? i.programme_id : b.programme_id,
      status, now(), status === "open" ? null : closing ? now() : i.closed_at, i.id);
  if (closing) logEvent({ kind: "item", programme_id: i.programme_id, ref: `item:${i.id}`, text: `Item ${status}: ${i.title}${b.note?.trim() ? ` (${b.note.trim()})` : ""}` });
  return getItem(i.id);
}

export function listItems(f: { status?: string; owner?: string; kind?: string; programme_id?: number; limit?: number }) {
  const where: string[] = [], args: any[] = [];
  if (f.status && f.status !== "all") { where.push("status = ?"); args.push(f.status); }
  if (f.owner) { where.push("owner = ? COLLATE NOCASE"); args.push(f.owner); }
  if (f.kind) { where.push("kind = ?"); args.push(f.kind); }
  if (f.programme_id) { where.push("programme_id = ?"); args.push(f.programme_id); }
  return db.query<ItemRow, any[]>(`SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY status = 'open' DESC, CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, due_at IS NULL, due_at, id DESC LIMIT ?`)
    .all(...args, Math.min(f.limit ?? 200, 1000)).map(itemOut);
}

/** Follow up on items that are past their date: tell the owner, at most once every `nudge_days`. */
export function nudgeDue(): number {
  const every = settingNum("nudge_days");
  if (every <= 0) return 0;
  const t = now();
  const due = db.query<ItemRow, [number, number]>(
    "SELECT * FROM items WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? AND owner != '' AND owner != 'agent' AND (nudged_at IS NULL OR nudged_at < ?) ORDER BY due_at LIMIT 20").all(t, t - every * 86400_000);
  for (const i of due) {
    db.prepare("UPDATE items SET nudged_at = ?, nudges = nudges + 1 WHERE id = ?").run(t, i.id);
    const days = Math.max(1, Math.round((t - i.due_at!) / 86400_000));
    notify({ kind: "nudge", to: i.owner, title: `Still open, ${days} day${days === 1 ? "" : "s"} past its date (${i.owner}): ${i.title}`, text: i.body.slice(0, 400), link: linkTo(`inbox/item/${i.id}`) });
    logEvent({ kind: "nudge", programme_id: i.programme_id, ref: `item:${i.id}`, actor: "lofiwave", text: `Followed up with ${i.owner}: ${i.title}` });
  }
  return due.length;
}

// ---------------------------------------------------------------- people

export const listPeople = () => db.query<PersonRow, []>("SELECT * FROM people ORDER BY name COLLATE NOCASE").all();
export function savePerson(cur: PersonRow | null, b: { name?: string; login?: string; slack_id?: string; notes?: string }): PersonRow {
  const name = (b.name ?? cur?.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");
  if (cur) {
    db.prepare("UPDATE people SET name = ?, login = ?, slack_id = ?, notes = ? WHERE id = ?").run(name, (b.login ?? cur.login).trim(), (b.slack_id ?? cur.slack_id).trim(), (b.notes ?? cur.notes).trim(), cur.id);
    return db.query<PersonRow, [number]>("SELECT * FROM people WHERE id = ?").get(cur.id)!;
  }
  if (db.query("SELECT 1 FROM people WHERE name = ? COLLATE NOCASE").get(name)) throw new ApiError(409, `"${name}" is already in People`);
  const id = Number(db.prepare("INSERT INTO people (name, login, slack_id, notes, created_at) VALUES (?, ?, ?, ?, ?)").run(name, (b.login ?? "").trim(), (b.slack_id ?? "").trim(), (b.notes ?? "").trim(), now()).lastInsertRowid);
  return db.query<PersonRow, [number]>("SELECT * FROM people WHERE id = ?").get(id)!;
}

/** The names an item's owner may go by for the person asking: their sign-in name, and the People entry it belongs to. */
export function namesOf(login: string): string[] {
  const me = setting("me");
  const p = personByName(login) ?? (login === "api" || !login ? personByName(me) : null);
  return [...new Set([login, p?.name, p?.login, "me"].filter(Boolean).map((s) => s!.toLowerCase()))];
}
