#!/usr/bin/env bun
/**
 * `lw`: how a run under lofiwave reaches people and records what must outlive it. On every run's PATH (a shim in
 * DATA_DIR/bin); it talks to the console that started the run, using the run's own environment.
 */
import { readFileSync } from "node:fs";

const URL_ = (process.env.AGENT_CONSOLE_URL || "http://127.0.0.1:7770").replace(/\/+$/, "");
const TOKEN = process.env.AGENT_CONSOLE_TOKEN || "";
const RUN = process.env.AGENT_CONSOLE_RUN_ID || "";
const PROGRAMME = process.env.LOFIWAVE_PROGRAMME || "";

const HELP = `lw: reach people and record state from a run under lofiwave

Asking a person
  lw ask "<question>" [--body <text> | --body-file <f>] [--option "A: ..."]... [--approval]
         [--class <class>] [--amount <usd>] [--for <person>] [--wait [seconds]]
      Options: "id: label", * after the one you recommend ("B*: ..."). --approval = Approve / Don't.
      --amount makes it a budget ask (the new cap). Without --wait the answer arrives later as a message
      starting "[lofiwave] Answer to ask #N".
  lw asks                     your asks and what became of them
  lw cancel <ask> [why]       withdraw an ask

Saying what became of this run
  lw done "<summary>" [--report <path>] [--stop]
  lw blocked "<what is in the way>"        lw failed "<why>"
  lw status "<one line>"                   what you are doing now

In a programme
  lw context                  the brief, rules, decisions, figures, outputs and lessons as they stand
  lw programme                every worker: state, status line, outcome, spend, open asks
  lw spend <bucket> <usd> [--total] [--note <text>]     log spend (--total: the bucket's running total)
  lw budget                   spent against your cap
  lw publish <key> [--version <v>] [--path <where>] [--note <what it is>]
  lw figure <key> <value> [--note <measured on what>]
  lw lesson "<what the next worker should know>"
  lw summary "<text>" | -f <file>          where the programme stands (the controller's job)
  lw start <worker> --brief <file> [--budget <usd>] [--prompt <text>] [--type claude] [--cwd <dir>]

Other runs
  lw runs [--ended 2d]        lw results <run>        lw log <run> [--lines 80]
  lw message <run> "<text>"   lw stop <run>

The ledger
  lw items [--status open|done|all] [--kind <k>] [--owner <who>]
  lw item add "<title>" [--kind do|decide|verify|risk|signal] [--owner <who>] [--due <date|3d>]
              [--priority high|med|low] [--body <text>] [--source <link>] [--source-key <id>]
  lw item done <id> [--note <text>]     lw item drop <id> [--note <text>]     lw item note <id> "<text>"
  lw people
`;

function die(msg: string, code = 1): never { console.error(`lw: ${msg}`); process.exit(code); }

/** Flags after the positionals. `multi`: flags that may repeat; `bools`: flags without a value. */
function parse(argv: string[], bools: string[] = [], multi: string[] = []) {
  const pos: string[] = [], flags: Record<string, string> = {}, lists: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-" || /^-\d/.test(a)) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = (eq > 0 ? a.slice(0, eq) : a).replace(/^--?/, "");
    if (bools.includes(name)) {
      // --wait may take a number of seconds
      const next = argv[i + 1];
      if (name === "wait" && next && /^\d+$/.test(next)) { flags[name] = next; i++; } else flags[name] = "1";
      continue;
    }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) die(`--${name} needs a value`);
    if (multi.includes(name)) (lists[name] ??= []).push(value); else flags[name] = value;
  }
  return { pos, flags, lists };
}

async function call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  if (!TOKEN) die("not inside a lofiwave run (AGENT_CONSOLE_TOKEN is not set)");
  let res: Response;
  try {
    res = await fetch(`${URL_}/api${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(RUN ? { "x-lofiwave-run": RUN } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) { die(`can't reach lofiwave at ${URL_}: ${e?.message ?? e}`); }
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* markdown or plain text */ }
  if (!res.ok) die(typeof data === "object" && data?.error ? data.error : `${res.status} ${text.slice(0, 300)}`);
  return data;
}
const needRun = () => RUN || die("this needs to run inside a lofiwave run (AGENT_CONSOLE_RUN_ID is not set)");
const needProgramme = (flag?: string) => flag || PROGRAMME || die("this run is not part of a programme (pass --programme <slug>)");
const readText = (f: string) => { try { return readFileSync(f === "-" ? 0 : f, "utf8"); } catch (e: any) { die(`can't read ${f}: ${e.message}`); } };
const money = (n: number | null | undefined) => (n === null || n === undefined ? "no cap" : `$${Number(n).toFixed(2).replace(/\.00$/, "")}`);
const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

function showAnswer(a: any) {
  if (a.status === "cancelled") return console.log(`ask #${a.id} was withdrawn${a.answer_text ? `: ${a.answer_text}` : ""}`);
  const by = a.answered_via === "rule" ? `rule #${a.policy_id}, set by ${a.answered_by}` : a.answered_by;
  console.log(`ask #${a.id} answered by ${by}: ${[a.answer_option ? `${a.answer_option} (${a.answer_label})` : "", a.answer_text].filter(Boolean).join(". ")}`);
}

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h":
      return console.log(HELP);

    case "ask": {
      const { pos, flags, lists } = parse(rest, ["approval", "wait"], ["option"]);
      const title = pos.join(" ").trim() || die('what is the question? lw ask "<question>" --option "A: ..." --option "B*: ..."');
      const a = await call("POST", "/asks", {
        title, body: flags["body-file"] ? readText(flags["body-file"]) : flags.body ?? "", options: lists.option ?? [],
        kind: flags.amount ? "budget" : flags.approval ? "approval" : flags.kind, class: flags.class,
        amount: flags.amount === undefined ? undefined : Number(flags.amount), for: flags.for ?? "", programme: flags.programme,
      });
      if (a.status === "answered") return showAnswer(a);
      if (!flags.wait) return console.log(`ask #${a.id} raised${a.for_person ? ` for ${a.for_person}` : ""}. Carry on with what doesn't depend on it; the answer will arrive as a message starting "[lofiwave] Answer to ask #${a.id}".`);
      // Block until it is answered: long-polls in turns, so the wait can be any length.
      const until = Date.now() + (flags.wait === "1" ? 6 * 3600 : Number(flags.wait)) * 1000;
      for (;;) {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) return console.log(`ask #${a.id} is still open after waiting. It stays open; the answer will arrive as a message.`);
        const w = await call("GET", `/asks/${a.id}/wait?timeout=${Math.min(left, 300)}`, undefined, 330_000);
        if (w.reached) return showAnswer(w);
      }
    }
    case "asks": {
      const list = await call("GET", `/asks?status=all&run=${needRun()}`);
      if (!list.length) return console.log("no asks from this run");
      for (const a of list) console.log(`#${a.id} ${a.status.padEnd(9)} ${a.title}${a.status === "answered" ? ` → ${[a.answer_label, a.answer_text].filter(Boolean).join(". ")} (${a.answered_via === "rule" ? `rule #${a.policy_id}` : a.answered_by})` : ""}`);
      return;
    }
    case "cancel": {
      const [id, ...why] = rest;
      await call("POST", `/asks/${Number(id) || die("which ask? lw cancel <id>")}/cancel`, { why: why.join(" ") });
      return console.log(`ask #${id} withdrawn`);
    }

    case "done": case "blocked": case "failed": {
      const { pos, flags } = parse(rest, ["stop"]);
      const summary = pos.join(" ").trim() || die(`say what ${cmd === "done" ? "was done" : "is in the way"}: lw ${cmd} "<summary>"`);
      await call("POST", `/runs/${needRun()}/outcome`, { outcome: cmd, summary, report_path: flags.report ?? "", stop: Boolean(flags.stop) });
      return console.log(cmd === "done" ? "recorded as done; people have been told." : cmd === "blocked" ? "recorded as blocked; people have been told. If a person has to decide something, raise it with lw ask as well." : "recorded as failed; people have been told.");
    }
    case "status":
      await call("POST", `/runs/${needRun()}/status`, { text: rest.join(" ").trim() || die('lw status "<one line>"') });
      return console.log("ok");

    case "context": {
      const { flags } = parse(rest);
      return process.stdout.write(await call("GET", `/programmes/${needProgramme(flags.programme)}/context`));
    }
    case "programme": {
      const { flags } = parse(rest);
      const p = await call("GET", `/programmes/${needProgramme(flags.programme)}`);
      console.log(`${p.name} (${p.slug}): ${p.status}; ${money(p.spent)} spent of ${money(p.budget_usd)}; brief v${p.brief_version}; ${p.open_asks} open ask${p.open_asks === 1 ? "" : "s"}`);
      if (p.summary) console.log(`\nSummary (${p.summary_at ? ago(p.summary_at) + " ago" : "undated"}):\n${p.summary}`);
      console.log("\nWorkers:");
      for (const w of p.workers) {
        console.log(`  run ${w.run_id} ${(w.worker || "-").padEnd(18)} ${w.state.padEnd(10)} ${money(w.spent)}/${money(w.budget_usd)}${w.role === "controller" ? " (controller)" : ""}${w.brief_current ? "" : ` [brief v${w.brief_seen}]`}`);
        const line = w.outcome ? `${w.outcome.outcome}: ${w.outcome.summary}${w.outcome.report_path ? ` (report: ${w.outcome.report_path})` : ""}` : w.status_line;
        if (line) console.log(`      ${line.replace(/\n/g, " ").slice(0, 300)}`);
        if (w.open_asks) console.log(`      ${w.open_asks} open ask${w.open_asks === 1 ? "" : "s"}`);
      }
      return;
    }
    case "spend": {
      const { pos, flags } = parse(rest, ["total"]);
      const [bucket, amount] = pos;
      if (!bucket || amount === undefined || !Number.isFinite(Number(amount))) die("lw spend <bucket> <usd> [--total] [--note <text>]");
      const b = await call("POST", `/runs/${needRun()}/spend`, { bucket, amount_usd: Number(amount), total: Boolean(flags.total), note: flags.note ?? "" });
      console.log(`spent ${money(b.spent)} of ${money(b.budget_usd)}${b.programme_budget_usd !== null ? `; programme ${money(b.programme_spent)} of ${money(b.programme_budget_usd)}` : ""}`);
      if (b.over) console.log('OVER BUDGET: commands that start machines are refused until the cap is raised. lw ask "<why more is needed>" --class budget --amount <new cap>');
      else if (b.near) console.log('Past 80% of the cap: ask before spending more. lw ask "<why more is needed>" --class budget --amount <new cap>');
      return;
    }
    case "budget": {
      const b = await call("GET", `/runs/${needRun()}/budget`);
      return console.log(`spent ${money(b.spent)} of ${money(b.budget_usd)}${b.programme_budget_usd !== null ? `; programme ${money(b.programme_spent)} of ${money(b.programme_budget_usd)}` : ""}${b.over ? " (over)" : b.near ? " (past 80%)" : ""}`);
    }
    case "publish": case "figure": {
      const { pos, flags } = parse(rest);
      const [key, value] = pos;
      if (!key || (cmd === "figure" && value === undefined)) die(cmd === "figure" ? "lw figure <key> <value> [--note <measured on what>]" : "lw publish <key> [--version <v>] [--path <where>] [--note <what it is>]");
      await call("POST", `/programmes/${needProgramme(flags.programme)}/entries`, { kind: cmd === "figure" ? "figure" : "output", key, value: cmd === "figure" ? value : flags.version ?? "", path: flags.path ?? "", body: flags.note ?? "" });
      return console.log(cmd === "figure" ? `recorded ${key} = ${value}; earlier values of ${key} are superseded` : `published ${key}${flags.version ? ` ${flags.version}` : ""}`);
    }
    case "lesson": {
      const { pos, flags } = parse(rest);
      await call("POST", "/rules", { kind: "lesson", body: pos.join(" ").trim() || die('lw lesson "<what the next worker should know>"'), programme: needProgramme(flags.programme) });
      return console.log("recorded; workers of this programme are told, and later ones get it at start");
    }
    case "summary": {
      const { pos, flags } = parse(rest);
      const text = flags.f ? readText(flags.f) : pos.join(" ");
      await call("PUT", `/programmes/${needProgramme(flags.programme)}/summary`, { text: text.trim() || die('lw summary "<text>" | -f <file>') });
      return console.log("summary updated");
    }
    case "start": {
      const { pos, flags } = parse(rest);
      const worker = pos[0] || die("lw start <worker> --brief <file> [--budget <usd>]");
      const r = await call("POST", `/programmes/${needProgramme(flags.programme)}/workers`, {
        worker, brief: flags.brief ? readText(flags.brief) : "", prompt: flags.prompt ?? "", type: flags.type ?? "", cwd: flags.cwd ?? "",
        budget_usd: flags.budget === undefined ? undefined : Number(flags.budget), config: flags.config ?? "",
      });
      return console.log(`worker ${worker} is run ${r.id} (${r.status}) in ${r.cwd}`);
    }

    case "runs": {
      const { flags } = parse(rest);
      const d = await call("GET", "/runs?limit=100");
      const m = /^(\d+)([hd])$/.exec(flags.ended ?? "");
      const since = m ? Date.now() - Number(m[1]) * (m[2] === "h" ? 3600_000 : 86400_000) : 0;
      for (const r of d.runs) {
        if (flags.ended ? !(r.ended_at && r.ended_at >= since) : r.status !== "running" && r.status !== "queued") continue;
        const x = r.autopilot;
        console.log(`run ${r.id} ${r.status.padEnd(8)} ${(x?.worker || r.workflow_name || r.type_name).padEnd(20)} ${x?.programme ? `[${x.programme.slug}] ` : ""}${x?.outcome ? `${x.outcome.outcome}: ${x.outcome.summary.slice(0, 120)}` : r.status === "running" ? r.activity : "no outcome reported"}  ${r.cwd}`);
      }
      return;
    }
    case "results": {
      const id = Number(rest[0]) || die("lw results <run>");
      const [res, x] = await Promise.all([call("GET", `/runs/${id}/results`), call("GET", `/runs/${id}/autopilot`)]);
      if (x.outcome) console.log(`outcome: ${x.outcome.outcome}: ${x.outcome.summary}${x.outcome.report_path ? `\nreport: ${x.outcome.report_path}` : ""}\n`);
      console.log(`out dir: ${res.out_dir}${res.exists ? "" : " (missing)"}`);
      for (const f of res.files ?? []) console.log(`  ${f.path}  ${f.size} bytes`);
      return;
    }
    case "log": {
      const { pos, flags } = parse(rest);
      const id = Number(pos[0]) || die("lw log <run> [--lines 80]");
      const r = await call("GET", `/runs/${id}`);
      const n = Number(flags.lines ?? 80);
      if (r.status === "running" && r.meta?.interactive) return console.log((await call("GET", `/runs/${id}/screen?lines=${n}`)).text);
      return console.log(String(r.output ?? "").split("\n").slice(-n).join("\n"));
    }
    case "message": {
      const [id, ...text] = rest;
      const r = await call("POST", `/runs/${Number(id) || die('lw message <run> "<text>"')}/message`, { text: text.join(" ").trim() || die("what is the message?") });
      return console.log(r.delivered === false ? "not delivered: the run's input box didn't take it" : r.queued ? "queued: it reads it when its turn ends" : "delivered");
    }
    case "stop":
      await call("POST", `/runs/${Number(rest[0]) || die("lw stop <run>")}/kill`);
      return console.log(`run ${rest[0]} stopped`);

    case "items": {
      const { flags } = parse(rest);
      const q = new URLSearchParams({ status: flags.status ?? "open", ...(flags.kind ? { kind: flags.kind } : {}), ...(flags.owner ? { owner: flags.owner } : {}), ...(flags.programme ? { programme: flags.programme } : {}) });
      const list = await call("GET", `/items?${q}`);
      if (!list.length) return console.log("no items");
      for (const i of list) console.log(`#${i.id} ${i.kind.padEnd(6)} ${(i.owner || "-").padEnd(10)} ${i.priority === "high" ? "! " : ""}${i.title}${i.due_at ? ` (due ${new Date(i.due_at).toISOString().slice(0, 10)}${i.overdue ? ", overdue" : ""})` : ""}${i.status !== "open" ? ` [${i.status}]` : ""}${i.source_key ? ` {${i.source_key}}` : ""}`);
      return;
    }
    case "item": {
      const [sub, ...args] = rest;
      if (sub === "add") {
        const { pos, flags } = parse(args);
        const i = await call("POST", "/items", { title: pos.join(" ").trim() || die('lw item add "<title>"'), kind: flags.kind, owner: flags.owner, due: flags.due, priority: flags.priority, body: flags.body, source: flags.source, source_key: flags["source-key"], programme: flags.programme });
        return console.log(i.existed ? `already tracked as item #${i.id}` : `item #${i.id} added`);
      }
      if (sub === "done" || sub === "drop") {
        const { pos, flags } = parse(args);
        await call("PUT", `/items/${Number(pos[0]) || die(`lw item ${sub} <id>`)}`, { status: sub === "done" ? "done" : "dropped", ...(flags.note ? { note: flags.note } : {}) });
        return console.log(`item #${pos[0]} ${sub === "done" ? "done" : "dropped"}`);
      }
      if (sub === "note") {
        const [id, ...text] = args;
        const cur = await call("GET", `/items/${Number(id) || die('lw item note <id> "<text>"')}`);
        await call("PUT", `/items/${id}`, { note: [cur.note, text.join(" ").trim()].filter(Boolean).join("\n") });
        return console.log("noted");
      }
      die("lw item add|done|drop|note … (lw help)");
    }
    case "people": {
      for (const p of await call("GET", "/people")) console.log(`${p.name}${p.login ? ` (signs in as ${p.login})` : ""}${p.notes ? `: ${p.notes}` : ""}`);
      return;
    }
    default:
      die(`unknown command "${cmd}" (lw help)`);
  }
}

await main();
