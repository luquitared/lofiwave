// Matching a streamed message (MessageDisplay) to the transcript item that replaces it in the chat view.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// src/chat imports the database, which opens DATA_DIR on load: point it somewhere empty first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lofiwave-streamtest-"));
const { streamLanded } = await import("../src/chat/index");

const T0 = Date.parse("2026-10-28T17:47:45.000Z");
const at = (s: number) => T0 + s * 1000;
const prompt = (s: number, extra = {}) => ({ id: `u${s}`, kind: "user", text: "go", images: [], status: "completed", startedAt: at(s), ...extra }) as any;
const said = (s: number, text: string) => ({ id: `a${s}`, kind: "assistant", text, status: "completed", startedAt: at(s) }) as any;
const tool = (s: number) => ({ id: `t${s}`, kind: "tool", status: "completed", startedAt: at(s) }) as any;

const LINE = "Launching the run now. First I'll check the lofiwave API for how to start a run.";

test("a one-line message followed by a tool call matches, though it streams after the tool call is written", () => {
  // Seen live: text written at +7.2s, tool_use at +10.5s, and the only flush (the final one) after that.
  const items = [prompt(0), said(7.2, LINE), tool(10.5)];
  expect(streamLanded(items, LINE, at(10.6))).toBe(true);
  expect(streamLanded(items, LINE, at(40))).toBe(true);
});

test("a stream doesn't match the same text from an earlier turn", () => {
  const items = [prompt(0), said(2, "Done."), prompt(30)];
  expect(streamLanded(items, "Done.", at(35))).toBe(false);
  expect(streamLanded([...items, said(36, "Done.")], "Done.", at(35))).toBe(true);
});

test("a queued message doesn't start a turn; a task notification does", () => {
  const items = [prompt(0), said(5, LINE), prompt(8, { queued: true })];
  expect(streamLanded(items, LINE, at(12))).toBe(true);
  const notified = [prompt(0), said(5, LINE), prompt(20, { notification: true })];
  expect(streamLanded(notified, LINE, at(25))).toBe(false);
});

test("a partial stream matches the start of the message, whitespace aside", () => {
  const items = [prompt(0), said(3, "First paragraph.\n\nSecond  paragraph.")];
  expect(streamLanded(items, "First paragraph.\n", at(2))).toBe(true);
  expect(streamLanded(items, "Something else.\n", at(2))).toBe(false);
});
