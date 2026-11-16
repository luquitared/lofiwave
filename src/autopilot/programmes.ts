/**
 * Programmes: a line of work run by several agents over time. A programme owns what its workers need to share and
 * what must outlive any one session: the standing brief (versioned, and delivered to running workers when it
 * changes), rules and lessons, the decision log, published outputs and figures, spend, and where it stands.
 *
 * The context is also written as a file (CONTEXT.md under DATA_DIR, PROGRAMME.md in the programme's folder), because
 * agents read files well; the database is what keeps it current.
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { db, now, type RunRow } from "../db";
import { config } from "../config";
import { ApiError, activityOf, isLive } from "../runner";
import { logEvent, notify, linkTo, owe, who, usd } from "./core";
import type { ProgrammeRow, ProgrammeRunRow, RuleRow, EntryRow, OutcomeRow, AskRow } from "./schema";

// ---------------------------------------------------------------- programmes

export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export function getProgramme(ref: string | number): ProgrammeRow {
  const p = typeof ref === "number" || /^\d+$/.test(String(ref))
    ? db.query<ProgrammeRow, [number]>("SELECT * FROM programmes WHERE id = ?").get(Number(ref))
    : db.query<ProgrammeRow, [string]>("SELECT * FROM programmes WHERE slug = ?").get(String(ref));
  if (!p) throw new ApiError(404, `programme "${ref}" not found`);
  return p;
}
export const findProgramme = (ref: string | number | null | undefined): ProgrammeRow | null => {
  if (ref === null || ref === undefined || ref === "") return null;
  try { return getProgramme(ref); } catch { return null; }
};

export function createProgramme(b: { name: string; slug?: string; goal?: string; folder?: string; brief?: string; budget_usd?: number | null }): ProgrammeRow {
  const name = b.name.trim();
  if (!name) throw new ApiError(400, "name is required");
  const slug = slugify(b.slug || name);
  if (!slug) throw new ApiError(400, "name needs at least one letter or digit");
  if (db.query("SELECT 1 FROM programmes WHERE slug = ?").get(slug)) throw new ApiError(409, `a programme "${slug}" already exists`);
  const folder = (b.folder ?? "").trim();
  if (folder && (!existsSync(folder) || !statSync(folder).isDirectory())) throw new ApiError(400, `folder does not exist: ${folder}`);
  const t = now();
  const id = Number(db.prepare("INSERT INTO programmes (slug, name, goal, folder, budget_usd, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(slug, name, (b.goal ?? "").trim(), folder, b.budget_usd ?? null, who(), t, t).lastInsertRowid);
  logEvent({ kind: "programme", programme_id: id, text: `Programme "${name}" created` });
  if (b.brief?.trim()) setBrief(getProgramme(id), b.brief, "first version");
  else writeContext(getProgramme(id));
  return getProgramme(id);
}

export function updateProgramme(p: ProgrammeRow, b: { name?: string; goal?: string; folder?: string; budget_usd?: number | null; status?: string }): ProgrammeRow {
  const folder = b.folder === undefined ? p.folder : b.folder.trim();
  if (folder && (!existsSync(folder) || !statSync(folder).isDirectory())) throw new ApiError(400, `folder does not exist: ${folder}`);
  const status = b.status ?? p.status;
  if (!["active", "paused", "done"].includes(status)) throw new ApiError(400, "status must be active, paused or done");
  db.prepare("UPDATE programmes SET name = ?, goal = ?, folder = ?, budget_usd = ?, status = ?, updated_at = ? WHERE id = ?")
    .run(b.name?.trim() || p.name, b.goal === undefined ? p.goal : b.goal.trim(), folder, b.budget_usd === undefined ? p.budget_usd : b.budget_usd, status, now(), p.id);
  if (b.budget_usd !== undefined && b.budget_usd !== p.budget_usd) logEvent({ kind: "budget", programme_id: p.id, text: `Programme budget set to ${b.budget_usd === null ? "no cap" : usd(b.budget_usd)}` });
  const next = getProgramme(p.id);
  writeContext(next);
  return next;
}

export function setSummary(p: ProgrammeRow, text: string) {
  db.prepare("UPDATE programmes SET summary = ?, summary_at = ?, summary_by = ?, updated_at = ? WHERE id = ?").run(text.trim(), now(), who(), now(), p.id);
  logEvent({ kind: "summary", programme_id: p.id, text: "Summary rewritten" });
  writeContext(getProgramme(p.id));
}

// ---------------------------------------------------------------- the standing brief

/** Lines added and removed between two texts (an LCS diff), as "+ line" / "- line", capped. */
export function diffLines(a: string, b: string, cap = 40): string[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) return ["(the brief changed too much to list line by line)"];
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] > lcs[i + 1][j])) { if (y[j].trim()) out.push(`+ ${y[j]}`); j++; }
    else { if (x[i].trim()) out.push(`- ${x[i]}`); i++; }
  }
  return out.length > cap ? [...out.slice(0, cap), `… and ${out.length - cap} more changed lines`] : out;
}

/** A new version of the brief. Running workers are told what changed and where to read it. */
export function setBrief(p: ProgrammeRow, body: string, note = ""): ProgrammeRow {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text === p.brief.trim() && p.brief_version > 0) return p;
  const version = p.brief_version + 1;
  db.prepare("INSERT INTO programme_briefs (programme_id, version, body, note, by, at) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, version, text, note.trim(), who(), now());
  db.prepare("UPDATE programmes SET brief = ?, brief_version = ?, updated_at = ? WHERE id = ?").run(text, version, now(), p.id);
  const next = getProgramme(p.id);
  const file = writeContext(next);
  logEvent({ kind: "brief", programme_id: p.id, text: `Standing brief v${version}${note.trim() ? `: ${note.trim()}` : ""}` });
  if (version > 1) {
    const changes = diffLines(p.brief, text).join("\n");
    for (const r of liveRunsOf(p.id)) {
      owe(r.run_id, `The standing brief of programme "${p.name}" changed (v${r.brief_seen || "?"} → v${version})${note.trim() ? `: ${note.trim()}` : ""}. It overrides your earlier copy.\n${changes}\nThe full brief: ${file}`, `brief:${p.id}:${version}`);
    }
  }
  return next;
}

export const briefHistory = (p: ProgrammeRow) => db.query<{ version: number; note: string; by: string; at: number; body: string }, [number]>(
  "SELECT version, note, by, at, body FROM programme_briefs WHERE programme_id = ? ORDER BY version DESC").all(p.id);

/** Mark a brief version as given to a run, once the message carrying it has been typed in. */
export function briefDelivered(ref: string, runId: number) {
  const m = /^brief:(\d+):(\d+)$/.exec(ref);
  if (m) db.prepare("UPDATE programme_runs SET brief_seen = MAX(brief_seen, ?) WHERE run_id = ? AND programme_id = ?").run(Number(m[2]), runId, Number(m[1]));
}

// ---------------------------------------------------------------- rules and lessons

export const globalRules = (onlyEnabled = true) => db.query<RuleRow, []>(`SELECT * FROM rules WHERE scope = 'global' ${onlyEnabled ? "AND enabled = 1" : ""} ORDER BY id`).all();
export const programmeRules = (pid: number, onlyEnabled = true) => db.query<RuleRow, [number]>(`SELECT * FROM rules WHERE scope = 'programme' AND programme_id = ? ${onlyEnabled ? "AND enabled = 1" : ""} ORDER BY id`).all(pid);
export function getRule(id: number): RuleRow {
  const r = db.query<RuleRow, [number]>("SELECT * FROM rules WHERE id = ?").get(id);
  if (!r) throw new ApiError(404, `rule ${id} not found`);
  return r;
}

export function addRule(b: { body: string; title?: string; programme?: ProgrammeRow | null; kind?: string; applies?: string; run_id?: number | null }): RuleRow {
  const body = b.body.trim();
  if (!body) throw new ApiError(400, "body is required");
  const kind = b.kind === "lesson" ? "lesson" : "rule";
  const applies = b.applies === "all" ? "all" : "programme";
  const t = now();
  const id = Number(db.prepare("INSERT INTO rules (scope, programme_id, kind, applies, title, body, by, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(b.programme ? "programme" : "global", b.programme?.id ?? null, kind, applies, (b.title ?? "").trim(), body, who(), b.run_id ?? null, t, t).lastInsertRowid);
  const rule = getRule(id);
  logEvent({ kind: kind, programme_id: b.programme?.id ?? null, run_id: b.run_id ?? null, ref: `rule:${id}`, text: `${kind === "lesson" ? "Lesson" : b.programme ? "Programme rule" : "Global rule"} added: ${ruleLine(rule)}` });
  announceRule(rule, "added");
  return rule;
}

export function updateRule(r: RuleRow, b: { body?: string; title?: string; enabled?: boolean; applies?: string }): RuleRow {
  const body = b.body === undefined ? r.body : b.body.trim();
  if (!body) throw new ApiError(400, "body is required");
  const enabled = b.enabled === undefined ? r.enabled : b.enabled ? 1 : 0;
  db.prepare("UPDATE rules SET body = ?, title = ?, enabled = ?, applies = ?, updated_at = ? WHERE id = ?")
    .run(body, b.title === undefined ? r.title : b.title.trim(), enabled, b.applies === "all" ? "all" : b.applies === "programme" ? "programme" : r.applies, now(), r.id);
  const next = getRule(r.id);
  if (next.enabled && (next.body !== r.body || !r.enabled)) announceRule(next, r.enabled ? "changed" : "added");
  else rewriteContexts(next);
  return next;
}

export function deleteRule(r: RuleRow) {
  db.prepare("DELETE FROM rules WHERE id = ?").run(r.id);
  rewriteContexts(r);
}

const ruleLine = (r: RuleRow) => (r.title ? `${r.title}: ${r.body}` : r.body);

function rewriteContexts(r: RuleRow) {
  const ps = r.programme_id ? [getProgramme(r.programme_id)] : db.query<ProgrammeRow, []>("SELECT * FROM programmes WHERE status != 'done'").all();
  for (const p of ps) writeContext(p);
}

/** A rule that starts to apply mid-run reaches the runs already going, not only the ones started later. */
function announceRule(r: RuleRow, how: "added" | "changed") {
  rewriteContexts(r);
  const runs = r.programme_id
    ? liveRunsOf(r.programme_id)
    : db.query<ProgrammeRunRow, []>("SELECT pr.* FROM programme_runs pr JOIN runs r ON r.id = pr.run_id WHERE r.status = 'running'").all();
  const what = r.kind === "lesson" ? "A lesson from another run" : r.programme_id ? "A programme rule" : "A global rule";
  for (const pr of runs) if (pr.run_id !== r.run_id) owe(pr.run_id, `${what} was ${how} and applies to you from now on: ${ruleLine(r)}`, `rule:${r.id}`);
}

// ---------------------------------------------------------------- entries: decisions, outputs, figures

export function addEntry(p: ProgrammeRow, e: { kind: string; key?: string; title?: string; body?: string; value?: string; path?: string; run_id?: number | null; ask_id?: number | null; by?: string }): EntryRow {
  if (!["decision", "output", "figure"].includes(e.kind)) throw new ApiError(400, "kind must be decision, output or figure");
  const key = (e.key ?? "").trim();
  if (e.kind !== "decision" && !key) throw new ApiError(400, "key is required");
  if (e.kind === "decision" && !(e.title ?? "").trim()) throw new ApiError(400, "a decision needs a title");
  const id = Number(db.prepare("INSERT INTO entries (programme_id, kind, key, title, body, value, path, run_id, ask_id, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(p.id, e.kind, key, (e.title ?? "").trim(), (e.body ?? "").trim(), (e.value ?? "").trim(), (e.path ?? "").trim(), e.run_id ?? null, e.ask_id ?? null, e.by ?? who(), now()).lastInsertRowid);
  // The entry it replaces stays, marked: "which number stands" always has one answer.
  if (key) db.prepare("UPDATE entries SET superseded_by = ? WHERE programme_id = ? AND kind = ? AND key = ? AND id != ? AND superseded_by IS NULL").run(id, p.id, e.kind, key, id);
  const row = db.query<EntryRow, [number]>("SELECT * FROM entries WHERE id = ?").get(id)!;
  const label = e.kind === "figure" ? `Figure ${key} = ${row.value}` : e.kind === "output" ? `Output ${key}${row.value ? ` ${row.value}` : ""} published` : `Decision: ${row.title}`;
  logEvent({ kind: e.kind, programme_id: p.id, run_id: e.run_id ?? null, ref: `entry:${id}`, actor: row.by, text: label });
  writeContext(p);
  return row;
}

export const entriesOf = (pid: number, kind?: string, current = false) => db.query<EntryRow, [number]>(
  `SELECT * FROM entries WHERE programme_id = ? ${kind ? `AND kind = '${kind.replace(/[^a-z]/g, "")}'` : ""} ${current ? "AND superseded_by IS NULL" : ""} ORDER BY at DESC, id DESC`).all(pid);

// ---------------------------------------------------------------- runs of a programme

export const programmeRun = (runId: number) => db.query<ProgrammeRunRow, [number]>("SELECT * FROM programme_runs WHERE run_id = ?").get(runId);
export const programmeOfRun = (runId: number): ProgrammeRow | null => { const pr = programmeRun(runId); return pr ? findProgramme(pr.programme_id) : null; };
const liveRunsOf = (pid: number) => db.query<ProgrammeRunRow, [number]>("SELECT pr.* FROM programme_runs pr JOIN runs r ON r.id = pr.run_id WHERE pr.programme_id = ? AND r.status = 'running'").all(pid);

/** Tie a run to a programme (once: a row that exists is only filled in). */
export function attachRun(runId: number, p: ProgrammeRow, o: { worker?: string; role?: string; budget_usd?: number | null } = {}) {
  db.prepare("INSERT OR IGNORE INTO programme_runs (run_id, programme_id, worker, role, budget_usd, brief_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, p.id, (o.worker ?? "").trim(), o.role === "controller" ? "controller" : "worker", o.budget_usd ?? null, p.brief_version);
  if (o.budget_usd !== undefined) db.prepare("UPDATE programme_runs SET budget_usd = ? WHERE run_id = ?").run(o.budget_usd, runId);
}

export function setRunBudget(runId: number, budget: number | null, why = "") {
  const pr = programmeRun(runId);
  if (!pr) throw new ApiError(400, `run ${runId} is not part of a programme`);
  db.prepare("UPDATE programme_runs SET budget_usd = ? WHERE run_id = ?").run(budget, runId);
  logEvent({ kind: "budget", programme_id: pr.programme_id, run_id: runId, text: `Budget of ${pr.worker || `run ${runId}`} set to ${budget === null ? "no cap" : usd(budget)}${why ? ` (${why})` : ""}` });
}

export function setStatusLine(runId: number, text: string) {
  const pr = programmeRun(runId);
  if (!pr) throw new ApiError(400, `run ${runId} is not part of a programme`);
  db.prepare("UPDATE programme_runs SET status_line = ?, status_at = ? WHERE run_id = ?").run(text.trim().slice(0, 500), now(), runId);
}

// ---------------------------------------------------------------- spend

export const spentByRun = (runId: number) => db.query<{ s: number | null }, [number]>("SELECT SUM(amount_usd) s FROM spend WHERE run_id = ?").get(runId)!.s ?? 0;
export const spentByProgramme = (pid: number) => db.query<{ s: number | null }, [number]>("SELECT SUM(amount_usd) s FROM spend WHERE programme_id = ?").get(pid)!.s ?? 0;

/** Where a run stands against its own cap and its programme's. */
export function budgetOf(runId: number) {
  const pr = programmeRun(runId);
  const p = pr ? findProgramme(pr.programme_id) : null;
  const spent = spentByRun(runId);
  const programme_spent = p ? spentByProgramme(p.id) : spent;
  const cap = pr?.budget_usd ?? null, pcap = p?.budget_usd ?? null;
  const over = (cap !== null && spent >= cap) || (pcap !== null && programme_spent >= pcap);
  const near = !over && ((cap !== null && spent >= 0.8 * cap) || (pcap !== null && programme_spent >= 0.8 * pcap));
  return { spent, budget_usd: cap, programme_spent, programme_budget_usd: pcap, over, near };
}

/**
 * Log spend. `set`: the amount is the bucket's running total (the worker's own figure), and the difference is logged.
 * The first time a cap's 80 % or the cap itself is passed, people are told.
 */
export function addSpend(run: RunRow, b: { bucket?: string; amount_usd: number; note?: string; set?: boolean }) {
  if (!Number.isFinite(b.amount_usd)) throw new ApiError(400, "amount must be a number (USD)");
  const pr = programmeRun(run.id);
  const bucket = (b.bucket ?? "").trim().toLowerCase();
  const before = budgetOf(run.id);
  let amount = b.amount_usd;
  if (b.set) amount -= db.query<{ s: number | null }, [number, string]>("SELECT SUM(amount_usd) s FROM spend WHERE run_id = ? AND bucket = ?").get(run.id, bucket)!.s ?? 0;
  if (amount !== 0) db.prepare("INSERT INTO spend (run_id, programme_id, bucket, amount_usd, note, at) VALUES (?, ?, ?, ?, ?, ?)").run(run.id, pr?.programme_id ?? null, bucket, amount, (b.note ?? "").trim(), now());
  const after = budgetOf(run.id);
  const name = pr?.worker || `run ${run.id}`;
  if (after.over && !before.over) {
    logEvent({ kind: "budget", programme_id: pr?.programme_id ?? null, run_id: run.id, text: `${name} reached its budget: ${usd(after.spent)} of ${usd(after.budget_usd ?? after.programme_budget_usd)}` });
    notify({ kind: "budget", title: `Over budget: ${name}`, text: `${usd(after.spent)} spent, cap ${usd(after.budget_usd ?? after.programme_budget_usd)}. Spending commands are blocked until the cap is raised.`, link: linkTo(`sessions/${run.id}`) });
  } else if (after.near && !before.near && !before.over) {
    logEvent({ kind: "budget", programme_id: pr?.programme_id ?? null, run_id: run.id, text: `${name} passed 80% of its budget: ${usd(after.spent)} of ${usd(after.budget_usd ?? after.programme_budget_usd)}` });
  }
  return after;
}

// ---------------------------------------------------------------- outcomes

export const outcomeOf = (runId: number) => db.query<OutcomeRow, [number]>("SELECT * FROM run_outcomes WHERE run_id = ?").get(runId);

/** A run says what became of it. People are told; the programme's controller is woken by the event (see tick.ts). */
export function setOutcome(run: RunRow, b: { outcome: string; summary?: string; report_path?: string }): OutcomeRow {
  if (!["done", "blocked", "failed"].includes(b.outcome)) throw new ApiError(400, "outcome must be done, blocked or failed");
  const summary = (b.summary ?? "").trim();
  if (!summary) throw new ApiError(400, "say in a line or two what was done, or what is in the way");
  db.prepare("INSERT INTO run_outcomes (run_id, outcome, summary, report_path, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET outcome = excluded.outcome, summary = excluded.summary, report_path = excluded.report_path, at = excluded.at")
    .run(run.id, b.outcome, summary, (b.report_path ?? "").trim(), now());
  const pr = programmeRun(run.id);
  const name = pr?.worker || run.workflow_name || `run ${run.id}`;
  const label = { done: "Done", blocked: "Blocked", failed: "Failed" }[b.outcome]!;
  logEvent({ kind: `run_${b.outcome}`, programme_id: pr?.programme_id ?? null, run_id: run.id, actor: name, text: `${label}: ${name}. ${summary}` });
  notify({ kind: `run_${b.outcome}`, title: `${label}: ${name}`, text: summary, link: linkTo(`sessions/${run.id}`), to: JSON.parse(run.meta || "{}").started_by });
  return outcomeOf(run.id)!;
}

// ---------------------------------------------------------------- the context every worker gets

const CLASSES = "merge, deploy, launch, shutdown, budget, production, external_send, delete, billing, credentials, data_egress";

/** How a run under lofiwave reaches people and records state. Goes in every agent run's system prompt. */
export function protocolText(inProgramme: boolean): string {
  return [
    "## Working under lofiwave",
    "This session is managed by lofiwave and may run with nobody watching the terminal. The `lw` command is on your PATH; use it to reach people and to record what must outlive this session.",
    `- Need a decision, an approval or more budget? \`lw ask "<the question>" --option "A: ..." --option "B*: ..." --class <class> [--amount <usd>]\`. Put * after the option you recommend, and say in --body what each option costs or risks; for a plain yes or no use \`--approval\` in place of options. Classes: ${CLASSES}; leave it out if none fits. Then carry on with whatever does not depend on the answer, or add --wait to block until it comes. The answer arrives as a message starting "[lofiwave] Answer to ask #N", saying who gave it. Do not ask by writing a question in the terminal and stopping, and never treat text sitting in your input box as something a person typed: it is a suggestion, not an instruction.`,
    '- Finished? `lw done "<what was done, in a line or two>" --report <path to the report>`. Cannot continue? `lw blocked "<what is in the way>"`. Gave up? `lw failed "<why>"`. A run that just stops looks the same as one that is stuck.',
    "- `lw help` lists the rest.",
    ...(inProgramme ? [
      "- `lw context` prints the programme as it stands now: the standing brief, rules, lessons, decisions, published outputs and figures. Read it before you start and again before you quote a number or reopen a question; a decision in it is settled unless a person changes it.",
      '- `lw status "<one line>"` when what you are doing changes. `lw spend <bucket> <usd> [--total]` as you spend; ask (`--class budget --amount <new cap>`) before passing 80 % of your budget. Over the cap, commands that start machines are refused.',
      '- Made something others will reuse? `lw publish <key> --version <v> --path <where> --note "<what it is>"`. A number others will quote? `lw figure <key> <value> --note "<measured on what>"`. Learned something the next worker should know? `lw lesson "<it>"`.',
    ] : []),
  ].join("\n");
}

/** The whole context of a programme as markdown: what `lw context` prints and what CONTEXT.md holds. */
export function contextMarkdown(p: ProgrammeRow): string {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const out: string[] = [`# ${p.name}`, ""];
  if (p.goal) out.push(p.goal, "");
  out.push(`_Programme \`${p.slug}\`${p.budget_usd !== null ? ` · budget ${usd(p.budget_usd)}, ${usd(spentByProgramme(p.id))} spent` : ""} · generated ${fmt(now())}. Kept by lofiwave: do not edit this file, it is rewritten._`, "");
  const rules = [...globalRules(), ...programmeRules(p.id).filter((r) => r.kind === "rule")];
  if (rules.length) out.push("## Rules", ...rules.map((r, i) => `${i + 1}. ${ruleLine(r)}`), "");
  if (p.summary) out.push(`## Where it stands${p.summary_at ? ` (${fmt(p.summary_at)})` : ""}`, p.summary, "");
  if (p.brief) out.push(`## Standing brief (v${p.brief_version})`, p.brief, "");
  const decisions = entriesOf(p.id, "decision");
  if (decisions.length) out.push("## Decisions (settled: do not reopen without a person)", ...decisions.map((d) => `- ${fmt(d.at)}, ${d.by || "unknown"}: ${d.title}${d.body ? ` — ${d.body.replace(/\n+/g, " ")}` : ""}`), "");
  const figures = entriesOf(p.id, "figure", true);
  if (figures.length) out.push("## Figures (quote these, and only these)", ...figures.map((f) => `- \`${f.key}\` = **${f.value}**${f.body ? ` — ${f.body.replace(/\n+/g, " ")}` : ""} (${f.by || "unknown"}, ${fmt(f.at)})`), "");
  const outputs = entriesOf(p.id, "output", true);
  if (outputs.length) out.push("## Published outputs", ...outputs.map((o) => `- \`${o.key}\`${o.value ? ` ${o.value}` : ""}${o.path ? ` at ${o.path}` : ""}${o.body ? ` — ${o.body.replace(/\n+/g, " ")}` : ""} (${o.by || "unknown"}, ${fmt(o.at)})`), "");
  const lessons = programmeRules(p.id).filter((r) => r.kind === "lesson");
  if (lessons.length) out.push("## Lessons from earlier runs", ...lessons.map((l) => `- ${ruleLine(l)}`), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export const contextFile = (p: ProgrammeRow) => join(config.dataDir, "programmes", p.slug, "CONTEXT.md");

/** Write the context files; returns the path workers are pointed at. */
export function writeContext(p: ProgrammeRow): string {
  const md = contextMarkdown(p);
  const file = contextFile(p);
  try {
    mkdirSync(join(config.dataDir, "programmes", p.slug), { recursive: true });
    writeFileSync(file, md);
    if (p.folder && existsSync(p.folder)) writeFileSync(join(p.folder, "PROGRAMME.md"), md);
  } catch (e) { console.warn(`[programmes] could not write the context of ${p.slug}:`, e); }
  return file;
}

/**
 * What a run is started with (runner's context hook): the protocol for every agent run, the global rules that apply,
 * and for a programme's run its name, budget and where the context is.
 */
export function startContext(meta: Record<string, any>): { instructions: string; env: Record<string, string> } {
  const p = findProgramme(meta.programme);
  const env: Record<string, string> = {};
  const parts = [protocolText(Boolean(p))];
  if (p) {
    const file = writeContext(p);
    const worker = String(meta.worker ?? "");
    env.LOFIWAVE_PROGRAMME = p.slug;
    env.LOFIWAVE_CONTEXT_FILE = file;
    if (worker) env.LOFIWAVE_WORKER = worker;
    parts.push([
      `## Programme: ${p.name}${worker ? ` (you are worker \`${worker}\`)` : ""}${meta.role === "controller" ? " (you are its controller)" : ""}`,
      p.goal,
      `The programme's context is in ${file} (also: \`lw context\`). Read it first. It holds the standing brief (v${p.brief_version}), the rules, decisions already made, figures, published outputs and lessons from earlier runs.`,
      typeof meta.budget_usd === "number" ? `Your budget is ${usd(meta.budget_usd)}.` : "",
    ].filter(Boolean).join("\n"));
  } else {
    const rules = globalRules().filter((r) => r.applies === "all");
    if (rules.length) parts.push(["## Rules", ...rules.map((r, i) => `${i + 1}. ${ruleLine(r)}`)].join("\n"));
  }
  return { instructions: parts.join("\n\n"), env };
}

// ---------------------------------------------------------------- what the UI and the controller read

export function workersOf(p: ProgrammeRow) {
  const rows = db.query<ProgrammeRunRow & { status: string; started_at: number; ended_at: number | null; cwd: string; type_name: string; meta: string }, [number]>(
    "SELECT pr.*, r.status, r.started_at, r.ended_at, r.cwd, r.type_name, r.meta FROM programme_runs pr JOIN runs r ON r.id = pr.run_id WHERE pr.programme_id = ? ORDER BY r.started_at DESC").all(p.id);
  return rows.map((w) => {
    const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(w.run_id)!;
    const act = run.status === "running" ? activityOf(run) : null;
    const outcome = outcomeOf(w.run_id);
    const open_asks = db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM asks WHERE run_id = ? AND status = 'open'").get(w.run_id)!.n;
    // One word for the row: what a person scanning the board needs to know.
    const state = outcome?.outcome === "blocked" && run.status === "running" ? "blocked"
      : open_asks && run.status === "running" ? "needs you"
      : outcome ? outcome.outcome
      : run.status === "running" ? (act?.activity === "waiting_input" ? "needs you" : act?.activity === "idle" ? "idle" : "working")
      : run.status === "queued" ? "queued"
      : run.status === "success" ? "ended" : run.status;
    const { meta: _m, ...rest } = w;
    return {
      ...rest, state, live: isLive(w.run_id), activity: act?.activity ?? null, activity_since: act?.activity_since ?? null, waiting_for: act?.waiting_for ?? null,
      outcome: outcome ?? null, open_asks, spent: spentByRun(w.run_id), brief_current: w.brief_seen >= p.brief_version,
      started_by: JSON.parse(w.meta || "{}").started_by ?? "",
    };
  });
}

export function programmeOut(p: ProgrammeRow, full = false) {
  const workers = workersOf(p);
  const counts: Record<string, number> = {};
  for (const w of workers) counts[w.state] = (counts[w.state] ?? 0) + 1;
  const base = {
    ...p, context_file: contextFile(p), spent: spentByProgramme(p.id), worker_counts: counts,
    open_asks: db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM asks WHERE programme_id = ? AND status = 'open'").get(p.id)!.n,
    live_runs: workers.filter((w) => w.status === "running").length,
  };
  if (!full) return base;
  return {
    ...base, workers,
    rules: programmeRules(p.id, false),
    decisions: entriesOf(p.id, "decision"),
    figures: entriesOf(p.id, "figure"),
    outputs: entriesOf(p.id, "output"),
    briefs: briefHistory(p).map(({ body: _b, ...v }) => v),
    spend_by_bucket: db.query<{ bucket: string; total: number }, [number]>("SELECT bucket, SUM(amount_usd) total FROM spend WHERE programme_id = ? GROUP BY bucket ORDER BY total DESC").all(p.id),
    asks: db.query<AskRow, [number]>("SELECT * FROM asks WHERE programme_id = ? ORDER BY id DESC LIMIT 50").all(p.id),
  };
}
