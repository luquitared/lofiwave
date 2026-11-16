/**
 * Playbooks: the prompts of the runs that keep work moving without a person in the loop. A programme's controller,
 * and intake passes that turn what people said (Slack, session endings) into items and signals. Each becomes an
 * ordinary workflow, so it runs on a schedule, shows in Sessions and can be steered like any other run.
 */
import { homedir } from "node:os";
import { db, now, type WorkflowRow } from "../db";
import { ApiError, getType } from "../runner";
import { validateCron } from "../cron";
import { refreshNextRun } from "../scheduler";
import { logEvent } from "./core";
import type { ProgrammeRow } from "./schema";

/** What a programme's controller is told each time it wakes. Its memory is the programme, not this conversation. */
export function controllerPrompt(p: ProgrammeRow): string {
  return `You are the controller of the lofiwave programme "${p.name}" (\`${p.slug}\`). You run unattended and you may be a fresh session: everything you need is in lofiwave, nothing is in your memory. Work through this, then stop.

1. \`lw context\` for the brief, rules, decisions, figures, outputs and lessons. \`lw programme\` for every worker: its state, last status line, outcome, spend against its cap, open asks.
2. For each worker that finished since the summary was written: read its report (\`lw results <run>\`), check its claims against what it produced, and record what others will need: \`lw figure\`, \`lw publish\`, \`lw lesson\`. If two numbers for the same thing disagree, find out which stands and record that one.
3. For each worker that is blocked, failed, idle without reporting, or ended without an outcome: find out why (\`lw results <run>\`, \`lw log <run>\`) and act: message it (\`lw message <run> "..."\`), restart it, or raise an ask if a person has to decide.
4. Stop workers that are done and still holding a session or machines (\`lw stop <run>\`). Check that nothing they started is still running and costing money.
5. If the plan in the brief calls for the next wave and its inputs exist, start it: one \`lw start <worker> --brief <file> --budget <usd>\` per worker, each brief naming what to read first (by key from the published outputs) and what to produce. Starting workers beyond what the brief plans is a decision: \`lw ask ... --class launch\`.
6. Rewrite the summary so a person can read where the programme stands in a minute: \`lw summary -f <file>\`. Lead with what changed, then what is running, what is blocked and on whom, spend against budget, and what you recommend next.
7. Anything only a person can decide goes in one \`lw ask\` each, with options and your recommendation. Do not wait for answers: they reach whoever runs as controller next.
8. \`lw done "<what you did this pass>"\`.

Never send anything outside the company, delete data, or change production on your own: those are asks.`;
}

export type Playbook = { name: string; title: string; description: string; schedule: string; prompt: string };

export const PLAYBOOKS: Playbook[] = [
  {
    name: "slack-intake",
    title: "Slack intake",
    description: "Reads the team's Slack since the last pass and files commitments, questions and product signals as items. Needs a Slack connector in the agent it runs as.",
    schedule: "0 8,13,18 * * 1-5",
    prompt: `You keep lofiwave's ledger of commitments in step with Slack. You run unattended; read only, never post or react.

1. \`lw items --status open\` so you know what is already tracked, and \`lw people\` for who is who.
2. Read the channels and DMs the team works in since your last pass (the newest \`source_key\` you filed says where you stopped; without one, the last 3 days).
3. File what you find, one \`lw item add\` each, with \`--source <permalink>\` and \`--source-key slack:<channel>:<ts>\` so nothing is filed twice:
   - a commitment someone made or was given ("Sam by Friday", "I'll send it tomorrow"): \`--kind do --owner <person> --due <date>\`;
   - a question or request waiting on someone: \`--kind decide --owner <the person who must answer>\`;
   - a customer, vendor or teammate asking for a feature or reporting a recurring problem: \`--kind signal\`, with who asked and their words in --body.
4. Close items Slack shows are finished: \`lw item done <id> --note "<how you know>"\`.
5. If a message is a question an existing run could answer (it names a run, a programme or its work), pass it on: \`lw message <run> "<who asks what, with the link>"\`.
6. \`lw done "<n> added, <n> closed, <n> signals"\`.

Write each title so a stranger could act on it. Do not copy credentials or personal details into an item: say where they are.`,
  },
  {
    name: "session-triage",
    title: "Session triage",
    description: "Reads the endings of agent sessions nobody has looked at and files what they left open: unanswered questions, unmerged work, risks.",
    schedule: "0 7 * * *",
    prompt: `You keep lofiwave's ledger in step with what agent sessions left behind. You run unattended.

1. \`lw items --status open\` for what is tracked. \`lw runs --ended 2d\` for runs that ended in the last two days, with their outcome if they reported one.
2. For each run without an item of its own, read how it ended (\`lw log <run>\`, \`lw results <run>\`). File what is still open, one \`lw item add\` each with \`--source-key run:<id>:<n>\`:
   - it ended on a question or an offer nobody answered: \`--kind decide --owner <who must answer>\`, the question as the title;
   - work that exists but is not merged, deployed or sent: \`--kind do\`; \`--owner agent\` if an agent could finish it with no further input;
   - shipped but never seen working: \`--kind verify\`; a hazard someone could walk into: \`--kind risk\`.
3. Close items that a later run finished: \`lw item done <id> --note "<how you know>"\`.
4. \`lw done "<n> runs read, <n> items added, <n> closed"\`.

Leave out what the session itself resolved, and offers nobody would miss.`,
  },
  {
    name: "signals-to-specs",
    title: "Signals to specs",
    description: "Groups open product signals, and for the strongest writes a one-page spec and asks whether to build it.",
    schedule: "0 9 * * 1",
    prompt: `You turn product signals into proposals. You run unattended.

1. \`lw items --kind signal --status open\`. Group the ones that ask for the same thing; note who asked and how often.
2. For the two or three strongest groups, write a one-page spec in $LOFIWAVE_OUT_DIR/<slug>.md: the problem in the askers' words, who has it, the smallest thing that would solve it, what it would take, what is unknown.
3. For each spec, \`lw ask "Build <it>?" --approval --class launch --body "<three lines and the spec's path>"\`. Do not start building.
4. \`lw item note <id> "<spec path>"\` on the signals each spec covers.
5. \`lw done "<n> specs proposed"\`.`,
  },
];

export const getPlaybook = (name: string): Playbook => {
  const p = PLAYBOOKS.find((x) => x.name === name);
  if (!p) throw new ApiError(404, `no playbook "${name}"`);
  return p;
};

function upsertWorkflow(w: { name: string; type: string; cwd: string; prompt: string; schedule: string; programme: string; enabled: boolean; extra_args?: string[] }): WorkflowRow {
  getType(w.type);
  if (w.schedule) { const err = validateCron(w.schedule); if (err) throw new ApiError(400, `schedule: ${err}`); }
  const t = now();
  const cur = db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE name = ?").get(w.name);
  if (cur) db.prepare("UPDATE workflows SET type_name = ?, cwd = ?, prompt = ?, schedule = ?, programme = ?, enabled = ?, extra_args = ?, updated_at = ? WHERE id = ?")
    .run(w.type, w.cwd, w.prompt, w.schedule, w.programme, w.enabled ? 1 : 0, JSON.stringify(w.extra_args ?? JSON.parse(cur.extra_args || "[]")), t, cur.id);
  else db.prepare("INSERT INTO workflows (name, type_name, cwd, prompt, schedule, programme, enabled, extra_args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(w.name, w.type, w.cwd, w.prompt, w.schedule, w.programme, w.enabled ? 1 : 0, JSON.stringify(w.extra_args ?? []), t, t);
  const row = db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE name = ?").get(w.name)!;
  refreshNextRun(row);
  return row;
}

/**
 * Give a programme a controller: a workflow that runs the controller playbook, on a schedule (a heartbeat) and
 * whenever a worker reports or ends (see tick.ts). An empty schedule leaves it event-driven only.
 */
export function setController(p: ProgrammeRow, o: { schedule?: string; type?: string; cwd?: string; enabled?: boolean; extra_args?: string[] }): WorkflowRow {
  const wf = upsertWorkflow({
    name: `${p.slug}: controller`, type: o.type || "claude", cwd: (o.cwd || p.folder || homedir()).trim(),
    prompt: controllerPrompt(p), schedule: (o.schedule ?? "").trim(), programme: p.slug, enabled: o.enabled ?? true, extra_args: o.extra_args,
  });
  db.prepare("UPDATE programmes SET controller_workflow = ?, updated_at = ? WHERE id = ?").run(wf.id, now(), p.id);
  logEvent({ kind: "programme", programme_id: p.id, text: `Controller set up${wf.schedule ? ` (${wf.schedule})` : " (wakes on worker events)"}` });
  return wf;
}

export function workflowFromPlaybook(name: string, o: { schedule?: string; type?: string; cwd?: string; programme?: string; extra_args?: string[] }): WorkflowRow {
  const pb = getPlaybook(name);
  return upsertWorkflow({ name: pb.title, type: o.type || "claude", cwd: (o.cwd || homedir()).trim(), prompt: pb.prompt, schedule: (o.schedule ?? pb.schedule).trim(), programme: o.programme ?? "", enabled: true, extra_args: o.extra_args });
}
