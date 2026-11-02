// Shortened paths in Claude's text → files (src/chat/resolve.ts), with a scripted Jev standing in for the real one.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { suffixPattern, resolveMentions, candidatesFor, touchedFiles } from "../src/chat/resolve";
import type { JevAsk, Question } from "../src/jev";

const repo = realpathSync(mkdtempSync(join(tmpdir(), "lofiwave-paths-")));
const put = (rel: string, text = `// ${rel}\n`) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
for (const f of ["public/chat.js", "public/app.js", "src/chat/index.ts", "src/chat/files.ts", "src/index.ts", "src/chat/resolve.ts", "README.md", "lib/files.ts"]) put(f);
put("node_modules/x/index.ts");
Bun.spawnSync(["git", "init", "-q", repo]);
writeFileSync(join(repo, ".gitignore"), "node_modules\n");

let n = 0;
const item = (o: any) => ({ id: `i${n}`, turnId: "t", ordinal: n++, status: "completed", native: { agent: "claude", ref: "" }, ...o });
const all = () => true;

test("suffix patterns: leading ./ ../ …/ dropped, a ... folder matches any depth, explicit paths left alone", () => {
  expect(suffixPattern("chat.js")!.test("public/chat.js")).toBe(true);
  expect(suffixPattern("chat.js")!.test("public/mychat.js")).toBe(false);
  expect(suffixPattern("chat/files.ts")!.test("src/chat/files.ts")).toBe(true);
  expect(suffixPattern("…/resolve.ts")!.test("src/chat/resolve.ts")).toBe(true);
  expect(suffixPattern("../chat/files.ts")!.test("src/chat/files.ts")).toBe(true);
  expect(suffixPattern("src/.../files.ts")!.test("src/chat/files.ts")).toBe(true);
  expect(suffixPattern("src/.../files.ts")!.test("lib/chat/files.ts")).toBe(false);
  expect(suffixPattern("/abs/x.ts")).toBeNull();
  expect(suffixPattern("~/x.ts")).toBeNull();
  expect(suffixPattern("…/")).toBeNull();
});

test("one match links without asking Jev; ignored files aren't candidates", async () => {
  const jev: JevAsk = async () => { throw new Error("should not be called"); };
  const r = await resolveMentions({ cwd: repo, mentions: ["chat.js", "chat/files.ts", "…/resolve.ts", "nope.ts"], items: [], allowed: all, jev });
  expect(r["chat.js"]).toEqual({ abs: join(repo, "public/chat.js"), via: "unique" });
  expect(r["chat/files.ts"].abs).toBe(join(repo, "src/chat/files.ts"));
  expect(r["…/resolve.ts"].abs).toBe(join(repo, "src/chat/resolve.ts"));
  expect(r["nope.ts"]).toBeUndefined();
  expect(candidatesFor("index.ts", [], [repo], all).map((c) => c.abs)).not.toContain(join(repo, "node_modules/x/index.ts"));
});

test("files the session touched come first, and also in other repos", () => {
  const items = [item({ kind: "read", label: join(repo, "src/chat/index.ts") }), item({ kind: "assistant", text: `See ${repo}/src/index.ts.` })];
  const t = touchedFiles(items);
  expect(t.map((x) => x.how)).toEqual(["mentioned", "read"]);
  const c = candidatesFor("index.ts", t, [], all);
  expect(c.map((x) => x.abs)).toEqual([join(repo, "src/index.ts"), join(repo, "src/chat/index.ts")]);
});

test("ambiguous without Jev: the one touched candidate wins; two touched → unlinked", async () => {
  const one = [item({ kind: "file_change", path: join(repo, "src/chat/index.ts"), op: "edit", added: 1, removed: 0 })];
  expect((await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: one, allowed: all, jev: null }))["index.ts"])
    .toEqual({ abs: join(repo, "src/chat/index.ts"), via: "session" });
  const two = [...one, item({ kind: "read", label: join(repo, "src/index.ts") })];
  expect(await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: two, allowed: all, jev: null })).toEqual({});
});

/** A Jev that ranks by a preference list, then says yes to `yes` and no to the rest. */
function scripted(prefer: string, yes: Record<string, number>, specific = 0.9) {
  const calls: Record<string, Question>[] = [];
  const jev: JevAsk = async (state: any, qs) => {
    calls.push(qs);
    const out: any = {};
    for (const [id, q] of Object.entries(qs)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k.endsWith(prefer) ? 0.8 : 0.2 / (keys.length - 1)]));
        out[id] = { type: "choice", choice: keys.find((k) => k.endsWith(prefer)), confidence: 0.7, probabilities };
      } else {
        const [m, c] = id.split("_");
        if (c === "specific") { out[id] = { type: "noul", noul: specific }; continue; }
        const path: string = state.mentions[m].candidates[c].path;
        out[id] = { type: "noul", noul: Object.entries(yes).find(([k]) => path.endsWith(k))?.[1] ?? 0.05 };
      }
    }
    return out;
  };
  return { jev, calls };
}

test("ambiguous with Jev: rank all, re-check the top three, link a clear winner (batched across mentions)", async () => {
  const items = [item({ kind: "user", text: "fix the chat index" }), item({ kind: "assistant", text: "The feed lives in index.ts and the panel in files.ts." })];
  const { jev, calls } = scripted("src/chat/index.ts", { "src/chat/index.ts": 0.92, "src/chat/files.ts": 0.9 });
  const r = await resolveMentions({ cwd: repo, mentions: ["index.ts", "files.ts"], items, allowed: all, jev });
  expect(calls.length).toBe(2);
  expect(Object.keys(calls[0])).toEqual(["m0", "m1"]);
  expect(Object.keys(calls[1]).length).toBe(6); // per mention: "one file meant?" + 2 candidates
  expect(r["index.ts"]).toEqual({ abs: join(repo, "src/chat/index.ts"), via: "jev", confidence: 0.92 });
  expect(r["files.ts"].abs).toBe(join(repo, "src/chat/files.ts"));
});

test("Jev unsure, or two candidates both plausible: stays unlinked", async () => {
  const unsure = scripted("src/chat/index.ts", { "src/chat/index.ts": 0.5 });
  expect(await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: [], allowed: all, jev: unsure.jev })).toEqual({});
  const both = scripted("src/chat/index.ts", { "src/chat/index.ts": 0.9, "src/index.ts": 0.8 });
  expect(await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: [], allowed: all, jev: both.jev })).toEqual({});
});

test("a middling re-check links only when the ranking picked the same file", async () => {
  const agree = scripted("src/chat/index.ts", { "src/chat/index.ts": 0.6 });
  expect((await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: [], allowed: all, jev: agree.jev }))["index.ts"]?.abs).toBe(join(repo, "src/chat/index.ts"));
  const disagree = scripted("src/index.ts", { "src/chat/index.ts": 0.6 });
  expect(await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: [], allowed: all, jev: disagree.jev })).toEqual({});
});

test("a kind of file, not one file: stays unlinked however sure the re-check is", async () => {
  const { jev } = scripted("src/chat/index.ts", { "src/chat/index.ts": 0.95 }, 0.2);
  expect(await resolveMentions({ cwd: repo, mentions: ["index.ts"], items: [], allowed: all, jev })).toEqual({});
});

test("copies in a worktree count once: the cwd's checkout, or the copy the session touched", async () => {
  const run = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { stderr: "pipe" });
  run("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  const wt = repo + "-wt";
  expect(run("worktree", "add", "-q", wt).exitCode).toBe(0);
  const touchedWt = [item({ kind: "read", label: join(wt, "public/app.js") })];
  // The worktree is a search root (the session touched a file in it), yet chat.js is one file.
  const r = await resolveMentions({ cwd: repo, mentions: ["chat.js", "app.js"], items: touchedWt, allowed: all, jev: null });
  expect(r["chat.js"]).toEqual({ abs: join(repo, "public/chat.js"), via: "unique" });
  expect(r["app.js"]).toEqual({ abs: join(wt, "public/app.js"), via: "unique" });
});

test("Jev failing falls back to the session rule", async () => {
  const jev: JevAsk = async () => { throw new Error("HTTP 529"); };
  const items = [item({ kind: "read", label: join(repo, "src/index.ts") })];
  expect((await resolveMentions({ cwd: repo, mentions: ["index.ts"], items, allowed: all, jev }))["index.ts"].via).toBe("session");
});

test("paths outside the allowed roots are never candidates", async () => {
  const r = await resolveMentions({ cwd: repo, mentions: ["chat.js"], items: [], allowed: (p) => !p.includes("/public/"), jev: null });
  expect(r).toEqual({});
});
