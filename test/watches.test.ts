/**
 * Watches (src/watches.ts): a check's effect on a watch (progress, stalls, stall clearing, met, expired) and what the
 * Watching tab reads from a Claude transcript (background shells, agents, monitors, wakeups).
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lw-watches-"));
const { advance, watchText, feedTranscript, newTranscriptState, describeUntil } = await import("../src/watches");
type W = Parameters<typeof advance>[0];

const T0 = 1_800_000_000_000;
const MIN = 60_000;
function watch(over: Partial<W> = {}): W {
  return {
    id: 7, run_id: 3, label: "pose queue", until_kind: "cmd", until_arg: "./done.sh", progress_kind: "cmd", progress_arg: "./count.sh",
    every_sec: 60, stall_sec: 1800, expires_at: T0 + 24 * 60 * MIN, message: "check both hands, then build", status: "active", outcome: "",
    created_by: "", created_at: T0, next_check_at: T0, last_check_at: null, checks: 0, check_error: "", baseline: "", progress: "",
    progress_at: null, max_quiet_sec: 0, stalls: 0, stalled_at: null, pending: "", pending_at: null, delivered: 0, last_message_id: null, ended_at: null,
    ...over,
  };
}
/** Run checks one after another, carrying the watch's state forward like the loop does. */
function run(w: W, steps: [number, { met?: boolean; progress: string | null; output?: string; error?: string }][]) {
  const log: { at: number; kind: string; detail: any }[] = [];
  const fires: { at: number; reason: string; text: string }[] = [];
  for (const [at, r] of steps) {
    const res = advance(w, { met: r.met ?? false, progress: r.progress, output: r.output, error: r.error }, at);
    w = { ...w, ...res.set } as W;
    for (const e of res.events) log.push({ at, ...e, detail: e.detail ?? {} });
    if (res.fire) fires.push({ at, ...res.fire });
  }
  return { w, log, fires };
}

test("first reading sets the baseline; a change logs how long it was quiet", () => {
  const { w, log, fires } = run(watch(), [[T0 + MIN, { progress: "10/123" }], [T0 + 5 * MIN, { progress: "10/123" }], [T0 + 9 * MIN, { progress: "14/123" }]]);
  expect(fires).toEqual([]);
  expect(log.map((e) => e.kind)).toEqual(["progress", "progress"]);
  expect(log[1].detail).toMatchObject({ value: "14/123", quiet_sec: 480 });
  expect(w).toMatchObject({ checks: 3, progress: "14/123", progress_at: T0 + 9 * MIN, max_quiet_sec: 480, next_check_at: T0 + 10 * MIN });
});

test("a stall fires once, stays open, and clearing it logs how long it lasted", () => {
  const steps: [number, any][] = [[T0, { progress: "116/123" }]];
  for (let m = 10; m <= 60; m += 10) steps.push([T0 + m * MIN, { progress: "116/123" }]);
  steps.push([T0 + 75 * MIN, { progress: "117/123" }]);
  const { w, log, fires } = run(watch(), steps);
  expect(fires.map((f) => [f.at, f.reason])).toEqual([[T0 + 30 * MIN, "stalled"]]);
  expect(fires[0].text).toContain("[lofiwave watch #7 \"pose queue\"] Stalled: the progress reading hasn't changed for 30m (last: \"116/123\")");
  expect(fires[0].text).toContain("`lw watch rm 7`");
  const stall = log.find((e) => e.kind === "stall")!;
  expect(stall.detail).toMatchObject({ quiet_sec: 1800, stall_sec: 1800, nth: 1 });
  const cleared = log.find((e) => e.kind === "stall_cleared")!;
  expect(cleared.detail).toEqual({ stalled_for_sec: 45 * 60, quiet_sec: 75 * 60, stall_sec: 1800 });
  expect(w).toMatchObject({ stalls: 1, stalled_at: null, status: "active", max_quiet_sec: 75 * 60 });
});

test("after a stall clears, a second stall can fire", () => {
  const { fires, w } = run(watch({ stall_sec: 600 }), [
    [T0, { progress: "a" }], [T0 + 10 * MIN, { progress: "a" }], [T0 + 12 * MIN, { progress: "b" }], [T0 + 22 * MIN, { progress: "b" }],
  ]);
  expect(fires.map((f) => f.reason)).toEqual(["stalled", "stalled"]);
  expect(w.stalls).toBe(2);
});

test("a failed progress reading neither moves nor stalls the watch, and logs its error once", () => {
  const { log, fires, w } = run(watch({ stall_sec: 600 }), [
    [T0, { progress: "a" }], [T0 + 5 * MIN, { progress: null, error: "exited 1" }], [T0 + 15 * MIN, { progress: null, error: "exited 1" }],
  ]);
  expect(fires).toEqual([]);
  expect(log.filter((e) => e.kind === "check_error")).toHaveLength(1);
  expect(w.check_error).toBe("exited 1");
});

test("met: the watch is done, the event has the numbers to judge stall detection, the text has the output and the agent's note", () => {
  const { w, log, fires } = run(watch(), [[T0, { progress: "1" }], [T0 + 20 * MIN, { progress: "1" }], [T0 + 25 * MIN, { met: true, progress: "2", output: "build ok\n" }]]);
  expect(w).toMatchObject({ status: "delivering", outcome: "met", ended_at: T0 + 25 * MIN });
  expect(log.at(-1)).toMatchObject({ kind: "met", detail: { checks: 3, age_sec: 1500, stalls: 0, max_quiet_sec: 1500, stall_sec: 1800, open_stall: false } });
  expect(fires).toHaveLength(1);
  expect(fires[0].text).toBe("[lofiwave watch #7 \"pose queue\"] Done: `./done.sh` succeeds (watched for 25m).\n\nOutput:\nbuild ok\n\ncheck both hands, then build");
});

test("expired: told once, with the last progress", () => {
  const { w, fires } = run(watch({ expires_at: T0 + 60 * MIN, stall_sec: 0 }), [[T0, { progress: "3 left" }], [T0 + 61 * MIN, { progress: "3 left" }]]);
  expect(w.outcome).toBe("expired");
  expect(fires[0].text).toContain("Expired after 61m without this happening: `./done.sh` succeeds. Last progress: \"3 left\".");
});

test("describeUntil and fired-by-hand text", () => {
  expect(describeUntil({ until_kind: "exit", until_arg: "4242", baseline: "" })).toBe("process 4242 exits");
  expect(describeUntil({ until_kind: "file", until_arg: "/x/out.json", baseline: "" })).toBe("/x/out.json appears");
  expect(describeUntil({ until_kind: "file", until_arg: "/x/out.json", baseline: "3:4" })).toBe("/x/out.json changes");
  expect(describeUntil({ until_kind: "run", until_arg: "21:idle", baseline: "" })).toBe("run 21 finishes its turn");
  expect(describeUntil({ until_kind: "run", until_arg: "21:done", baseline: "" })).toBe("run 21 ends");
  expect(watchText(watch({ message: "" }), "fired", T0 + MIN)).toBe("[lofiwave watch #7 \"pose queue\"] Fired by hand before: `./done.sh` succeeds.");
});

// ---------------------------------------------------------------- transcripts

const ts = (min: number) => new Date(T0 + min * MIN).toISOString();
const toolUse = (min: number, id: string, name: string, input: any) => ({ type: "assistant", timestamp: ts(min), message: { content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (min: number, id: string, content: any) => ({ type: "user", timestamp: ts(min), message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const said = (min: number, text: string, extra: any = {}) => ({ type: "assistant", timestamp: ts(min), ...extra, message: { content: [{ type: "text", text }] } });
const prompt = (min: number, text: string) => ({ type: "user", timestamp: ts(min), message: { role: "user", content: text } });

test("background shells, agents and monitors, and the notices that end them", () => {
  const st = newTranscriptState();
  feedTranscript(st, [
    prompt(0, "build it"),
    toolUse(1, "tu1", "Bash", { command: "./watch_pose.sh", description: "Watch pose queue until it drains", run_in_background: true }),
    toolResult(1, "tu1", "Command running in background with ID: b7der549z. Output is being written to: /tmp/claude-1003/-home-agent/s1/tasks/b7der549z.output. You will be notified when it completes"),
    toolUse(2, "tu2", "Bash", { command: "make sheets", description: "Build sheets" }),
    toolResult(12, "tu2", "Command did not complete within its 600s timeout and was moved to the background (ID: b6swu72et). Output is being written to: /tmp/claude-1003/-home-agent/s1/tasks/b6swu72et.output"),
    toolUse(13, "tu3", "Agent", { description: "Review sheets", prompt: "…", run_in_background: true }),
    toolResult(13, "tu3", [{ type: "text", text: "Async agent launched successfully. (internal)\nagentId: a46774c9851f8d5f1 (internal ID)" }]),
    toolUse(14, "tu4", "Monitor", { description: "caption progress", command: "tail -f x" }),
    toolResult(14, "tu4", "Monitor started (task b30z2w0hg, expires in 30m unless the source ends first; you get one notice at expiry)"),
    toolUse(15, "tu5", "Bash", { command: "ls", description: "List" }),
    toolResult(15, "tu5", "a\nb"),
    { type: "user", timestamp: ts(40), message: { content: "<task-notification>\n<task-id>b6swu72et</task-id>\n<tool-use-id>tu2</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" } },
    toolUse(41, "tu6", "TaskStop", { task_id: "b30z2w0hg" }),
    toolResult(41, "tu6", JSON.stringify({ message: "Successfully stopped task: b30z2w0hg (tail -f x)", task_id: "b30z2w0hg" })),
  ]);
  const tasks = Object.fromEntries([...st.tasks.values()].map((t) => [t.id, t]));
  expect(Object.keys(tasks).sort()).toEqual(["a46774c9851f8d5f1", "b30z2w0hg", "b6swu72et", "b7der549z"]);
  expect(tasks.b7der549z).toMatchObject({ kind: "shell", description: "Watch pose queue until it drains", output_file: "/tmp/claude-1003/-home-agent/s1/tasks/b7der549z.output", ended_at: null });
  expect(tasks.b6swu72et).toMatchObject({ kind: "shell", description: "Build sheets", started_at: T0 + 2 * MIN, end_status: "completed", ended_at: T0 + 40 * MIN });
  expect(tasks.a46774c9851f8d5f1).toMatchObject({ kind: "agent", description: "Review sheets", ended_at: null });
  expect(tasks.b30z2w0hg).toMatchObject({ kind: "monitor", expires_at: T0 + 44 * MIN, end_status: "stopped" });
  expect(st.pending.size).toBe(0);
  // A task notification is not something the person said.
  expect(st.lastPrompt).toMatchObject({ text: "build it" });
});

test("a wakeup is seen once a turn starts around its time, and the last words are kept", () => {
  const st = newTranscriptState();
  feedTranscript(st, [
    prompt(0, "status?"),
    toolUse(1, "w1", "ScheduleWakeup", { delaySeconds: 1200, reason: "check sheets", prompt: "/loop check" }),
    toolResult(1, "w1", "scheduled"),
    said(2, "Sheets are building. I'll report when they finish."),
  ]);
  expect(st.wake).toMatchObject({ wake_at: T0 + 21 * MIN, reason: "check sheets", seen: false });
  expect(st.lastSaid).toMatchObject({ text: "Sheets are building. I'll report when they finish.", api_error: false });
  feedTranscript(st, [prompt(5, "and the pose?")]);
  expect(st.wake!.seen).toBe(false);
  feedTranscript(st, [prompt(21, "/loop check"), said(22, "API Error: 529 Overloaded", { isApiErrorMessage: true })]);
  expect(st.wake!.seen).toBe(true);
  expect(st.lastSaid).toMatchObject({ api_error: true });
});

test("a notice handed to a running turn (queued_command) ends its task; a command's output quoting those words is no task", () => {
  const st = newTranscriptState();
  feedTranscript(st, [
    toolUse(1, "s1", "Bash", { command: "bun run src/server.ts", description: "Start a test server", run_in_background: true }),
    toolResult(1, "s1", "Command running in background with ID: byfu5ywif. Output is being written to: /tmp/t/tasks/byfu5ywif.output. You will be notified"),
    toolUse(2, "s2", "Bash", { command: "grep -h background other.jsonl", description: "Read another transcript" }),
    toolResult(2, "s2", "Bash => Command running in background with ID: bgsowqmyk. Output is being written to: /tmp/x/tasks/bgsowqmyk.output."),
    { type: "attachment", timestamp: ts(3), attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<task-id>byfu5ywif</task-id>\n<status>completed</status>\n</task-notification>" } },
  ]);
  expect([...st.tasks.keys()]).toEqual(["byfu5ywif"]);
  expect(st.tasks.get("byfu5ywif")).toMatchObject({ end_status: "completed", ended_at: T0 + 3 * MIN });
});

test("promises to report back, and plain answers", () => {
  const { PROMISE } = require("../src/watches");
  for (const t of [
    "Waiting for the blur test file to finish, then I'll commit and push.",
    "The canary's full-decode check is still running; I'll report when it's done.",
    "I'll check its progress at your next status request.",
    "Delivery 15 is building and the watcher is running. I'll verify the result once it reaches a terminal state.",
    "Once CI passes I'll merge it.",
  ]) expect(PROMISE.test(t)).toBe(true);
  for (const t of ["Done: all 123 clips are built and verified.", "PR #12 is merged; nothing is waiting on you."]) expect(PROMISE.test(t)).toBe(false);
});
