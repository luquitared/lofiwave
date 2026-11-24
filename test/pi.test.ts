// pi session lines → the chat view's items, through the Claude projector (src/chat/pi.ts).
import { test, expect } from "bun:test";
import { activeChain, ingest, project, type Rec } from "../src/chat/claude";
import { parsePatch, piSessionFolder, piStatus, piToClaude } from "../src/chat/pi";

const T = "2026-11-19T21:00:00.000Z";
const entry = (id: string, parentId: string | null, message: any) => ({ type: "message", id, parentId, timestamp: T, message });

function items(lines: any[]) {
  const byUuid = new Map<string, Rec>(), order: string[] = [];
  lines.forEach((l, i) => {
    const r = ingest(piToClaude(l), { offset: i, length: 1 });
    if (r) { order.push(r.uuid); byUuid.set(r.uuid, r); }
  });
  return project(activeChain(byUuid, order));
}

const header = { type: "session", version: 3, id: "s-1", timestamp: T, cwd: "/w" };
const user = entry("u1", null, { role: "user", content: "fix the bug", timestamp: 1 });
const call = entry("a1", "mc", {
  role: "assistant", stopReason: "toolUse", model: "gemini-4-neon",
  content: [{ type: "thinking", thinking: "look first" }, { type: "text", text: "Editing." }, { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/x.ts", edits: [{ oldText: "a", newText: "b" }] } }],
});
const result = entry("r1", "a1", {
  role: "toolResult", toolCallId: "c1", toolName: "edit", isError: false,
  content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/x.ts." }],
  details: { patch: "--- src/x.ts\n+++ src/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n ctx" },
});
const answer = entry("a2", "r1", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed." }] });
// A model change between the prompt and the answer: hidden, but the chain still runs through it.
const modelChange = { type: "model_change", id: "mc", parentId: "u1", timestamp: T, provider: "google-vertex", modelId: "gemini-4-neon" };

test("a turn with an edit becomes user, thinking, assistant, file change with its diff, assistant", () => {
  const out = items([header, user, modelChange, call, result, answer]);
  expect(out.map((i) => i.kind)).toEqual(["user", "thinking", "assistant", "file_change", "assistant"]);
  const fc = out[3] as any;
  expect(fc.path).toBe("src/x.ts");
  expect(fc.status).toBe("completed");
  expect(fc.added).toBe(1);
  expect(fc.removed).toBe(1);
  expect(fc.patch[0].lines).toEqual(["-a", "+b", " ctx"]);
  expect(piStatus(out, true)).toBe("idle");
});

test("bash calls show as commands with their output; pi is busy until it answers", () => {
  const c = entry("a1", "u1", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] });
  const running = items([header, user, c]);
  expect(running.at(-1)!.kind).toBe("command");
  expect(running.at(-1)!.status).toBe("running");
  expect(piStatus(running, true)).toBe("busy");
  expect(piStatus(running, false)).toBe("");
  const r = entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "a.txt\n" }] });
  const done = items([header, user, c, r]);
  expect((done.at(-1) as any).output).toBe("a.txt\n");
  expect(piStatus(done, true)).toBe("busy");
});

test("errors and interrupts are events", () => {
  const err = entry("a1", "u1", { role: "assistant", stopReason: "error", errorMessage: "401 bad token", content: [] });
  expect(items([header, user, err]).at(-1)).toMatchObject({ kind: "event", event: "error" });
  const abort = entry("a1", "u1", { role: "assistant", stopReason: "aborted", content: [] });
  expect(items([header, user, abort]).at(-1)).toMatchObject({ kind: "event", event: "interrupt" });
});

test("a branch shows only the active path", () => {
  const first = entry("a1", "u1", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] });
  const second = entry("a2", "u1", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "new" }] });
  expect(items([header, user, first, second]).map((i: any) => i.text)).toEqual(["fix the bug", "new"]);
});

test("session folders and patches", () => {
  expect(piSessionFolder("/home/me/proj")).toBe("--home-me-proj--");
  expect(parsePatch("@@ -3 +3,2 @@\n-x\n+y\n+z")).toEqual([{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ["-x", "+y", "+z"] }]);
});
