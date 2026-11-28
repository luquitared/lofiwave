// End to end: a scratch lofiwave with presets. Built-in presets are listed; several picked are joined in order into
// the run's instructions; a new agent session without `presets` gets the machine's defaults (env, then the setting);
// a swarm worker doesn't; a restart keeps them or takes new ones; a preset folder adds presets; edits and resets.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-presets";

let tmp = "", base = "", work = "";
let server: Bun.Subprocess | null = null;

const call = async (method: string, path: string, body?: any) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
};
const api = async (method: string, path: string, body?: any) => {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}
const finished = (id: number) => until(`run ${id} to end`, async () => {
  const r = await api("GET", `/runs/${id}`);
  return r.status === "running" ? null : r;
});
const outputOf = async (id: number) => (await finished(id)).output as string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lofiwave-presets-"));
  for (const d of ["home", "data", "tmux", "work", "presets"]) mkdirSync(join(tmp, d));
  work = join(tmp, "work");
  writeFileSync(join(tmp, "presets", "workshop.md"), "<!-- For the build fest -->\nWORKSHOP-PROMPT\n");
  writeFileSync(join(tmp, "presets", "Bad Name.md"), "skipped\n");
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.TMUX; delete env.TMUX_PANE;
  Object.assign(env, {
    HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1",
    AUTH_TOKEN: TOKEN, OPEN_TERMINAL: "none", PASSWORD: "", LOFIWAVE_AGENT_CONTEXT: "off",
    LOFIWAVE_PRESETS_DIR: join(tmp, "presets"), LOFIWAVE_DEFAULT_PRESETS: "pr", LOFIWAVE_DEFAULT_VIEW: "",
  });
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
  await until("the server", () => api("GET", "/health"));
  // A headless "agent" that prints the instructions it was given.
  await api("POST", "/process-types", { name: "echoagent", kind: "agent", command: "sh", args: ["-c", "printf 'INSTR<%s>' \"$1\"", "sh", "{instructions}"] });
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("lists built-in and folder presets, and the machine's defaults from the env", async () => {
  const r = await api("GET", "/presets");
  const names = r.presets.map((p: any) => p.name);
  expect(names.slice(0, 3)).toEqual(["autonomous", "pr", "vibecode"]);
  const ws = r.presets.find((p: any) => p.name === "workshop");
  expect(ws).toMatchObject({ source: "file", description: "For the build fest", prompt: "WORKSHOP-PROMPT" });
  expect(names).not.toContain("bad name");
  expect(r.defaults).toEqual({ names: ["pr"], from: "env" });
  expect(r.default_view).toEqual({ view: "chat", from: "none" });
});

test("presets picked are joined in order; none given = the machine's defaults; [] = none", async () => {
  const pr = (await api("GET", "/presets/pr")).prompt;
  const vibe = (await api("GET", "/presets/vibecode")).prompt;
  const both = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false, presets: ["vibecode", "pr"] });
  expect(await outputOf(both.id)).toContain(`INSTR<${vibe}\n\n${pr}>`);
  expect(both.meta.presets).toEqual(["vibecode", "pr"]);
  const dflt = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false });
  expect(await outputOf(dflt.id)).toContain(`INSTR<${pr}>`);
  const none = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false, presets: [] });
  expect(await outputOf(none.id)).toContain("INSTR<>");
  expect((await call("POST", "/processes", { type: "echoagent", cwd: work, interactive: false, presets: ["nope"] })).data.error).toMatch(/unknown preset "nope"/);
  // A swarm worker (it has a controller) doesn't get the machine's defaults.
  const worker = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false, parent_run: none.id });
  expect(await outputOf(worker.id)).toContain("INSTR<>");
});

test("a restart keeps the run's presets, or takes new ones", async () => {
  const r = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false, presets: ["workshop"] });
  await finished(r.id);
  const again = await api("POST", `/runs/${r.id}/restart`);
  expect(await outputOf(again.id)).toContain("INSTR<WORKSHOP-PROMPT>");
  const changed = await api("POST", `/runs/${again.id}/restart`, { presets: "autonomous,workshop" });
  expect(changed.meta.presets).toEqual(["autonomous", "workshop"]);
  expect(await outputOf(changed.id)).toContain("WORKSHOP-PROMPT>");
});

test("the setting wins over the env; null goes back to it", async () => {
  expect((await api("PUT", "/settings", { default_presets: ["vibecode", "pr"], default_view: "terminal" })).defaults).toEqual({ names: ["vibecode", "pr"], from: "settings" });
  expect((await api("GET", "/settings")).default_view).toEqual({ view: "terminal", from: "settings" });
  const r = await api("POST", "/processes", { type: "echoagent", cwd: work, interactive: false });
  expect(r.meta.presets).toEqual(["vibecode", "pr"]);
  expect((await call("PUT", "/settings", { default_presets: ["nope"] })).status).toBe(400);
  expect((await call("PUT", "/settings", { default_view: "tv" })).status).toBe(400);
  const back = await api("PUT", "/settings", { default_presets: null, default_view: null });
  expect(back.defaults).toEqual({ names: ["pr"], from: "env" });
  expect(back.default_view.from).toBe("none");
  // An explicitly empty default: new sessions start with none.
  expect((await api("PUT", "/settings", { default_presets: [] })).defaults).toEqual({ names: [], from: "settings" });
  await api("PUT", "/settings", { default_presets: null });
});

test("custom presets: create, edit, delete; a built-in one edited and reset", async () => {
  const c = await api("POST", "/presets", { name: "demo-day", description: "Demo", prompt: "Make it shine." });
  expect(c).toMatchObject({ name: "demo-day", source: "custom" });
  expect((await call("POST", "/presets", { name: "demo-day", prompt: "x" })).status).toBe(409);
  expect((await call("POST", "/presets", { name: "Bad Name", prompt: "x" })).status).toBe(400);
  expect((await call("POST", "/presets", { name: "empty" })).status).toBe(400);
  expect((await api("PUT", "/presets/demo-day", { prompt: "Make it sparkle." })).prompt).toBe("Make it sparkle.");
  await api("PUT", "/settings", { default_presets: ["pr", "demo-day"] });
  await api("DELETE", "/presets/demo-day");
  expect((await api("GET", "/settings")).defaults.names).toEqual(["pr"]);
  await api("PUT", "/settings", { default_presets: null });

  const orig = (await api("GET", "/presets/pr")).prompt;
  expect((await call("DELETE", "/presets/pr")).status).toBe(400);
  const mine = await api("PUT", "/presets/pr", { prompt: "My PR rules." });
  expect(mine).toMatchObject({ source: "builtin", edited: true, prompt: "My PR rules.", builtin_prompt: orig });
  expect((await api("DELETE", "/presets/pr")).reset).toBe(true);
  expect((await api("GET", "/presets/pr")).prompt).toBe(orig);
});

test("preview shows the presets' prompt in the command", async () => {
  const r = await api("POST", "/processes/preview", { type: "echoagent", cwd: work, interactive: false, presets: ["workshop"] });
  expect(r.presets).toEqual(["workshop"]);
  expect(r.args).toContain("WORKSHOP-PROMPT");
});

test("Remote Control: on by default for a new claude session; the setting turns it off; asked-for args stay", async () => {
  const args = async (extra = "") => (await api("POST", "/processes/preview", { type: "claude", cwd: work, interactive: true, presets: [], extra_args: extra })).args as string[];
  expect((await api("GET", "/settings")).remote_control).toEqual({ on: true, from: "none" });
  expect(await args()).toContain("--remote-control");
  expect((await api("PUT", "/settings", { remote_control: false })).remote_control).toEqual({ on: false, from: "settings" });
  expect(await args()).not.toContain("--remote-control");
  expect(await args("--remote-control")).toContain("--remote-control");
  expect((await call("PUT", "/settings", { remote_control: "off" })).status).toBe(400);
  expect((await api("PUT", "/settings", { remote_control: null })).remote_control.on).toBe(true);
});
