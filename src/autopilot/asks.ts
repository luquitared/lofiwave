/**
 * Asks: how an agent reaches a person. An agent raises a question, an approval or a budget request; lofiwave stores
 * it, tells people, and brings the answer back into the run, saying who gave it. Every answer is kept, so "who
 * approved this?" has an answer that doesn't depend on anyone's memory or on what was on a screen.
 *
 * Delegation rules (policies) are standing answers: asks of a class get the same answer without asking again. A
 * rule is only ever made by a person, some classes can never have one, and each use is logged.
 */
import { db, now, type RunRow } from "../db";
import { ApiError } from "../runner";
import { logEvent, notify, linkTo, owe, who, usd, onDelivered } from "./core";
import { programmeRun, findProgramme, addEntry, setRunBudget, programmeOfRun } from "./programmes";
import type { AskRow, PolicyRow, ProgrammeRow } from "./schema";

/** Decisions a rule may never take: they leave the building, can't be undone, or move money. */
export const NEVER_AUTO = new Set(["external_send", "delete", "billing", "credentials", "data_egress"]);
export const KNOWN_CLASSES = ["merge", "deploy", "launch", "shutdown", "budget", "production", ...NEVER_AUTO];
const STANDARD = new Set(["approve", "deny", "yes", "no"]);

export type Option = { id: string; label: string; detail: string; recommended: boolean };

/** Options as given by a caller: strings ("A: do this*", * = recommended) or objects. */
export function parseOptions(v: unknown): Option[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ApiError(400, "options must be an array");
  const out: Option[] = [];
  v.forEach((o, i) => {
    let id = "", label = "", detail = "", recommended = false;
    if (typeof o === "string") {
      let s = o.trim();
      if (/\*\s*$/.test(s)) { recommended = true; s = s.replace(/\*\s*$/, "").trim(); }
      const m = /^([A-Za-z0-9_.-]{1,24})\*?\s*:\s+(.*)$/s.exec(s);
      if (m) { if (/\*$/.test(s.slice(0, s.indexOf(":")))) recommended = true; id = m[1]; label = m[2].trim(); } else label = s;
    } else if (o && typeof o === "object") {
      id = String((o as any).id ?? "").trim(); label = String((o as any).label ?? "").trim();
      detail = String((o as any).detail ?? "").trim(); recommended = Boolean((o as any).recommended);
    } else throw new ApiError(400, "each option is a string or {id, label, detail, recommended}");
    if (!label) throw new ApiError(400, `option ${i + 1} has no label`);
    out.push({ id: id || String.fromCharCode(65 + i), label, detail, recommended });
  });
  if (new Set(out.map((o) => o.id.toLowerCase())).size !== out.length) throw new ApiError(400, "option ids must differ");
  return out;
}

const optionsOf = (a: AskRow): Option[] => { try { return JSON.parse(a.options || "[]"); } catch { return []; } };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** What an answer comes down to, comparable across asks: approve/deny by id, anything else by its label. */
const answerKey = (o: Option) => (STANDARD.has(o.id.toLowerCase()) ? o.id.toLowerCase() : norm(o.label));
const findOption = (opts: Option[], want: string) => opts.find((o) => o.id.toLowerCase() === want.toLowerCase()) ?? opts.find((o) => norm(o.label) === norm(want)) ?? null;

export function getAsk(id: number): AskRow {
  const a = db.query<AskRow, [number]>("SELECT * FROM asks WHERE id = ?").get(id);
  if (!a) throw new ApiError(404, `ask ${id} not found`);
  return a;
}

export function askOut(a: AskRow) {
  const run = a.run_id ? db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(a.run_id) : null;
  const pr = a.run_id ? programmeRun(a.run_id) : null;
  const p = findProgramme(a.programme_id);
  const options = optionsOf(a);
  const chosen = a.answer_option ? options.find((o) => o.id === a.answer_option) ?? null : null;
  return {
    ...a, options, answer_label: chosen?.label ?? "",
    run_status: run?.status ?? null, worker: pr?.worker ?? "", from: pr?.worker || run?.workflow_name || (run ? `run ${run.id}` : a.created_by || "someone"),
    programme: p ? { id: p.id, slug: p.slug, name: p.name } : null,
    can_have_rule: Boolean(a.class) && !NEVER_AUTO.has(a.class),
    waited_ms: (a.answered_at ?? now()) - a.created_at,
  };
}

// ---------------------------------------------------------------- raising an ask

export type NewAsk = { title: string; body?: string; kind?: string; class?: string; options?: unknown; amount?: number | null; for_person?: string; programme?: ProgrammeRow | null };

export function createAsk(run: RunRow | null, b: NewAsk) {
  const title = b.title.trim();
  if (!title) throw new ApiError(400, "title is required: the question, in a line");
  const kind = b.kind ?? (b.amount !== undefined && b.amount !== null ? "budget" : "question");
  if (!["question", "approval", "budget"].includes(kind)) throw new ApiError(400, "kind must be question, approval or budget");
  const cls = (b.class ?? (kind === "budget" ? "budget" : "")).trim().toLowerCase();
  if (cls && !/^[a-z0-9_.-]{1,40}$/.test(cls)) throw new ApiError(400, "class may only contain letters, digits and _ . -");
  if (kind === "budget" && !(typeof b.amount === "number" && b.amount > 0)) throw new ApiError(400, "a budget ask needs amount: the new cap in USD");
  let options = parseOptions(b.options);
  if (!options.length && kind === "budget") options = [{ id: "approve", label: `Raise the cap to ${usd(b.amount)}`, detail: "", recommended: false }, { id: "deny", label: "Keep the current cap", detail: "", recommended: false }];
  if (!options.length && kind === "approval") options = [{ id: "approve", label: "Approve", detail: "", recommended: false }, { id: "deny", label: "Don't", detail: "", recommended: false }];
  const programme = b.programme ?? (run ? programmeOfRun(run.id) : null);
  const id = Number(db.prepare("INSERT INTO asks (run_id, programme_id, kind, class, title, body, options, amount, for_person, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(run?.id ?? null, programme?.id ?? null, kind, cls, title.slice(0, 500), (b.body ?? "").trim(), JSON.stringify(options), b.amount ?? null, (b.for_person ?? "").trim(), who(), now()).lastInsertRowid);
  let ask = getAsk(id);
  const from = askOut(ask).from;
  logEvent({ kind: "ask", programme_id: ask.programme_id, run_id: ask.run_id, ref: `ask:${id}`, actor: from, text: `${from} asks: ${title}` });
  const policy = matchPolicy(ask);
  if (policy) {
    const opt = findOption(options, policy.answer)!;
    ask = settle(ask, { option: opt, text: policy.note, by: policy.created_by, via: "rule", policy });
    return { ...askOut(ask), auto: true };
  }
  notify({
    kind: "ask", to: ask.for_person || (run ? JSON.parse(run.meta || "{}").started_by : "") || undefined,
    title: `${from} needs ${ask.for_person || "you"}: ${title}`,
    text: [ask.body.slice(0, 600), ...options.map((o) => `• ${o.id}: ${o.label}${o.recommended ? " (recommended)" : ""}`)].filter(Boolean).join("\n"),
    link: linkTo(`inbox/ask/${id}`),
  });
  return { ...askOut(ask), auto: false };
}

// ---------------------------------------------------------------- answering

const waiters = new Map<number, Set<() => void>>();

/** Record the answer, apply what it implies (a raised cap, a decision entry) and get it to the run. */
function settle(ask: AskRow, a: { option: Option | null; text: string; by: string; via: "person" | "rule"; policy?: PolicyRow }): AskRow {
  const upd = db.prepare("UPDATE asks SET status = 'answered', answer_option = ?, answer_text = ?, answered_by = ?, answered_via = ?, policy_id = ?, answered_at = ?, delivered = ? WHERE id = ? AND status = 'open'")
    .run(a.option?.id ?? "", a.text.trim(), a.by, a.via, a.policy?.id ?? null, now(), ask.run_id ? 0 : null, ask.id);
  if (!upd.changes) throw new ApiError(409, `ask ${ask.id} is no longer open`);
  const said = [a.option ? a.option.label : "", a.text.trim()].filter(Boolean).join(". ");
  const whoSaid = a.via === "rule" ? `rule #${a.policy!.id}, set by ${a.by || "someone"}` : a.by || "someone";
  if (a.policy) db.prepare("UPDATE policies SET applied_count = applied_count + 1, last_applied_at = ? WHERE id = ?").run(now(), a.policy.id);
  logEvent({ kind: a.via === "rule" ? "auto_answer" : "answer", programme_id: ask.programme_id, run_id: ask.run_id, ref: `ask:${ask.id}`, actor: a.via === "rule" ? `rule #${a.policy!.id}` : a.by, text: `${a.via === "rule" ? `Rule #${a.policy!.id} answered` : `${a.by || "Someone"} answered`} “${ask.title}”: ${said || "(no text)"}` });
  // A granted budget ask raises the worker's cap.
  if (ask.kind === "budget" && ask.run_id && ask.amount && a.option?.id.toLowerCase() === "approve" && programmeRun(ask.run_id)) setRunBudget(ask.run_id, ask.amount, `ask #${ask.id}, ${whoSaid}`);
  const p = findProgramme(ask.programme_id);
  if (p) addEntry(p, { kind: "decision", title: `${ask.title} → ${said || "answered"}`, body: ask.body.slice(0, 400), run_id: ask.run_id, ask_id: ask.id, by: whoSaid });
  const pending = waiters.get(ask.id);
  if (pending?.size) {
    // The agent is blocked on `lw ask --wait`: it reads the answer from that call, so nothing is typed into it.
    db.prepare("UPDATE asks SET delivered = 1 WHERE id = ?").run(ask.id);
    for (const fn of pending) fn();
  } else if (ask.run_id) {
    owe(ask.run_id, `Answer to ask #${ask.id} “${ask.title}”, from ${whoSaid}: ${said || "(no text)"}`, `ask:${ask.id}`);
  }
  return getAsk(ask.id);
}
onDelivered((m) => { const x = /^ask:(\d+)$/.exec(m.ref); if (x) db.prepare("UPDATE asks SET delivered = 1 WHERE id = ?").run(Number(x[1])); });

export type AnswerBody = { option?: string; text?: string; always?: boolean; max_amount?: number | null; everywhere?: boolean };

/** A person answers. `always`: also make it a rule for this class (in this programme, or `everywhere`). */
export function answerAsk(ask: AskRow, b: AnswerBody) {
  if (ask.status !== "open") throw new ApiError(409, `ask ${ask.id} is ${ask.status}`);
  const options = optionsOf(ask);
  const text = (b.text ?? "").trim();
  let option: Option | null = null;
  if (b.option) {
    option = findOption(options, b.option);
    if (!option) throw new ApiError(400, `"${b.option}" is not one of this ask's options (${options.map((o) => o.id).join(", ") || "it has none"})`);
  } else if (options.length && !text) throw new ApiError(400, "pick an option, or say what to do instead");
  else if (!text) throw new ApiError(400, "an answer is required");
  const by = who() || "someone";
  // A rule that can't be made is refused before the answer is recorded, so the person can answer without it.
  const rule = b.always
    ? checkPolicy({ class: ask.class, answer: option ? answerKey(option) : "", programme_id: b.everywhere ? null : ask.programme_id, max_amount: b.max_amount ?? (ask.kind === "budget" ? ask.amount : null), from_ask: ask.id, note: text })
    : null;
  const done = settle(ask, { option, text, by, via: "person" });
  const policy = rule ? createPolicy(rule) : null;
  return { ...askOut(done), policy, suggest_rule: policy || !option ? null : suggestion(done, option) };
}

/** After three asks of a class got the same answer from people, offer to make it a rule. */
function suggestion(ask: AskRow, option: Option) {
  if (!ask.class || NEVER_AUTO.has(ask.class)) return null;
  const last = db.query<AskRow, [string, number | null, number | null]>(
    "SELECT * FROM asks WHERE status = 'answered' AND answered_via = 'person' AND class = ? AND (programme_id IS ? OR programme_id = ?) AND answer_option != '' ORDER BY answered_at DESC, id DESC LIMIT 3").all(ask.class, ask.programme_id, ask.programme_id);
  if (last.length < 3) return null;
  const key = answerKey(option);
  const same = last.every((x) => { const o = optionsOf(x).find((y) => y.id === x.answer_option); return o && answerKey(o) === key; });
  if (!same || activePolicies(ask.class, ask.programme_id).length) return null;
  return { class: ask.class, answer: key, label: option.label, programme_id: ask.programme_id, count: last.length, max_amount: ask.kind === "budget" ? Math.max(...last.map((x) => x.amount ?? 0)) : null };
}

export function cancelAsk(ask: AskRow, why = "") {
  if (ask.status !== "open") throw new ApiError(409, `ask ${ask.id} is ${ask.status}`);
  db.prepare("UPDATE asks SET status = 'cancelled', answer_text = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(why.trim(), who(), now(), ask.id);
  logEvent({ kind: "ask_cancelled", programme_id: ask.programme_id, run_id: ask.run_id, ref: `ask:${ask.id}`, text: `Ask withdrawn: ${ask.title}${why ? ` (${why})` : ""}` });
  for (const fn of waiters.get(ask.id) ?? []) fn();
  return askOut(getAsk(ask.id));
}

/** Long-poll: resolves when the ask is answered or cancelled, or after `timeoutMs`. */
export function waitForAsk(id: number, timeoutMs: number, signal?: AbortSignal): Promise<{ ask: AskRow; reached: boolean }> {
  const cur = getAsk(id);
  if (cur.status !== "open") {
    if (cur.delivered === 0) db.prepare("UPDATE asks SET delivered = 1 WHERE id = ?").run(id);
    return Promise.resolve({ ask: getAsk(id), reached: true });
  }
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? waiters.set(id, new Set()).get(id)!;
    const finish = (reached: boolean) => { clearTimeout(timer); set.delete(wake); if (!set.size) waiters.delete(id); resolve({ ask: getAsk(id), reached }); };
    const wake = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    set.add(wake);
    signal?.addEventListener("abort", () => finish(false));
  });
}

// ---------------------------------------------------------------- delegation rules

export function getPolicy(id: number): PolicyRow {
  const p = db.query<PolicyRow, [number]>("SELECT * FROM policies WHERE id = ?").get(id);
  if (!p) throw new ApiError(404, `rule ${id} not found`);
  return p;
}
const activePolicies = (cls: string, programmeId: number | null) => db.query<PolicyRow, [string, number | null]>(
  "SELECT * FROM policies WHERE enabled = 1 AND class = ? AND (programme_id IS NULL OR programme_id = ?) ORDER BY programme_id IS NULL, id DESC").all(cls, programmeId);

/** The rule that answers this ask, if one does. The programme's own rule wins over one that holds everywhere. */
function matchPolicy(ask: AskRow): PolicyRow | null {
  if (!ask.class || NEVER_AUTO.has(ask.class) || ask.for_person) return null;
  const options = optionsOf(ask);
  for (const p of activePolicies(ask.class, ask.programme_id)) {
    if (ask.amount !== null && (p.max_amount === null || ask.amount > p.max_amount)) continue;
    const opt = options.find((o) => answerKey(o) === norm(p.answer)) ?? null;
    if (opt) return p;
  }
  return null;
}

type NewPolicy = { class: string; answer: string; programme_id?: number | null; max_amount?: number | null; note?: string; from_ask?: number | null };

/** The rule as it would be stored, or a 400 saying why it can't be one. */
function checkPolicy(b: NewPolicy): NewPolicy {
  const cls = (b.class ?? "").trim().toLowerCase();
  if (!cls) throw new ApiError(400, "a rule needs a class: the ask it came from has none, so there is nothing to recognise the next one by");
  if (NEVER_AUTO.has(cls)) throw new ApiError(400, `"${cls}" decisions are always asked: sending things out, deleting, billing, credentials and data leaving the company can't be delegated to a rule`);
  const answer = norm(b.answer ?? "");
  if (!answer) throw new ApiError(400, "a rule needs an answer: one of the ask's options");
  if (cls === "budget" && !(typeof b.max_amount === "number" && b.max_amount > 0)) throw new ApiError(400, "a budget rule needs max_amount: the highest cap it may grant");
  return { ...b, class: cls, answer };
}

export function createPolicy(input: NewPolicy): PolicyRow {
  const b = checkPolicy(input);
  const { class: cls, answer } = b;
  const id = Number(db.prepare("INSERT INTO policies (programme_id, class, answer, max_amount, note, created_by, from_ask, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(b.programme_id ?? null, cls, answer, b.max_amount ?? null, (b.note ?? "").trim(), who(), b.from_ask ?? null, now()).lastInsertRowid);
  const p = getPolicy(id);
  logEvent({ kind: "policy", programme_id: p.programme_id, ref: `policy:${id}`, text: `Rule #${id}: ${cls} asks are answered “${answer}”${p.max_amount !== null ? ` up to ${usd(p.max_amount)}` : ""}${p.programme_id ? "" : " everywhere"}` });
  return p;
}

export function updatePolicy(p: PolicyRow, b: { enabled?: boolean; max_amount?: number | null; note?: string }): PolicyRow {
  db.prepare("UPDATE policies SET enabled = ?, max_amount = ?, note = ? WHERE id = ?")
    .run(b.enabled === undefined ? p.enabled : b.enabled ? 1 : 0, b.max_amount === undefined ? p.max_amount : b.max_amount, b.note === undefined ? p.note : b.note.trim(), p.id);
  if (b.enabled !== undefined && Boolean(b.enabled) !== Boolean(p.enabled)) logEvent({ kind: "policy", programme_id: p.programme_id, ref: `policy:${p.id}`, text: `Rule #${p.id} (${p.class}) turned ${b.enabled ? "on" : "off"}` });
  return getPolicy(p.id);
}

export function policyOut(p: PolicyRow) {
  const prog = findProgramme(p.programme_id);
  return {
    ...p, enabled: p.enabled === 1, programme: prog ? { id: prog.id, slug: prog.slug, name: prog.name } : null,
    recent: db.query<AskRow, [number]>("SELECT * FROM asks WHERE policy_id = ? ORDER BY answered_at DESC LIMIT 5").all(p.id).map((a) => ({ id: a.id, title: a.title, answered_at: a.answered_at, run_id: a.run_id, amount: a.amount })),
  };
}
