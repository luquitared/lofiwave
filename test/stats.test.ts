// Advanced → Stats: who sent each prompt, and tokens per person, session and folder from transcripts.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "lofiwave-statstest-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
const { db } = await import("../src/db");
const { noteSender, recordTurn, stats, sentMessages, personOf } = await import("../src/stats");
const { indexTokens } = await import("../src/tokens");

const T = Date.parse("2026-11-17T12:00:00Z");
const M = 60_000, H = 60 * M;
const iso = (ms: number) => new Date(ms).toISOString();

function run(by: string, cwd: string, startedAt: number): number {
  return Number(db.query(`INSERT INTO runs (type_name, cwd, command, trigger, status, started_at, meta) VALUES ('claude', ?, 'claude', 'manual', 'running', ?, ?)`)
    .run(cwd, startedAt, JSON.stringify({ started_by: by })).lastInsertRowid);
}
const user = (promptId: string, cwd: string, text = "x") => JSON.stringify({ type: "user", promptId, cwd, message: { role: "user", content: text } });
const assistant = (id: string, at: number, u: [number, number, number, number]) =>
  JSON.stringify({ type: "assistant", timestamp: iso(at), message: { id, model: "claude-opus-5-5", usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } });

test("who an actor stands for: a name, an API key's maker or name, the token, nobody", () => {
  const makers = new Map([["frank", "Frank J"], ["bot", "api"]]);
  expect(personOf("Gary", makers)).toBe("Gary");
  expect(personOf("key:frank", makers)).toBe("Frank J");
  expect(personOf("key:bot", makers)).toBe("bot");
  expect(personOf("api", makers)).toBe("API token");
  expect(personOf("", makers)).toBe("");
});

test("senders, messages and tokens per person, session and folder", async () => {
  const proj = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-home-a-lofiwave");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  const r = run("Gary", "/home/a/lofiwave", T - 5 * H);

  // Gary sends from the chat view; Seth presses Enter in the terminal of Gary's session; then a prompt nobody sent
  // from lofiwave (a tmux attach), and a terminal Enter that is too old to count.
  noteSender(r, "Gary", "chat", T - 4 * H);
  recordTurn(r, "s1", "p1", "UserPromptSubmit", "fix the build", T - 4 * H + 2000);
  noteSender(r, "Seth", "terminal", T - 3 * H);
  recordTurn(r, "s1", "p2", "UserPromptSubmit", "now add tests", T - 3 * H + 500);
  noteSender(r, "Seth", "terminal", T - 2 * H);
  recordTurn(r, "s1", "p3", "UserPromptSubmit", "typed over ssh", T - 2 * H + 60_000);

  writeFileSync(join(proj, "s1.jsonl"), [
    JSON.stringify({ type: "ai-title", aiTitle: "Build fixes", sessionId: "s1" }),
    user("p1", "/home/a/lofiwave", "fix the build"),
    assistant("m1", T - 4 * H + 5000, [10, 100, 1000, 50]),
    assistant("m1", T - 4 * H + 5000, [10, 100, 1000, 50]), // the same call, another content block
    user("p2", "/home/a/lofiwave"),
    assistant("m2", T - 3 * H + 5000, [5, 0, 2000, 20]),
    user("p3", "/home/a/lofiwave"),
    assistant("m3", T - 2 * H + 90_000, [1, 0, 0, 1]),
    "",
  ].join("\n"));
  // Seth's prompt started a subagent: its calls are Seth's too.
  writeFileSync(join(proj, "s1", "subagents", "agent-a.jsonl"), [user("p2", "/home/a/lofiwave"), assistant("m4", T - 3 * H + 9000, [0, 0, 0, 7]), ""].join("\n"));
  // A session lofiwave never saw, in another folder.
  const other = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-home-b-site");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "s9.jsonl"), [user("q1", "/home/b/site"), assistant("n1", T - H, [0, 0, 0, 500]), ""].join("\n"));

  await indexTokens();
  const s = stats(7, T);
  const by = Object.fromEntries(s.people.map((p) => [p.person, p]));
  expect(s.people.map((p) => p.person)).toEqual(["Seth", "Gary", ""]); // a tie on messages goes to tokens; no known sender always last
  expect(by.Gary).toMatchObject({ messages: 1, via: { chat: 1 }, tokens: { total: 1160, output: 50 } });
  expect(by.Seth).toMatchObject({ messages: 1, via: { terminal: 1 }, tokens: { total: 2025 + 7, output: 27 } });
  expect(by[""]).toMatchObject({ messages: 2, tokens: { output: 501 } }); // p3 and the outside session's q1
  expect(s.totals).toMatchObject({ messages: 4, tracked_messages: 2, people: 2, sessions: 2 });

  const s1 = s.sessions.find((x) => x.session_id === "s1")!;
  expect(s1).toMatchObject({ title: "Build fixes", cwd: "/home/a/lofiwave", messages: 3, run_id: null });
  expect(s1.people.sort()).toEqual(["Gary", "Seth"]);
  expect(s.folders.map((f) => f.name).sort()).toEqual(["lofiwave", "site"]);
  expect(s.folders.find((f) => f.name === "site")).toMatchObject({ sessions: 1, messages: 1, people: [], tokens: { output: 500 } });

  // What Seth sent, with its tokens.
  expect(sentMessages("Seth", 7, T)).toMatchObject([{ text: "now add tests", via: "terminal", tokens: { output: 27 } }]);

  // Appended lines are read on the next pass, not the old ones again.
  appendFileSync(join(proj, "s1.jsonl"), assistant("m5", T - H, [0, 0, 0, 3]) + "\n");
  await indexTokens();
  expect(stats(7, T).people.find((p) => p.person === "")!.tokens.output).toBe(504);
  expect(stats(1, T + 48 * H).people).toEqual([]); // nothing in the last day two days later
});
