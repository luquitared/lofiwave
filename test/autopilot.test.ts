// The pure parts of src/autopilot: options as agents write them, the brief's line diff, dates, and the guards'
// patterns. A scratch DATA_DIR, since importing the modules opens the database.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lofiwave-apu-"));
const { parseOptions } = await import("../src/autopilot/asks");
const { diffLines, slugify } = await import("../src/autopilot/programmes");
const { parseWhen } = await import("../src/autopilot/items");
const { checkCommand } = await import("../src/autopilot/guards");

test("options: ids, labels and the recommended mark, however the agent writes them", () => {
  expect(parseOptions(["A: keep it", "B*: switch now", "C: wait a week *"])).toEqual([
    { id: "A", label: "keep it", detail: "", recommended: false },
    { id: "B", label: "switch now", detail: "", recommended: true },
    { id: "C", label: "wait a week", detail: "", recommended: true },
  ]);
  // No id given: letters. A colon in a sentence or a URL isn't an id.
  expect(parseOptions(["Do it now: it is cheap", "See https://example.com/x first"]).map((o) => [o.id, o.label])).toEqual([
    ["A", "Do it now: it is cheap"], ["B", "See https://example.com/x first"],
  ]);
  expect(parseOptions([{ id: "approve", label: "Approve", recommended: true }])[0]).toMatchObject({ id: "approve", recommended: true });
  expect(() => parseOptions(["A: one", "a: two"])).toThrow(/differ/);
  expect(() => parseOptions("A: one")).toThrow(/array/);
  expect(parseOptions(undefined)).toEqual([]);
});

test("the brief's diff lists the lines added and removed, and caps a long one", () => {
  expect(diffLines("one\ntwo\nthree", "one\n2\nthree\nfour")).toEqual(["- two", "+ 2", "+ four"]);
  expect(diffLines("same", "same")).toEqual([]);
  const long = diffLines("", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"), 5);
  expect(long.length).toBe(6);
  expect(long[5]).toBe("… and 55 more changed lines");
});

test("slugs and dates", () => {
  expect(slugify("Hand Pose: phase 2!")).toBe("hand-pose-phase-2");
  expect(parseWhen("2026-11-20")).toBe(Date.parse("2026-11-20"));
  const in3d = parseWhen("3d")!;
  expect(Math.abs(in3d - (Date.now() + 3 * 86400_000))).toBeLessThan(5000);
  expect(parseWhen("")).toBeNull();
  expect(() => parseWhen("someday")).toThrow(/can't read/);
});

test("guards: what the built-in patterns refuse and what they let through", () => {
  const run: any = { id: 999999 };   // not in a programme: the over-budget guard never applies
  const hit = (cmd: string) => checkCommand(run, cmd)?.name ?? null;
  expect(hit("tmux kill-server")).toBe("tmux-kill-server");
  expect(hit("cd /tmp && env -u TMUX tmux kill-server")).toBe("tmux-kill-server");
  expect(hit("tmux -L scratch kill-server")).toBeNull();
  expect(hit("tmux -S /tmp/my.sock kill-server")).toBeNull();
  expect(hit("tmux kill-session -t mine")).toBeNull();
  expect(hit("echo done; tmux -L a ls; tmux kill-server")).toBe("tmux-kill-server");
  expect(hit("pkill -f tmux")).toBe("kill-tmux");
  expect(hit("killall tmux")).toBe("kill-tmux");
  expect(hit("pkill -f 'python train.py'")).toBeNull();
  expect(hit("aws ec2 request-spot-fleet --spot-fleet-request-config file://c.json")).toBe("persistent-spot");
  expect(hit(`aws ec2 run-instances --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"persistent"}}'`)).toBe("persistent-spot");
  expect(hit(`aws ec2 run-instances --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}'`)).toBeNull();
  expect(hit("aws ec2 run-instances --instance-type g5.xlarge")).toBeNull();
});
