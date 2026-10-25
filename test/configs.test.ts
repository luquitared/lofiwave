/**
 * Run configs (src/configs.ts): .env parsing, masking, Docker settings and the argv a config turns a run into.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lw-configs-"));
const { parseDotenv, parseEnvInput, maskValue, maskEnv, parseDocker, parseConfig, dockerArgv, instructionArgs, MASK } = await import("../src/configs");
const { buildCommand, wrapInDocker } = await import("../src/runner");
const { db } = await import("../src/db");

test("parseDotenv: export lines, plain lines, quotes, comments", () => {
  const env = parseDotenv([
    "# a comment",
    "",
    "export OPENAI_API_KEY=sk-abc123",
    "PLAIN=bar baz   # trailing comment",
    'DQ="with \\"quotes\\" and\\nnewline"  # c',
    "SQ='lit $NOT \\n expanded'",
    "EMPTY=",
    "  export  SPACED = v  ",
    'MULTI="line one',
    'line two"',
    "HASH=a#b",
  ].join("\r\n"));
  expect(env).toEqual({
    OPENAI_API_KEY: "sk-abc123",
    PLAIN: "bar baz",
    DQ: 'with "quotes" and\nnewline',
    SQ: "lit $NOT \\n expanded",
    EMPTY: "",
    SPACED: "v",
    MULTI: "line one\nline two",
    HASH: "a#b",
  });
});

test("parseDotenv: refuses what isn't KEY=value", () => {
  expect(() => parseDotenv("just words")).toThrow(/line 1/);
  expect(() => parseDotenv("1BAD=x")).toThrow();
  expect(() => parseDotenv('OPEN="never closed')).toThrow(/unterminated/);
});

test("masking keeps only the last 4 of long values, and a masked value sent back keeps the stored one", () => {
  expect(maskValue("sk-1234567890abcd")).toBe(`${MASK}abcd`);
  expect(maskValue("short")).toBe(MASK);
  const cur = { KEY: "sk-1234567890abcd", OTHER: "x" };
  expect(maskEnv(cur)).toEqual({ KEY: `${MASK}abcd`, OTHER: MASK });
  // KEY unchanged (masked as listed), OTHER changed, NEW added, a key left out is dropped.
  expect(parseEnvInput({ KEY: `${MASK}abcd`, NEW: "n" }, cur)).toEqual({ KEY: "sk-1234567890abcd", NEW: "n" });
  expect(parseEnvInput("KEY=" + `${MASK}abcd` + "\nOTHER=y", cur)).toEqual({ KEY: "sk-1234567890abcd", OTHER: "y" });
  // A masked value for a key that wasn't there is taken literally (nothing to keep).
  expect(parseEnvInput({ X: MASK }, cur)).toEqual({ X: MASK });
  expect(() => parseEnvInput({ AGENT_CONSOLE_TOKEN: "x" })).toThrow(/lofiwave's own/);
  expect(() => parseEnvInput({ "bad-name": "x" })).toThrow(/valid variable/);
});

test("parseDocker: volumes as strings or objects, ~ expanded, validation", () => {
  expect(parseDocker(null)).toBeNull();
  expect(parseDocker({ image: "" })).toBeNull();
  const d = parseDocker({ image: "node:22", volumes: ["~/tools:/opt/tools:ro", { source: "cache-vol", target: "/root/.cache" }], user: "host" })!;
  expect(d.volumes).toEqual([
    { source: join(homedir(), "tools"), target: "/opt/tools", mode: "ro" },
    { source: "cache-vol", target: "/root/.cache", mode: "rw" },
  ]);
  expect(d.user).toBe("host");
  expect(() => parseDocker({ image: "node:22", volumes: ["relative/path:/x"] })).toThrow(/absolute path/);
  expect(() => parseDocker({ image: "node:22", volumes: ["/a:relative"] })).toThrow(/target/);
  expect(() => parseDocker({ image: "node:22", volumes: ["/a:/b:rx"] })).toThrow(/mode/);
  expect(() => parseDocker({ image: "bad image" })).toThrow(/image/);
  expect(() => parseDocker({ image: "x", args: "nope" })).toThrow(/args/);
});

test("parseConfig keeps fields left out", () => {
  const cur = { name: "c", description: "d", instructions: "be terse", env: { A: "1" }, docker: null };
  expect(parseConfig({ description: "new" }, cur)).toEqual({ description: "new", instructions: "be terse", env: { A: "1" }, docker: null });
  expect(parseConfig({ env: "export B=2" }, cur).env).toEqual({ B: "2" });
});

test("instructions go to claude as --append-system-prompt and to codex as developer_instructions", () => {
  expect(instructionArgs("claude", "be terse", [])).toEqual(["--append-system-prompt", "be terse"]);
  expect(instructionArgs("claude", "be terse", ["--system-prompt", "x"])).toEqual([]);
  expect(instructionArgs("claude", "  ", [])).toEqual([]);
  expect(instructionArgs("codex", 'say "hi"\nthen stop', [])).toEqual(["-c", 'developer_instructions="say \\"hi\\"\\nthen stop"']);
  expect(instructionArgs("aider", "x", [])).toEqual([]);
});

const claudeType = () => db.query<any, []>("SELECT * FROM process_types WHERE name = 'claude'").get()!;
const cfg = (over: any = {}) => ({ name: "c", description: "", instructions: "Always answer in French.", env: { SECRET: "s3cr3t-value-123" }, docker: null, ...over });

test("buildCommand puts the instructions in the template (a restart doesn't see them as extra args)", () => {
  const b = buildCommand(claudeType(), { cwd: "/tmp", prompt: "hi", extraArgs: ["--model", "x"], interactive: false, runConfig: cfg() });
  expect(b.args).toEqual(["-p", "hi", "--append-system-prompt", "Always answer in French.", "--model", "x"]);
  expect(b.template_len).toBe(4);
  // Never the env's values.
  expect(JSON.stringify(b)).not.toContain("s3cr3t");
});

test("an {instructions} placeholder in a type's args takes them instead", () => {
  const t = { ...claudeType(), name: "mine", command: "mytool", args: JSON.stringify(["--system={instructions}", "{prompt}"]) };
  expect(buildCommand(t, { cwd: "/tmp", prompt: "go", runConfig: cfg() }).args).toEqual(["--system=Always answer in French.", "go"]);
  // No instructions: the arg is dropped, like an empty {prompt} (so write a flag and its value as one arg).
  expect(buildCommand(t, { cwd: "/tmp", prompt: "go", runConfig: cfg({ instructions: "" }) }).args).toEqual(["go"]);
});

test("docker: the run becomes docker run … image command args, env by name only", () => {
  const docker = parseDocker({ image: "node:22", volumes: ["/data/static:/srv/static:ro", "npm-cache:/root/.npm"], network: "host", args: ["--memory", "2g"] })!;
  const c = cfg({ docker });
  const built = buildCommand(claudeType(), { cwd: "/work/repo", prompt: "", interactive: true, extraArgs: ["--model", "opus"], runConfig: c });
  // In a container, lofiwave's chat settings file (a path on this machine) is left out; only the renderer goes in.
  expect(built.args.join(" ")).not.toContain("claude-chat.json");
  const w = wrapInDocker(docker, built, { name: "lofiwave-abc", cwd: "/work/repo", interactive: true, envKeys: ["LOFIWAVE_OUT_DIR", "SECRET", "AGENT_CONSOLE_RUN_ID"] });
  expect(w.args.slice(0, 14)).toEqual(["run", "--rm", "--init", "--name", "lofiwave-abc", "-it", "-w", "/work/repo", "-v", "/work/repo:/work/repo", "-v", "/data/static:/srv/static:ro", "-v", "npm-cache:/root/.npm"]);
  expect(w.args).toContain("--network");
  const img = w.args.indexOf("node:22");
  expect(w.args.slice(img - 2, img)).toEqual(["--memory", "2g"]);
  expect(w.args[img + 1]).toBe("claude");
  expect(w.args.slice(img + 2)).toEqual(built.args);
  // -e KEY, never KEY=value.
  expect(w.args.filter((a, i) => w.args[i - 1] === "-e")).toEqual(["LOFIWAVE_OUT_DIR", "SECRET", "AGENT_CONSOLE_RUN_ID"]);
  expect(JSON.stringify(w)).not.toContain("s3cr3t");
  // The extra args stay extra: what a restart passes again.
  expect(w.args.slice(w.template_len)).toEqual(["--model", "opus"]);
});

test("docker: headless runs get no tty, user host is this machine's uid:gid", () => {
  const d = parseDocker({ image: "alpine", user: "host" })!;
  const a = dockerArgv(d, { name: "n", cwd: "/w", command: "sh", args: ["-c", "env"], envKeys: [], interactive: false, uid: "501:20" });
  expect(a).not.toContain("-it");
  expect(a.slice(a.indexOf("--user"), a.indexOf("--user") + 2)).toEqual(["--user", "501:20"]);
  expect(a.slice(-4)).toEqual(["alpine", "sh", "-c", "env"]);
});
