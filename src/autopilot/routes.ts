/**
 * The HTTP API of the autopilot modules (README → Autopilot). Registered by src/server.ts, which passes in its
 * route table and body helpers.
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { db, now, type RunRow } from "../db";
import { config } from "../config";
import { ApiError, getRun, killRun, runHooks, tmuxPath, getType } from "../runner";
import { startJob } from "../jobs";
import { makeFolder, writeFiles } from "../files";
import { allRequests } from "../chat/approvals";
import { actor } from "../auth";
import { callerRun, eventsSince, isPerson, notify, notifyChannels, notifyLog, saveSettings, setting, settingsOut, who, linkTo, logEvent } from "./core";
import {
  getProgramme, findProgramme, createProgramme, updateProgramme, programmeOut, setBrief, briefHistory, setSummary, contextMarkdown,
  addRule, getRule, updateRule, deleteRule, globalRules, programmeRules, addEntry, attachRun, programmeRun, programmeOfRun,
  setRunBudget, setStatusLine, addSpend, budgetOf, setOutcome, outcomeOf, startContext, slugify,
} from "./programmes";
import { getAsk, askOut, createAsk, answerAsk, cancelAsk, waitForAsk, getPolicy, createPolicy, updatePolicy, policyOut, KNOWN_CLASSES, NEVER_AUTO } from "./asks";
import { listGuards, getGuard, saveGuard, pretoolHook } from "./guards";
import { addItem, getItem, itemOut, updateItem, listItems, listPeople, savePerson, namesOf } from "./items";
import { stalls, digest, startAutopilot } from "./tick";
import { PLAYBOOKS, setController, workflowFromPlaybook } from "./playbooks";
import type { AskRow, PolicyRow, PersonRow, EventRow } from "./schema";

type Handler = (req: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;
type Helpers = {
  route: (method: string, path: string, handler: Handler) => void;
  json: (data: unknown, status?: number) => Response;
  body: (req: Request) => Promise<any>;
  runOut: (r: RunRow, o?: { withOutput?: boolean }) => any;
};

const str = (v: unknown, field: string, required = false): string => {
  if (v === undefined || v === null) { if (required) throw new ApiError(400, `${field} is required`); return ""; }
  if (typeof v !== "string") throw new ApiError(400, `${field} must be a string`);
  if (required && !v.trim()) throw new ApiError(400, `${field} is required`);
  return v;
};
/** A USD amount: a number, null/"" to clear, undefined to leave alone. */
const money = (v: unknown, field: string): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${field} must be an amount in USD`);
  return n;
};

/**
 * Decisions are for people. A run holds lofiwave's token (its hooks need it), so this can't stop a run that sets out
 * to cheat, but it refuses the honest path: a call that says which run it comes from can't answer an ask, write a
 * rule or change a budget.
 */
function personOnly(req: Request, what: string) {
  if (req.headers.get("x-lofiwave-run")) throw new ApiError(403, `${what} is for a person, not for a run. Raise an ask instead: lw ask "…"`);
}
/** Who a decision is recorded under: the signed-in person, the API key's name, or (the bare token) the configured owner. */
const decider = () => (isPerson() ? who() : who() === "api" ? setting("me") || "the console's owner (token)" : `${who()} (API key)`);

/** What the session list and a run's page show about a run, on top of the run record. */
export function runExtras(runId: number) {
  const pr = programmeRun(runId);
  const p = pr ? findProgramme(pr.programme_id) : null;
  const outcome = outcomeOf(runId);
  const open_asks = db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM asks WHERE run_id = ? AND status = 'open'").get(runId)!.n;
  if (!pr && !outcome && !open_asks) return null;
  return {
    programme: p ? { id: p.id, slug: p.slug, name: p.name } : null, worker: pr?.worker ?? "", role: pr?.role ?? "",
    outcome: outcome ?? null, open_asks, status_line: pr?.status_line ?? "", ...(pr ? { budget: budgetOf(runId) } : {}),
  };
}

/** The `lw` command on every run's PATH: a shim to scripts/lw.ts run by lofiwave's own bun. */
function installCli(): string {
  const dir = join(config.dataDir, "bin");
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "lw");
    writeFileSync(file, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(join(config.root, "scripts", "lw.ts"))} "$@"\n`);
    chmodSync(file, 0o755);
  } catch (e) { console.warn("[autopilot] could not install the lw command:", e); }
  return dir;
}

export function registerAutopilot({ route, json, body, runOut }: Helpers) {
  const binDir = installCli();
  runHooks.context = (meta, o) => {
    const env = { PATH: `${binDir}:${process.env.PATH ?? ""}` };
    if (!o.agent) return { instructions: "", env };
    const c = startContext(meta);
    return { instructions: c.instructions, env: { ...c.env, ...env } };
  };
  runHooks.started = (runId, meta) => {
    const p = findProgramme(meta.programme);
    if (p) attachRun(runId, p, { worker: meta.worker, role: meta.role, ...(typeof meta.budget_usd === "number" ? { budget_usd: meta.budget_usd } : {}) });
  };

  // ---- inbox: everything that needs a person, in one list
  route("GET", "/api/inbox", () => {
    const mine = namesOf(who());
    const open = db.query<AskRow, []>("SELECT * FROM asks WHERE status = 'open' ORDER BY created_at").all().map(askOut);
    const prompts = allRequests().map((r) => {
      const run = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(r.run_id);
      const x = runExtras(r.run_id);
      return { ...r, label: x?.worker || run?.workflow_name || `run ${r.run_id}`, programme: x?.programme ?? null };
    });
    // A run with a card of its own (a held prompt) isn't listed again as parked.
    const parked = stalls(60_000, 5 * 60_000).filter((s) => !prompts.some((p) => p.run_id === s.run_id));
    const items = listItems({ status: "open", limit: 500 }).filter((i) => i.kind !== "signal" && mine.includes(i.owner.toLowerCase()));
    const recent = db.query<AskRow, []>("SELECT * FROM asks WHERE status = 'answered' ORDER BY answered_at DESC LIMIT 25").all().map(askOut);
    return json({
      me: who(), asks: open, prompts, stalls: parked, items, recent,
      needs_you: open.length + prompts.length + parked.length,
      classes: KNOWN_CLASSES, never_auto: [...NEVER_AUTO], channels: notifyChannels(),
    });
  });

  // ---- asks
  route("GET", "/api/asks", (_r, _p, url) => {
    const where: string[] = [], args: any[] = [];
    const status = url.searchParams.get("status") ?? "open";
    if (status !== "all") { where.push("status = ?"); args.push(status); }
    const run = url.searchParams.get("run");
    if (run) { where.push("run_id = ?"); args.push(Number(run)); }
    const prog = url.searchParams.get("programme");
    if (prog) { where.push("programme_id = ?"); args.push(getProgramme(prog).id); }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
    return json(db.query<AskRow, any[]>(`SELECT * FROM asks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit).map(askOut));
  });
  route("POST", "/api/asks", async (req) => {
    const b = await body(req);
    const run = callerRun(req, b.run_id);
    const ask = createAsk(run, {
      title: str(b.title, "title", true), body: str(b.body, "body"), kind: b.kind === undefined ? undefined : str(b.kind, "kind"), class: b.class === undefined ? undefined : str(b.class, "class"),
      options: b.options, amount: money(b.amount, "amount") ?? null, for_person: str(b.for, "for"), programme: b.programme ? getProgramme(b.programme) : null,
    });
    return json(ask, 201);
  });
  route("GET", "/api/asks/:id", (_r, p) => json(askOut(getAsk(Number(p.id)))));
  route("GET", "/api/asks/:id/wait", async (req, p, url) => {
    const timeout = Math.min(Math.max(Number(url.searchParams.get("timeout") ?? 60) || 60, 1), 600);
    const { ask, reached } = await waitForAsk(Number(p.id), timeout * 1000, req.signal);
    return json({ ...askOut(ask), reached, timed_out: !reached });
  });
  route("POST", "/api/asks/:id/answer", async (req, p) => {
    personOnly(req, "Answering an ask");
    const b = await body(req);
    // Recorded under the person who decided, even when the request came with the token.
    return json(actor.run(decider(), () => answerAsk(getAsk(Number(p.id)), {
      option: str(b.option, "option") || undefined, text: str(b.text, "text"), always: Boolean(b.always), everywhere: Boolean(b.everywhere), max_amount: money(b.max_amount, "max_amount"),
    })));
  });
  route("POST", "/api/asks/:id/cancel", async (req, p) => json(cancelAsk(getAsk(Number(p.id)), str((await body(req)).why, "why"))));

  // ---- delegation rules: standing answers to a class of ask
  route("GET", "/api/policies", () => json(db.query<PolicyRow, []>("SELECT * FROM policies ORDER BY enabled DESC, id DESC").all().map(policyOut)));
  route("POST", "/api/policies", async (req) => {
    personOnly(req, "Making a delegation rule");
    const b = await body(req);
    return json(policyOut(createPolicy({ class: str(b.class, "class", true), answer: str(b.answer, "answer", true), programme_id: b.programme ? getProgramme(b.programme).id : null, max_amount: money(b.max_amount, "max_amount"), note: str(b.note, "note") })), 201);
  });
  route("PUT", "/api/policies/:id", async (req, p) => {
    personOnly(req, "Changing a delegation rule");
    const b = await body(req);
    return json(policyOut(updatePolicy(getPolicy(Number(p.id)), { enabled: b.enabled === undefined ? undefined : Boolean(b.enabled), max_amount: money(b.max_amount, "max_amount"), note: b.note === undefined ? undefined : str(b.note, "note") })));
  });
  route("DELETE", "/api/policies/:id", (req, p) => {
    personOnly(req, "Deleting a delegation rule");
    const pol = getPolicy(Number(p.id));
    db.prepare("DELETE FROM policies WHERE id = ?").run(pol.id);
    logEvent({ kind: "policy", programme_id: pol.programme_id, ref: `policy:${pol.id}`, text: `Rule #${pol.id} (${pol.class}) deleted` });
    return json({ ok: true });
  });

  // ---- rules and lessons: standing instructions for runs
  route("GET", "/api/rules", (_r, _p, url) => {
    const prog = url.searchParams.get("programme");
    return json(prog ? programmeRules(getProgramme(prog).id, false) : globalRules(false));
  });
  route("POST", "/api/rules", async (req) => {
    const b = await body(req);
    const kind = b.kind === "lesson" ? "lesson" : "rule";
    if (kind === "rule") personOnly(req, "Writing a rule");
    const run = callerRun(req, b.run_id);
    const programme = b.programme ? getProgramme(b.programme) : run ? programmeOfRun(run.id) : null;
    if (kind === "lesson" && !programme) throw new ApiError(400, "a lesson belongs to a programme");
    return json(addRule({ body: str(b.body, "body", true), title: str(b.title, "title"), programme, kind, applies: str(b.applies, "applies"), run_id: run?.id ?? null }), 201);
  });
  route("PUT", "/api/rules/:id", async (req, p) => {
    personOnly(req, "Changing a rule");
    const b = await body(req);
    return json(updateRule(getRule(Number(p.id)), { body: b.body === undefined ? undefined : str(b.body, "body"), title: b.title === undefined ? undefined : str(b.title, "title"), enabled: b.enabled === undefined ? undefined : Boolean(b.enabled), applies: b.applies === undefined ? undefined : str(b.applies, "applies") }));
  });
  route("DELETE", "/api/rules/:id", (req, p) => { personOnly(req, "Deleting a rule"); deleteRule(getRule(Number(p.id))); return json({ ok: true }); });

  // ---- guards
  route("GET", "/api/guards", () => json(listGuards().map((g) => ({ ...g, enabled: g.enabled === 1, builtin: g.builtin === 1 }))));
  route("POST", "/api/guards", async (req) => { personOnly(req, "Adding a guard"); return json(saveGuard(null, await body(req)), 201); });
  route("PUT", "/api/guards/:id", async (req, p) => { personOnly(req, "Changing a guard"); return json(saveGuard(getGuard(Number(p.id)), await body(req))); });
  route("DELETE", "/api/guards/:id", (req, p) => {
    personOnly(req, "Deleting a guard");
    const g = getGuard(Number(p.id));
    if (g.builtin) throw new ApiError(400, "a built-in guard can be turned off, not deleted");
    db.prepare("DELETE FROM guards WHERE id = ?").run(g.id);
    return json({ ok: true });
  });
  route("POST", "/api/hooks/pretool", async (req) => json(pretoolHook(req, await body(req))));

  // ---- programmes
  route("GET", "/api/programmes", () => json(db.query<any, []>("SELECT * FROM programmes ORDER BY status = 'active' DESC, updated_at DESC").all().map((p) => programmeOut(p))));
  route("POST", "/api/programmes", async (req) => {
    personOnly(req, "Creating a programme");
    const b = await body(req);
    return json(programmeOut(createProgramme({ name: str(b.name, "name", true), slug: str(b.slug, "slug"), goal: str(b.goal, "goal"), folder: str(b.folder, "folder"), brief: str(b.brief, "brief"), budget_usd: money(b.budget_usd, "budget_usd") ?? null }), true), 201);
  });
  route("GET", "/api/programmes/:ref", (_r, p) => json(programmeOut(getProgramme(p.ref), true)));
  route("PUT", "/api/programmes/:ref", async (req, p) => {
    personOnly(req, "Changing a programme");
    const b = await body(req);
    return json(programmeOut(updateProgramme(getProgramme(p.ref), { name: b.name, goal: b.goal, folder: b.folder, budget_usd: money(b.budget_usd, "budget_usd"), status: b.status }), true));
  });
  route("GET", "/api/programmes/:ref/context", (_r, p) => new Response(contextMarkdown(getProgramme(p.ref)), { headers: { "content-type": "text/markdown; charset=utf-8" } }));
  route("PUT", "/api/programmes/:ref/brief", async (req, p) => {
    personOnly(req, "Changing the standing brief");
    const b = await body(req);
    return json(programmeOut(setBrief(getProgramme(p.ref), str(b.body, "body", true), str(b.note, "note")), true));
  });
  route("GET", "/api/programmes/:ref/briefs/:version", (_r, p) => {
    const v = briefHistory(getProgramme(p.ref)).find((x) => x.version === Number(p.version));
    if (!v) throw new ApiError(404, `no version ${p.version}`);
    return json(v);
  });
  // The summary is the controller's to write (and a person's).
  route("PUT", "/api/programmes/:ref/summary", async (req, p) => { const prog = getProgramme(p.ref); setSummary(prog, str((await body(req)).text, "text", true)); return json(programmeOut(getProgramme(prog.id))); });
  route("POST", "/api/programmes/:ref/entries", async (req, p) => {
    const b = await body(req);
    const run = callerRun(req, b.run_id);
    const kind = str(b.kind, "kind", true);
    // A decision is a person's; a run records one by getting an ask answered.
    if (kind === "decision") personOnly(req, "Recording a decision");
    const pr = run ? programmeRun(run.id) : null;
    return json(addEntry(getProgramme(p.ref), { kind, key: str(b.key, "key"), title: str(b.title, "title"), body: str(b.body, "body"), value: b.value === undefined || b.value === null ? "" : String(b.value), path: str(b.path, "path"), run_id: run?.id ?? null, by: kind === "decision" ? decider() : pr?.worker || (run ? `run ${run.id}` : who()) }), 201);
  });
  route("GET", "/api/programmes/:ref/events", (_r, p, url) => json(eventsSince(Number(url.searchParams.get("since") ?? 0), { programme_id: getProgramme(p.ref).id, limit: 300 })));
  route("GET", "/api/programmes/:ref/digest", (_r, p, url) => json(digest(Number(url.searchParams.get("since") ?? now() - 86400_000), getProgramme(p.ref))));
  route("POST", "/api/programmes/:ref/controller", async (req, p) => {
    personOnly(req, "Setting up a controller");
    const b = await body(req);
    const wf = setController(getProgramme(p.ref), { schedule: str(b.schedule, "schedule"), type: str(b.type, "type"), cwd: str(b.cwd, "cwd"), enabled: b.enabled === undefined ? undefined : Boolean(b.enabled), extra_args: Array.isArray(b.extra_args) ? b.extra_args.map(String) : undefined });
    return json({ workflow_id: wf.id, name: wf.name, schedule: wf.schedule, next_run_at: wf.next_run_at }, 201);
  });

  /**
   * Start a worker of a programme: its own folder under the programme's (made if missing), its brief written there
   * as BRIEF.md, the programme's context in its system prompt, and its budget recorded. From a person, or from the
   * programme's controller.
   */
  route("POST", "/api/programmes/:ref/workers", async (req, p) => {
    const prog = getProgramme(p.ref);
    const b = await body(req);
    const worker = slugify(str(b.worker, "worker", true));
    if (!worker) throw new ApiError(400, "worker needs a name (letters and digits)");
    if (prog.status !== "active") throw new ApiError(409, `programme "${prog.slug}" is ${prog.status}`);
    const caller = callerRun(req, undefined);
    const typeName = str(b.type, "type") || "claude";
    const cwd = (str(b.cwd, "cwd").trim() || (prog.folder ? join(prog.folder, worker) : ""));
    if (!cwd) throw new ApiError(400, "the programme has no folder: set one, or pass cwd");
    const brief = str(b.brief, "brief");
    const budget = money(b.budget_usd, "budget_usd");
    const prompt = str(b.prompt, "prompt").trim() || (brief.trim() ? "Follow BRIEF.md in this folder. Run `lw context` first." : "");
    if (!prompt) throw new ApiError(400, "a worker needs a brief (written to BRIEF.md) or a prompt");
    const meta: Record<string, any> = { programme: prog.slug, worker, role: "worker", group: prog.slug };
    if (typeof budget === "number") meta.budget_usd = budget;
    if (caller) meta.parent_run = caller.id;
    const run = await startJob({
      typeName, cwd, meta, prompt, trigger: caller ? "api" : "manual",
      extraArgs: Array.isArray(b.extra_args) ? b.extra_args.map(String) : [],
      env: b.env && typeof b.env === "object" ? Object.fromEntries(Object.entries(b.env).map(([k, v]) => [k, String(v)])) : {},
      interactive: b.interactive === undefined ? getType(typeName).kind === "agent" && Boolean(tmuxPath()) : Boolean(b.interactive),
      // A worker stays up until it is stopped: it may be waiting for an answer, and its end is its report, not its idling.
      stopWhenIdle: false, terminal: "none", config: str(b.config, "config").trim() || undefined,
      timeoutSec: Number(b.timeout_sec) > 0 ? Math.floor(Number(b.timeout_sec)) : 0,
    }, {
      queue: b.queue === undefined ? true : Boolean(b.queue),
      prepare: () => {
        // A worker's folder may be made under the programme's own folder, wherever a person put that.
        if (!existsSync(cwd)) makeFolder(cwd, [...config.cwdRoots, ...(prog.folder ? [prog.folder] : [])]);
        if (brief.trim()) writeFiles(cwd, [{ path: "BRIEF.md", data: new TextEncoder().encode(brief.endsWith("\n") ? brief : brief + "\n") }]);
      },
    });
    attachRun(run.id, prog, { worker, role: "worker", ...(budget !== undefined ? { budget_usd: budget } : {}) });
    logEvent({ kind: "worker", programme_id: prog.id, run_id: run.id, text: `Worker ${worker} started${typeof budget === "number" ? ` with a budget of $${budget}` : ""}${caller ? ` by run ${caller.id}` : ""}` });
    return json({ ...runOut(getRun(run.id)), ...runExtras(run.id) }, run.status === "queued" ? 202 : 201);
  });

  // ---- what a run says about itself
  route("GET", "/api/runs/:id/autopilot", (_r, p) => json(runExtras(getRun(Number(p.id)).id) ?? {}));
  route("POST", "/api/runs/:id/outcome", async (req, p) => {
    const run = getRun(Number(p.id));
    const b = await body(req);
    const o = setOutcome(run, { outcome: str(b.outcome, "outcome", true), summary: str(b.summary, "summary"), report_path: str(b.report_path, "report_path") });
    // `stop`: end the session once it has had a moment to finish its turn (a done worker holds memory otherwise).
    if (b.stop && run.status === "running") setTimeout(() => killRun(run.id).catch(() => {}), 20_000);
    return json(o, 201);
  });
  route("POST", "/api/runs/:id/status", async (req, p) => { setStatusLine(getRun(Number(p.id)).id, str((await body(req)).text, "text", true)); return json({ ok: true }); });
  route("POST", "/api/runs/:id/spend", async (req, p) => {
    const b = await body(req);
    const amount = Number(b.amount_usd ?? b.amount);
    return json(addSpend(getRun(Number(p.id)), { bucket: str(b.bucket, "bucket"), amount_usd: amount, note: str(b.note, "note"), set: Boolean(b.total) }), 201);
  });
  route("GET", "/api/runs/:id/budget", (_r, p) => json(budgetOf(getRun(Number(p.id)).id)));
  route("PUT", "/api/runs/:id/budget", async (req, p) => {
    personOnly(req, "Changing a budget");
    const v = money((await body(req)).budget_usd, "budget_usd");
    setRunBudget(getRun(Number(p.id)).id, v ?? null, `set by ${decider()}`);
    return json(budgetOf(Number(p.id)));
  });

  // ---- the ledger: items and people
  route("GET", "/api/items", (_r, _p, url) => json(listItems({
    status: url.searchParams.get("status") ?? "open", owner: url.searchParams.get("owner") ?? undefined, kind: url.searchParams.get("kind") ?? undefined,
    programme_id: url.searchParams.get("programme") ? getProgramme(url.searchParams.get("programme")!).id : undefined, limit: Number(url.searchParams.get("limit") ?? 200) || 200,
  })));
  route("POST", "/api/items", async (req) => {
    const b = await body(req);
    const run = callerRun(req, b.run_id);
    const programme = b.programme ? getProgramme(b.programme) : run ? programmeOfRun(run.id) : null;
    const r = addItem({ ...b, programme_id: programme?.id ?? null, source: str(b.source, "source") || (run ? `run ${run.id}` : "") });
    return json({ ...itemOut(r.item), existed: r.existed }, r.existed ? 200 : 201);
  });
  route("GET", "/api/items/:id", (_r, p) => json(itemOut(getItem(Number(p.id)))));
  route("PUT", "/api/items/:id", async (req, p) => {
    const b = await body(req);
    return json(itemOut(updateItem(getItem(Number(p.id)), { ...b, programme_id: b.programme === undefined ? undefined : b.programme ? getProgramme(b.programme).id : null })));
  });
  route("GET", "/api/people", () => json(listPeople()));
  route("POST", "/api/people", async (req) => { personOnly(req, "Adding a person"); return json(savePerson(null, await body(req)), 201); });
  route("PUT", "/api/people/:id", async (req, p) => {
    personOnly(req, "Changing a person");
    const cur = db.query<PersonRow, [number]>("SELECT * FROM people WHERE id = ?").get(Number(p.id));
    if (!cur) throw new ApiError(404, `person ${p.id} not found`);
    return json(savePerson(cur, await body(req)));
  });
  route("DELETE", "/api/people/:id", (req, p) => { personOnly(req, "Removing a person"); db.prepare("DELETE FROM people WHERE id = ?").run(Number(p.id)); return json({ ok: true }); });

  // ---- settings, notifications, the digest, the log
  route("GET", "/api/autopilot/settings", () => json({ settings: settingsOut(), channels: notifyChannels(), sent: notifyLog() }));
  route("PUT", "/api/autopilot/settings", async (req) => { personOnly(req, "Changing settings"); saveSettings(await body(req)); return json({ settings: settingsOut(), channels: notifyChannels() }); });
  route("POST", "/api/autopilot/notify-test", async (req) => {
    personOnly(req, "Sending a test notification");
    if (!notifyChannels().length) throw new ApiError(400, "no notification channel is set up yet");
    await notify({ kind: "test", title: "lofiwave test notification", text: `Sent by ${decider()}. Asks, finished and blocked runs, and the digest arrive here.`, link: linkTo("inbox") });
    return json({ sent: notifyLog().slice(0, notifyChannels().length + 2) });
  });
  route("GET", "/api/digest", (_r, _p, url) => json(digest(Number(url.searchParams.get("since") ?? now() - 86400_000))));
  route("GET", "/api/events", (_r, _p, url) => {
    const prog = url.searchParams.get("programme");
    const rows: EventRow[] = eventsSince(Number(url.searchParams.get("since") ?? 0), { programme_id: prog ? getProgramme(prog).id : undefined, limit: Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1000) });
    return json(rows);
  });

  // ---- playbooks: ready-made unattended runs
  route("GET", "/api/playbooks", () => json(PLAYBOOKS.map(({ prompt: _p, ...x }) => x)));
  route("POST", "/api/playbooks/:name/workflow", async (req, p) => {
    personOnly(req, "Setting up a playbook");
    const b = await body(req);
    const wf = workflowFromPlaybook(p.name, { schedule: b.schedule === undefined ? undefined : str(b.schedule, "schedule"), type: str(b.type, "type"), cwd: str(b.cwd, "cwd"), programme: b.programme ? getProgramme(b.programme).slug : "", extra_args: Array.isArray(b.extra_args) ? b.extra_args.map(String) : undefined });
    return json({ workflow_id: wf.id, name: wf.name, schedule: wf.schedule, next_run_at: wf.next_run_at }, 201);
  });

  startAutopilot();
}
