// Plan limits for Advanced → Usage: Claude's from the statusline, Codex's from rollout lines shaped like Codex's own.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// src/limits opens the database (DATA_DIR) and finds rollouts (CODEX_HOME) on load: point both somewhere empty first.
const tmp = mkdtempSync(join(tmpdir(), "lofiwave-limitstest-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.CODEX_HOME = join(tmp, "codex");
const { windowAt, windowLabel, lastCodexLimits, codexWindows, codexLimits, recordClaudeLimits, claudeLimits } = await import("../src/limits");

const T = Date.parse("2026-10-26T00:00:00Z");
const H = 3_600_000;

test("labels: session, weekly, a per-model weekly, and windows of other lengths", () => {
  expect(windowLabel(300)).toBe("5-hour session");
  expect(windowLabel(10080, "seven_day")).toBe("Weekly");
  expect(windowLabel(10080, "seven_day_opus")).toBe("Weekly · opus only");
  expect(windowLabel(4320)).toBe("3-day window");
  expect(windowLabel(null, "some_new_one")).toBe("some new one");
});

test("pace: the share of the window gone by; a passed reset reads as 0% used", () => {
  const w = windowAt("seven_day", 12, 10080, T + 84 * H, T); // half the week left
  expect(w.expected_percent).toBe(50);
  expect(w.reset).toBe(false);
  const past = windowAt("five_hour", 80, 300, T - 1, T);
  expect(past).toMatchObject({ reset: true, used_percent: 0, expected_percent: null });
});

const tokenCount = (at: string, rl: any) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rl } });
const weekly = (used: number, resetsAtSec: number) => ({ limit_id: "codex", primary: { used_percent: used, window_minutes: 10080, resets_at: resetsAtSec }, secondary: null, plan_type: "prolite" });

test("codex: the last rate limits in a rollout, skipping a cut first line and events without any", () => {
  const text = ['ut_tokens":1}}}', tokenCount("2026-10-25T10:00:00Z", weekly(3, T / 1000 + 3600)), tokenCount("2026-10-25T11:00:00Z", weekly(4, T / 1000 + 3600)), tokenCount("2026-10-25T12:00:00Z", { primary: null, secondary: null }), ""].join("\n");
  const got = lastCodexLimits(text)!;
  expect(got.at).toBe(Date.parse("2026-10-25T11:00:00Z"));
  expect(got.rate_limits.primary.used_percent).toBe(4);
  expect(lastCodexLimits("not json\n")).toBeNull();
});

test("codex: windows come out shortest first, whichever slot they are in", () => {
  const ws = codexWindows({ primary: { used_percent: 40, window_minutes: 10080, resets_at: T / 1000 + 3600 }, secondary: { used_percent: 9, window_minutes: 300, resets_at: T / 1000 + 600 } }, T);
  expect(ws.map((w) => w.label)).toEqual(["5-hour session", "Weekly"]);
});

test("codex: reads the newest rollout under CODEX_HOME/sessions", () => {
  expect(codexLimits(T)).toBeNull();
  const day = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "25");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-a.jsonl"), tokenCount("2026-10-25T11:00:00Z", weekly(12, T / 1000 + 84 * 3600)) + "\n");
  const got = codexLimits(T)!;
  expect(got).toMatchObject({ agent: "codex", plan: "prolite", at: Date.parse("2026-10-25T11:00:00Z") });
  expect(got.windows).toHaveLength(1);
  expect(got.windows[0]).toMatchObject({ label: "Weekly", used_percent: 12, expected_percent: 50 });
});

test("claude: keeps the newest statusline limits, session first", () => {
  expect(claudeLimits(T)).toBeNull();
  recordClaudeLimits({}); // a statusline without limits leaves the last ones
  recordClaudeLimits({ seven_day: { used_percentage: 30, resets_at: T / 1000 + 84 * 3600 }, five_hour: { used_percentage: 5, resets_at: T / 1000 + 3600 } });
  const got = claudeLimits(T)!;
  expect(got.windows.map((w) => [w.label, w.used_percent, w.expected_percent])).toEqual([["5-hour session", 5, 80], ["Weekly", 30, 50]]);
  recordClaudeLimits({});
  expect(claudeLimits(T)!.windows).toHaveLength(2);
});
