// End to end: a scratch lofiwave (its own data dir, HOME, port and tmux server) running a programme. Workers are
// shell scripts that use `lw` the way an agent would (an agent type whose prompt is the script), plus
// test/fake-claude/claude where a live interactive session is needed (messages typed into it, the PreToolUse hook).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-autopilot";
const FAKE = join(ROOT, "test", "fake-claude", "claude");

let tmp = "", base = "", work = "";
let server: Bun.Subprocess | null = null;
let hook: ReturnType<typeof Bun.serve> | null = null;
const notes: any[] = [];

const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* markdown */ }
  return { status: res.status, data };
};
const api = async (method: string, path: string, body?: any) => {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const finished = (id: number) => until(`run ${id} to end`, async () => { const r = await api("GET", `/runs/${id}`); return r.status === "running" || r.status === "queued" ? null : r; });
const openAsk = (runId: number) => until(`an ask from run ${runId}`, async () => (await api("GET", `/asks?status=open&run=${runId}`))[0]);
const worker = (name: string, script: string, extra: Record<string, any> = {}) =>
  api("POST", "/programmes/pose/workers", { worker: name, type: "script", prompt: script, interactive: false, ...extra });
const pretool = (runId: number, command: string) =>
  call("POST", "/hooks/pretool", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { "x-lofiwave-run": String(runId) });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lofiwave-ap-"));
  for (const d of ["home", "data", "tmux", "work"]) mkdirSync(join(tmp, d));
  work = join(tmp, "work");
  hook = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { notes.push({ ...(await req.json() as any), _path: new URL(req.url).pathname, _auth: req.headers.get("authorization") }); return Response.json({ ok: true }); } });
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.TMUX; delete env.TMUX_PANE;
  Object.assign(env, {
    HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: TOKEN,
    OPEN_TERMINAL: "none", PASSWORD: "", AUTOPILOT_INTERVAL_MS: "400", CONTROLLER_WAKE_DELAY_MS: "300", MAX_AGENT_RUNS: "0", MIN_FREE_MEM_MB: "0",
    NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/`, SLACK_API_URL: `http://127.0.0.1:${hook.port}/slack`, TELEGRAM_API_URL: `http://127.0.0.1:${hook.port}/tg`, PUBLIC_URL: "https://console.example", LOFIWAVE_ME: "lucas", FAKE_FIRST_TURN_MS: "300",
  });
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  await until("the server", () => api("GET", "/health"));
  // A worker whose prompt is its script, and a stand-in for claude's TUI.
  await api("POST", "/process-types", { name: "script", kind: "agent", command: "sh", args: ["-c", "{prompt}"] });
  await api("POST", "/process-types", { name: "fakeclaude", kind: "agent", command: FAKE, args: [], interactive_args: [] });
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  hook?.stop(true);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("a programme's context holds the global rules and the standing brief, and is written where workers read it", async () => {
  await api("POST", "/rules", { title: "Worktrees and PRs", body: "Work in a git worktree and publish work as a pull request." });
  const p = await api("POST", "/programmes", { name: "Pose", goal: "A better ranking model.", folder: work, brief: "Use the 2026 dataset only.\nNo writes to production.", budget_usd: 1000 });
  expect(p.slug).toBe("pose");
  expect(p.brief_version).toBe(1);
  const ctx = (await call("GET", "/programmes/pose/context")).data as string;
  expect(ctx).toContain("Worktrees and PRs: Work in a git worktree");
  expect(ctx).toContain("## Standing brief (v1)\nUse the 2026 dataset only.");
  expect(readFileSync(join(work, "PROGRAMME.md"), "utf8")).toBe(readFileSync(p.context_file, "utf8"));
  // A rule is a person's to write: a call that names the run it comes from is refused.
  expect((await call("POST", "/rules", { body: "anything goes" }, { "x-lofiwave-run": "1" })).status).toBe(403);
});

test("a worker asks, a person answers, and the answer, its author and what the worker recorded are all kept", async () => {
  const run = await worker("depth", [
    'test -f BRIEF.md && test "$LOFIWAVE_PROGRAMME" = pose && test "$LOFIWAVE_WORKER" = depth || exit 9',
    'lw context | grep -q "Use the 2026 dataset only" || exit 8',
    'lw status "scoring the depth pass"',
    "lw spend aws 30 --note 'one g5 for 20 min'",
    'lw figure eval_accuracy 0.9134 --note "dev split, 61 episodes"',
    'lw publish depthpass --version v1 --path shared/depth --note "depth post-pass"',
    'lw ask "Merge the depth pass (PR 505)?" --approval --class merge --body "CI is green." --wait 30 > answer.txt || exit 7',
    'lw done "Depth pass merged." --report out/REPORT.md',
  ].join("\n"), { brief: "# Depth\nScore the depth post-pass.", budget_usd: 100 });
  expect(run.autopilot.programme.slug).toBe("pose");
  const ask = await openAsk(run.id);
  expect(ask).toMatchObject({ kind: "approval", class: "merge", from: "depth", can_have_rule: true });
  expect(ask.options.map((o: any) => o.id)).toEqual(["approve", "deny"]);
  expect((await api("GET", "/inbox")).needs_you).toBeGreaterThanOrEqual(1);
  // The run itself can't answer it.
  expect((await call("POST", `/asks/${ask.id}/answer`, { option: "approve" }, { "x-lofiwave-run": String(run.id) })).status).toBe(403);
  const answered = await api("POST", `/asks/${ask.id}/answer`, { option: "approve", text: "go ahead" });
  expect(answered).toMatchObject({ status: "answered", answered_by: "lucas", answered_via: "person", answer_label: "Approve" });

  const done = await finished(run.id);
  expect(done.status).toBe("success");
  expect(readFileSync(join(work, "depth", "answer.txt"), "utf8")).toContain("answered by lucas: approve (Approve). go ahead");
  expect(done.autopilot.outcome).toMatchObject({ outcome: "done", summary: "Depth pass merged.", report_path: "out/REPORT.md" });

  const p = await api("GET", "/programmes/pose");
  const w = p.workers.find((x: any) => x.run_id === run.id);
  expect(w).toMatchObject({ worker: "depth", state: "done", spent: 30, budget_usd: 100, status_line: "scoring the depth pass" });
  expect(p.spent).toBe(30);
  expect(p.decisions[0]).toMatchObject({ title: "Merge the depth pass (PR 505)? → Approve. go ahead", by: "lucas", ask_id: ask.id });
  expect(p.figures[0]).toMatchObject({ key: "eval_accuracy", value: "0.9134", by: "depth" });
  expect(p.outputs[0]).toMatchObject({ key: "depthpass", value: "v1", path: "shared/depth" });
  const ctx = (await call("GET", "/programmes/pose/context")).data as string;
  expect(ctx).toContain("`eval_accuracy` = **0.9134**");
  expect(ctx).toMatch(/## Decisions[^\n]*\n- [^\n]*lucas: Merge the depth pass/);

  // People were told about the ask and about the end, with a link.
  await until("the notifications", async () => notes.some((n) => n.kind === "run_done") && notes.some((n) => n.kind === "ask"));
  expect(notes.find((n) => n.kind === "ask")).toMatchObject({ title: "depth needs you: Merge the depth pass (PR 505)?", link: `https://console.example/#inbox/ask/${ask.id}` });
  expect(notes.find((n) => n.kind === "run_done").title).toBe("Done: depth");
}, 40_000);

test("a figure recorded again supersedes the old one: one number stands", async () => {
  await api("POST", "/programmes/pose/entries", { kind: "figure", key: "eval_accuracy", value: 0.9051, body: "after the label fix" });
  const p = await api("GET", "/programmes/pose");
  const all = p.figures.filter((f: any) => f.key === "eval_accuracy");
  expect(all.map((f: any) => [f.value, f.superseded_by !== null])).toEqual([["0.9051", false], ["0.9134", true]]);
  const ctx = (await call("GET", "/programmes/pose/context")).data as string;
  expect(ctx).toContain("**0.9051**");
  expect(ctx).not.toContain("0.9134");
});

test("\"always do this\" makes a rule; the next ask of that class is answered by it, and that is logged", async () => {
  const first = await worker("identity", 'lw ask "Merge the front end?" --approval --class merge --wait 30 > a.txt; lw done "ok"');
  const ask = await openAsk(first.id);
  const a = await api("POST", `/asks/${ask.id}/answer`, { option: "approve", always: true });
  expect(a.policy).toMatchObject({ class: "merge", answer: "approve", created_by: "lucas", from_ask: ask.id });
  await finished(first.id);

  const second = await worker("models", 'lw ask "Merge the model ensemble?" --approval --class merge --wait 30 > a.txt; lw done "ok"');
  await finished(second.id);
  expect(readFileSync(join(work, "models", "a.txt"), "utf8")).toContain(`answered by rule #${a.policy.id}, set by lucas: approve`);
  const [auto] = await api("GET", `/asks?status=all&run=${second.id}`);
  expect(auto).toMatchObject({ status: "answered", answered_via: "rule", policy_id: a.policy.id, answered_by: "lucas" });
  const rule = (await api("GET", "/policies")).find((x: any) => x.id === a.policy.id);
  expect(rule.applied_count).toBe(1);
  expect(rule.recent[0].title).toBe("Merge the model ensemble?");
  expect((await api("GET", "/events?limit=50")).some((e: any) => e.kind === "auto_answer" && e.text.includes("Merge the model ensemble?"))).toBe(true);

  // Turned off, it stops answering.
  await api("PUT", `/policies/${a.policy.id}`, { enabled: false });
  const third = await worker("distill", 'lw ask "Merge the student?" --approval --class merge; lw done "asked"');
  await finished(third.id);
  expect((await openAsk(third.id)).status).toBe("open");
}, 40_000);

test("some classes can never have a rule, and a budget rule needs a ceiling", async () => {
  expect((await call("POST", "/policies", { class: "external_send", answer: "approve" })).data.error).toMatch(/always asked/);
  expect((await call("POST", "/policies", { class: "budget", answer: "approve" })).data.error).toMatch(/max_amount/);
  const r = await worker("sender", 'lw ask "Send the delivery email to the customer?" --approval --class external_send; lw done "asked"');
  await finished(r.id);
  const ask = await openAsk(r.id);
  expect(ask.can_have_rule).toBe(false);
  expect((await call("POST", `/asks/${ask.id}/answer`, { option: "approve", always: true })).status).toBe(400);
  expect((await api("GET", `/asks/${ask.id}`)).status).toBe("open");       // refused whole: nothing was recorded
  expect((await api("POST", `/asks/${ask.id}/answer`, { option: "approve" })).status).toBe("answered");
});

test("after three asks of a class got the same answer, a rule is offered", async () => {
  const answers = [];
  for (const n of [1, 2, 3]) {
    const a = await api("POST", "/asks", { title: `Shut down finished worker ${n}?`, kind: "approval", class: "shutdown", programme: "pose" });
    answers.push(await api("POST", `/asks/${a.id}/answer`, { option: "approve" }));
  }
  expect(answers.map((a) => Boolean(a.suggest_rule))).toEqual([false, false, true]);
  expect(answers[2].suggest_rule).toMatchObject({ class: "shutdown", answer: "approve", count: 3 });
});

test("a live session: the answer is typed into it, a changed brief reaches it, and guards refuse commands", async () => {
  const run = await api("POST", "/processes", { type: "fakeclaude", cwd: work, interactive: true, stop_when_idle: false, trust: false, programme: "pose", worker: "frontend", budget_usd: 100 });
  expect(run.autopilot).toMatchObject({ worker: "frontend", programme: { slug: "pose" } });
  const typed = async (needle: string) => until(`"${needle}" to be typed into run ${run.id}`, async () =>
    (await api("GET", `/runs/${run.id}/messages?limit=50`)).find((m: any) => m.text.includes(needle) && m.delivered !== false));

  // An ask raised for the run, with nobody blocked on it: the answer arrives as a message that says who gave it.
  const ask = await api("POST", "/asks", { run_id: run.id, title: "Use the new detector?", options: ["A: keep the old one", "B*: switch to the new one"] });
  expect(ask.options[1]).toMatchObject({ id: "B", recommended: true });
  await api("POST", `/asks/${ask.id}/answer`, { option: "B" });
  const m = await typed(`Answer to ask #${ask.id}`);
  expect(m.text).toBe(`[lofiwave] Answer to ask #${ask.id} “Use the new detector?”, from lucas: switch to the new one`);
  await until("the ask to be marked delivered", async () => (await api("GET", `/asks/${ask.id}`)).delivered === 1);

  // The brief changes while it runs: it is told what changed, and is then on the new version.
  await api("PUT", "/programmes/pose/brief", { body: "Use the 2026 dataset only.\nNo writes to production.\nDo not use the legacy shards.", note: "the legacy shards have label errors" });
  const b = await typed("The standing brief of programme");
  expect(b.text).toContain("(v1 → v2): the legacy shards have label errors");
  expect(b.text).toContain("+ Do not use the legacy shards.");
  await until("the worker to be on v2", async () => (await api("GET", "/programmes/pose")).workers.find((w: any) => w.run_id === run.id)?.brief_current);

  // A lesson another run records reaches it too.
  await api("POST", "/rules", { kind: "lesson", programme: "pose", body: "Sync results to S3 as you go: a spot reclaim then costs minutes." });
  expect((await typed("A lesson from another run")).text).toContain("Sync results to S3");

  // Guards: refused whatever the prompt says; a server of its own is fine.
  const deny = (await pretool(run.id, "tmux kill-server")).data.hookSpecificOutput;
  expect(deny).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  expect(deny.permissionDecisionReason).toContain("tmux-kill-server");
  expect((await pretool(run.id, "tmux -L mine kill-server")).data).toEqual({});
  expect((await pretool(run.id, "aws ec2 request-spot-fleet --spot-fleet-request-config file://f.json")).data.hookSpecificOutput.permissionDecision).toBe("deny");
  // Starting machines is allowed until the budget is spent, refused after, and allowed again once a person raises the cap.
  const launch = "aws ec2 run-instances --instance-type g5.xlarge";
  expect((await pretool(run.id, launch)).data).toEqual({});
  expect(await api("POST", `/runs/${run.id}/spend`, { bucket: "aws", amount: 85 })).toMatchObject({ spent: 85, near: true, over: false });
  expect(await api("POST", `/runs/${run.id}/spend`, { bucket: "aws", amount: 120, total: true })).toMatchObject({ spent: 120, over: true });
  expect((await pretool(run.id, launch)).data.hookSpecificOutput.permissionDecisionReason).toContain("reached its budget");
  const more = await api("POST", "/asks", { run_id: run.id, title: "Raise the frontend budget for the speed test", amount: 250 });
  expect(more).toMatchObject({ kind: "budget", class: "budget" });
  await api("POST", `/asks/${more.id}/answer`, { option: "approve" });
  expect(await api("GET", `/runs/${run.id}/budget`)).toMatchObject({ budget_usd: 250, over: false });
  expect((await pretool(run.id, launch)).data).toEqual({});
  expect((await api("GET", "/guards")).find((g: any) => g.name === "tmux-kill-server").hits).toBe(1);
  expect(notes.some((n) => n.kind === "budget" && n.title === "Over budget: frontend")).toBe(true);

  // Stopped without ever saying what became of it: that is logged as such.
  await api("POST", `/runs/${run.id}/kill`);
  await until("its end to be logged", async () => (await api("GET", "/programmes/pose/events")).some((e: any) => e.kind === "run_ended" && e.run_id === run.id && e.text.includes("without reporting an outcome")));
}, 60_000);

test("a controller is woken when a worker reports, and reads the programme from lofiwave", async () => {
  const c = await api("POST", "/programmes/pose/controller", { type: "script", cwd: work });
  expect(c.name).toBe("pose: controller");
  // The playbook is written for an agent; here the controller is a script doing one pass.
  const wf = await api("GET", `/workflows/${c.workflow_id}`);
  expect(wf.programme).toBe("pose");
  expect(wf.prompt).toContain("You are the controller of the lofiwave programme");
  await api("PUT", `/workflows/${c.workflow_id}`, { prompt: 'lw programme > controller-saw.txt && lw summary "Depth is merged; teacher is done; nothing is blocked." && lw done "one pass"' });

  const w = await worker("teacher", 'lw done "Labels frozen as v1."');
  await finished(w.id);
  const ctl = await until("the controller to run", async () => (await api("GET", `/runs?workflow_id=${c.workflow_id}`)).runs[0]);
  expect(ctl.trigger).toBe("event");
  const ended = await finished(ctl.id);
  if (!ended.autopilot?.outcome) console.log("controller run:", ended.status, ended.error, ended.output);
  expect(ended.autopilot).toMatchObject({ role: "controller", outcome: { outcome: "done", summary: "one pass" } });
  const saw = readFileSync(join(work, "controller-saw.txt"), "utf8");
  expect(saw).toMatch(/teacher\s+done/);
  expect(saw).toContain("done: Labels frozen as v1.");
  expect((await api("GET", "/programmes/pose")).summary).toBe("Depth is merged; teacher is done; nothing is blocked.");
  // Its own end doesn't start it again.
  await Bun.sleep(1500);
  expect((await api("GET", `/runs?workflow_id=${c.workflow_id}`)).total).toBe(1);
}, 40_000);

test("the ledger: an intake pass that reads the same message twice files it once; items show for their owner", async () => {
  await api("POST", "/people", { name: "Lucas", login: "lucas", slack_id: "U123" });
  const a = await api("POST", "/items", { title: "Send the customer the delivery date", owner: "Lucas", kind: "do", due: "2026-10-24", source_key: "slack:C1:1729" });
  const b = await api("POST", "/items", { title: "Send the customer the delivery date (again)", owner: "Lucas", source_key: "slack:C1:1729" });
  expect([a.existed, b.existed, b.id]).toEqual([false, true, a.id]);
  expect(a.overdue).toBe(true);
  await api("POST", "/items", { title: "Vendors want an hours-reconciliation page", kind: "signal", source_key: "slack:C2:1730" });
  const inbox = await api("GET", "/inbox");
  expect(inbox.items.map((i: any) => i.title)).toEqual(["Send the customer the delivery date"]);   // "lucas" (LOFIWAVE_ME) owns it; the signal isn't a to-do
  expect((await api("GET", "/items?kind=signal")).length).toBe(1);
  expect((await api("PUT", `/items/${a.id}`, { status: "done", note: "sent Oct 28" })).closed_at).toBeGreaterThan(0);
  expect((await call("POST", "/items", { title: "x", due: "someday" })).status).toBe(400);
});

test("with a Slack bot and a Telegram bot set up, an ask for a person goes to them directly and to the team's channels", async () => {
  await api("PUT", "/autopilot/settings", { slack_bot_token: "xoxb-test-token", slack_channel: "C-TEAM", telegram_bot_token: "42:tg", telegram_chat_id: "-100200" });
  expect((await api("GET", "/autopilot/settings")).channels).toEqual(["slack bot", "telegram", "webhook"]);
  const ask = await api("POST", "/asks", { title: "Which vendor pay option?", for: "Lucas", options: ["A: per accepted hour", "B: per delivered hour"], programme: "pose" });
  const slack = await until("the Slack messages", async () => { const m = notes.filter((n) => n._path === "/slack/chat.postMessage" && String(n.text).includes("Which vendor pay option?")); return m.length === 2 ? m : null; });
  expect(slack.map((m) => m.channel).sort()).toEqual(["C-TEAM", "U123"]);     // U123: Lucas's Slack id, from People
  expect(slack[0]._auth).toBe("Bearer xoxb-test-token");
  expect(slack[0].text).toContain(`<https://console.example/#inbox/ask/${ask.id}|Open in lofiwave>`);
  const tg = await until("the Telegram message", async () => notes.find((n) => n._path === "/tg/bot42:tg/sendMessage" && String(n.text).includes("Which vendor pay option?")));
  expect(tg.chat_id).toBe("-100200");
  expect(tg.text).toContain("• A: per accepted hour");
  const sent = (await api("POST", "/autopilot/notify-test")).sent;
  expect(sent.every((x: any) => x.ok)).toBe(true);
  await api("POST", `/asks/${ask.id}/cancel`, { why: "decided on a call" });
  await api("PUT", "/autopilot/settings", { slack_bot_token: "", slack_channel: "", telegram_bot_token: "", telegram_chat_id: "" });
});

test("the digest answers \"status?\": what is waiting, each worker's state, what rules answered and what was blocked", async () => {
  const d = await api("GET", "/digest?since=0");
  expect(d.text).toContain("Waiting on a person");
  expect(d.text).toContain("Merge the student?");
  expect(d.text).toMatch(/Pose: \$\d+ spent of \$1000/);
  expect(d.text).toContain("teacher: done. Labels frozen as v1.");
  expect(d.text).toContain("Answered by rules (1):");
  expect(d.text).toContain("Commands blocked");
  const one = await api("GET", "/programmes/pose/digest?since=0");
  expect(one.text).toContain("Depth is merged; teacher is done");
});

test("lw outside a programme still reaches people; settings list secrets masked", async () => {
  const r = await api("POST", "/processes", { type: "script", cwd: work, interactive: false, prompt: 'lw blocked "No access to the model weights."; lw context 2>err.txt; echo "exit=$?" >> err.txt' });
  const done = await finished(r.id);
  expect(done.autopilot.outcome).toMatchObject({ outcome: "blocked", summary: "No access to the model weights." });
  expect(readFileSync(join(work, "err.txt"), "utf8")).toContain("not part of a programme");
  expect(existsSync(join(tmp, "data", "bin", "lw"))).toBe(true);
  await api("PUT", "/autopilot/settings", { slack_webhook_url: "https://hooks.slack.example/services/T000/B000/abcdefghijklmnop", digest_cron: "0 9 * * *" });
  const s = (await api("GET", "/autopilot/settings")).settings;
  expect(s.find((x: any) => x.key === "slack_webhook_url").value).toBe("••••mnop");
  expect(JSON.stringify(s)).not.toContain("abcdefghijkl");
  expect((await call("PUT", "/autopilot/settings", { nope: "x" })).status).toBe(400);
});
