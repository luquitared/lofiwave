// The team bar above Advanced: turns from the prompt hooks, credited to whoever started the run.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "lofiwave-statstest-"));
process.env.DATA_DIR = join(tmp, "data");
const { db } = await import("../src/db");
const { recordTurn, teamStats, personOf, MAX_TURN_MS } = await import("../src/stats");

const T = Date.parse("2026-11-17T12:00:00Z");
const M = 60_000, H = 60 * M;

function run(by: string | null, status: string, startedAt: number, cwd = "/home/a/proj", trigger = "manual"): number {
  const meta = JSON.stringify(by ? { started_by: by } : {});
  return Number(db.query(`INSERT INTO runs (type_name, cwd, command, trigger, status, started_at, meta) VALUES ('claude', ?, 'claude', ?, ?, ?, ?)`)
    .run(cwd, trigger, status, startedAt, meta).lastInsertRowid);
}

test("who a run counts for: a name, an API key's maker or name, the token, schedules", () => {
  const makers = new Map([["frank", "Frank J"], ["bot", "api"]]);
  expect(personOf("Gary", "manual", makers)).toBe("Gary");
  expect(personOf("key:frank", "api", makers)).toBe("Frank J");
  expect(personOf("key:bot", "api", makers)).toBe("bot");
  expect(personOf("api", "api", makers)).toBe("API token");
  expect(personOf(null, "schedule", makers)).toBe("schedules");
});

test("turns: agent time per person, working now, an interrupted turn closed by the next prompt, the hour grid", () => {
  const a = run("Gary", "running", T - 5 * H, "/home/a/lofiwave");
  const b = run("Seth", "killed", T - 30 * H, "/home/b/site");
  const old = run("Seth", "killed", T - 30 * 24 * H);
  recordTurn(a, "s1", "p1", "UserPromptSubmit", T - 4 * H);
  recordTurn(a, "s1", "p2", "UserPromptSubmit", T - 3 * H);   // p1 was interrupted: it ends here (1h)
  recordTurn(a, "s1", "p2", "Stop", T - 3 * H + 10 * M);       // 10m
  recordTurn(a, "s1", "p3", "UserPromptSubmit", T - 20 * M);   // still working: 20m so far
  recordTurn(b, "s2", "q1", "UserPromptSubmit", T - 29 * H);
  recordTurn(b, "s2", "q1", "Stop", T - 29 * H + 5 * M);
  recordTurn(b, "s2", "q2", "UserPromptSubmit", T - 28 * H);  // never stopped and the run is over: 0
  recordTurn(old, "s3", "x", "UserPromptSubmit", T - 30 * 24 * H);

  const s = teamStats(7, T);
  const gary = s.people.find((p) => p.name === "Gary")!, seth = s.people.find((p) => p.name === "Seth")!;
  expect(gary).toMatchObject({ sessions: 1, turns: 3, agent_ms: H + 10 * M + 20 * M, running: 1, working: 1 });
  expect(seth).toMatchObject({ sessions: 1, turns: 2, agent_ms: 5 * M, running: 0, working: 0 });
  expect(s.people[0].name).toBe("Gary");
  expect(s.totals).toMatchObject({ people: 2, sessions: 2, turns: 5, working: 1, running: 1 });
  expect(s.projects.map((p) => p.name)).toEqual(["lofiwave", "site"]);
  expect(s.activity.reduce((n, a) => n + a[2], 0)).toBe(5);

  const day = teamStats(1, T);
  expect(day.totals.turns).toBe(3);
  expect(day.people.map((p) => p.name)).toEqual(["Gary"]);

  // A turn left open for longer than MAX_TURN_MS stops counting as working.
  expect(teamStats(7, T + MAX_TURN_MS).totals.working).toBe(0);
});
