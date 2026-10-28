// End to end: a scratch lofiwave (its own data dir, HOME, port and tmux server) with run configs: the API masks the
// env, a run sees the config's env (the run's own env wins) and the instructions, a workflow carries a config, and a
// config in use can't be deleted. With a usable docker, a run with a docker config sees its volume.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-configs";

let tmp = "", base = "", work = "";
let server: Bun.Subprocess | null = null;
let dockerOk = false;

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

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lofiwave-cfg-"));
  for (const d of ["home", "data", "tmux", "work"]) mkdirSync(join(tmp, d));
  work = join(tmp, "work");
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.TMUX; delete env.TMUX_PANE;
  Object.assign(env, { HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: TOKEN, OPEN_TERMINAL: "none", PASSWORD: "" });
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  await until("the server", () => api("GET", "/health"));
  dockerOk = (await api("GET", "/docker")).available;
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const SECRET = "sk-test-0123456789abcdefghij";

test("the API lists a config's env masked, and a masked value sent back keeps the stored one", async () => {
  const c = await api("POST", "/configs", { name: "keys", instructions: "Be brief.", env: `# keys\nexport API_KEY=${SECRET}\nWHO=config` });
  expect(c.env).toEqual({ API_KEY: "••••ghij", WHO: "••••" });
  expect(c.env_keys).toEqual(["API_KEY", "WHO"]);
  expect(JSON.stringify(await api("GET", "/configs"))).not.toContain(SECRET);
  expect((await call("POST", "/configs", { name: "keys" })).status).toBe(409);
  expect((await call("POST", "/configs", { name: "bad", env: "not an assignment" })).status).toBe(400);
  expect((await call("POST", "/configs", { name: "bad", env: { AUTH_TOKEN: "x" } })).status).toBe(400);
  await api("PUT", "/configs/keys", { env: { API_KEY: "••••ghij", WHO: "config" } });
  // The stored secret is what the run will get: checked through a run below.
});

test("a run gets the config's env and instructions; the run's own env wins; the secret isn't on the run record", async () => {
  await api("POST", "/process-types", { name: "showenv", kind: "app", command: "sh", args: ["-c", "echo KEY=$API_KEY WHO=$WHO INSTR=$LOFIWAVE_INSTRUCTIONS CFG=$LOFIWAVE_CONFIG"] });
  expect((await call("POST", "/processes", { type: "showenv", cwd: work, config: "missing" })).data.error).toMatch(/unknown config/);
  const r = await api("POST", "/processes", { type: "showenv", cwd: work, config: "keys", env: { WHO: "run" } });
  const done = await finished(r.id);
  expect(done.output).toContain(`KEY=${SECRET} WHO=run INSTR=Be brief. CFG=keys`);
  expect(done.meta.config).toBe("keys");
  expect(JSON.stringify(done.env)).not.toContain(SECRET);
  expect(JSON.stringify((await api("GET", `/runs/${r.id}`)).args)).not.toContain(SECRET);
  const prev = await api("POST", "/processes/preview", { type: "showenv", cwd: work, config: "keys" });
  expect(prev.config).toBe("keys");
  expect(JSON.stringify(prev)).not.toContain(SECRET);
});

test("a workflow carries a config, which then can't be deleted", async () => {
  const w = await api("POST", "/workflows", { name: "w", type: "showenv", cwd: work, config: "keys" });
  expect(w.config).toBe("keys");
  expect((await call("DELETE", "/configs/keys")).status).toBe(409);
  const r = await api("POST", `/workflows/${w.id}/run`);
  expect((await finished(r.id)).output).toContain(`KEY=${SECRET} WHO=config`);
  expect((await call("PUT", `/workflows/${w.id}`, { config: "missing" })).status).toBe(404);
  await api("PUT", `/workflows/${w.id}`, { config: "" });
  await api("DELETE", "/configs/keys");
});

test("a docker config: a run sees the config's volume and env inside the container", async () => {
  if (!dockerOk) { console.log("docker isn't usable here: skipping the container run"); return; }
  const vol = join(tmp, "static");
  mkdirSync(vol);
  writeFileSync(join(vol, "x.txt"), "static-file");
  await api("POST", "/configs", { name: "boxed", env: { BOX: "yes" }, docker: { image: "alpine:3.20", volumes: [`${vol}:/data:ro`] } });
  await api("POST", "/process-types", { name: "inbox", kind: "app", command: "sh", args: ["-c", "echo BOX=$BOX; cat /data/x.txt; (echo a > /data/y) 2>&1; pwd"] });
  const done = await finished((await api("POST", "/processes", { type: "inbox", cwd: work, config: "boxed" })).id);
  // Without the image locally the pull may fail offline: that is the environment, not the feature.
  if (/Unable to find image|pull access denied|no such host/.test(done.output) && done.status !== "success") { console.log("alpine:3.20 isn't available: skipping"); return; }
  expect(done.output).toContain("BOX=yes");
  expect(done.output).toContain("static-file");
  expect(done.output).toContain("Read-only file system");
  expect(done.output).toContain(work);
}, 60_000);
