// The transcript scan behind GET /api/runs/:id/messages/:message_id, on lines shaped like Claude Code's own.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// src/messages imports the database, which opens DATA_DIR on load: point it somewhere empty first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lofiwave-msgtest-"));
const { newScan, feed } = await import("../src/messages");

const T0 = Date.parse("2026-10-23T19:42:56.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const enqueue = (s: number, content: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: at(s), content });
const dequeue = (s: number) => ({ type: "queue-operation", operation: "dequeue", timestamp: at(s) });
const remove = (s: number, content: string, reason: string) => ({ type: "queue-operation", operation: "remove", timestamp: at(s), content, reason });
const user = (s: number, promptId: string, content: any, extra = {}) => ({ type: "user", timestamp: at(s), promptId, isSidechain: false, message: { role: "user", content }, ...extra });
const said = (s: number, id: string, text: string, stop = "end_turn", extra = {}) => ({ type: "assistant", timestamp: at(s), isSidechain: false, message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: stop }, ...extra });
const thought = (s: number, id: string, stop = "end_turn") => ({ type: "assistant", timestamp: at(s), message: { id, content: [{ type: "thinking", thinking: "" }], stop_reason: stop } });
const tool = (s: number, id: string) => ({ type: "assistant", timestamp: at(s), message: { id, content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }], stop_reason: "tool_use" } });
const result = (s: number, promptId: string) => user(s, promptId, [{ type: "tool_result", tool_use_id: "t", content: "ok" }]);
const turnOver = (s: number) => ({ type: "system", subtype: "turn_duration", timestamp: at(s) });
const scan = (text: string, entries: any[]) => { const sc = newScan(text, T0); feed(sc, entries); return sc.fate; };

test("queued while busy, dequeued into its own turn, answered; later turns are not part of the reply", () => {
  const f = scan("is the fill done?", [
    enqueue(0, "is the fill done?"),
    tool(1, "m1"), result(2, "P0"),
    said(3, "m2", "monitor still running"), turnOver(3),     // the turn it was queued behind
    dequeue(4), user(4, "P1", "is the fill done?"),
    thought(5, "m3", "tool_use"), tool(5, "m3"), result(6, "P1"),
    thought(7, "m4"), said(7, "m4", "Yes: 1200 rows filled."), turnOver(7),
    enqueue(8, "<task-notification>t1</task-notification>"), dequeue(8), user(8, "P2", "<task-notification>t1</task-notification>"),
    said(9, "m5", "notification handled"),
  ]);
  expect(f.state).toBe("answered");
  expect(f.read_as).toBe("turn");
  expect(f.prompt_id).toBe("P1");
  expect(f.queued_at).toBe(T0);
  expect(f.read_at).toBe(T0 + 4000);
  expect(f.reply.messages.map((m) => m.text)).toEqual(["Yes: 1200 rows filled."]);
  expect(f.reply.at).toBe(T0 + 7000);
});

test("absorbed mid-turn: the reply is the rest of that turn", () => {
  const f = scan("also check the logs", [
    enqueue(0, "also check the logs"),
    { type: "attachment", timestamp: at(1), attachment: { type: "queued_command", prompt: "also check the logs" } },
    remove(1, "also check the logs", "absorbed_mid_turn"),
    said(2, "m1", "Logs are clean.", "tool_use"), tool(2, "m1"), result(3, "P0"),
    said(4, "m2", "Done with both."),
  ]);
  // The turn's last message is in, but nothing after it yet: answering until the turn is seen to end.
  expect(f.state).toBe("answering");
  expect(f.read_as).toBe("mid_turn");
  expect(f.reply.messages.map((m) => m.text)).toEqual(["Logs are clean.", "Done with both."]);
});

test("the turn ends at turn_duration", () => {
  const sc = newScan("hi", T0);
  feed(sc, [user(0, "P", "hi"), said(1, "m1", "hello")]);
  expect(sc.fate.state).toBe("answering");
  feed(sc, [turnOver(1)]);
  expect(sc.fate.state).toBe("answered");
  expect(sc.fate.reply.done).toBe(true);
});

test("sent while idle, with no queue lines at all", () => {
  const f = scan("hello  there\n", [user(0, "P", "hello there"), said(1, "m1", "hi"), turnOver(1)]);
  expect(f.state).toBe("answered");
  expect(f.queued_at).toBe(null);
  expect(f.read_as).toBe("turn");
});

test("taken out of the queue unread", () => {
  const f = scan("never mind", [enqueue(0, "never mind"), remove(2, "never mind", "edited")]);
  expect(f.state).toBe("removed");
  expect(f.removed_reason).toBe("edited");
});

test("interrupted turn", () => {
  const f = scan("do it", [user(0, "P", "do it"), tool(1, "m1"), user(2, "P", [{ type: "text", text: "[Request interrupted by user]" }])]);
  expect(f.state).toBe("answered");
  expect(f.reply.interrupted).toBe(true);
});

test("lines from before it was sent, sidechains and meta lines don't count", () => {
  const f = scan("status?", [
    { ...user(-60, "OLD", "status?") },                        // the same words, asked an hour ago
    user(1, "S", "status?", { isSidechain: true }),           // a subagent's prompt
    user(1, "M", "status?", { isMeta: true }),
  ]);
  expect(f.state).toBe("sent");
});

test("a long paste matches on its start", () => {
  const long = "x".repeat(200);
  const f = scan(long, [enqueue(0, long + "\n[trailing]"), dequeue(1), user(1, "P", long)]);
  expect(f.state).toBe("answering");
});
