// End to end: a scratch lofiwave with Settings: terminal_mode defaults to managed, takes window and tab, refuses
// anything else, and survives a restart (it is in the database, not memory).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-settings";
let tmp = "", base = "", env: Record<string, string> = {};
let server: Bun.Subprocess | null = null;

const call = async (method: string, path: string, body?: any) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
};
async function start() {
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  const end = Date.now() + 20_000;
  while ((await call("GET", "/health").catch(() => null))?.status !== 200) {
    if (Date.now() > end) throw new Error("server didn't start");
    await Bun.sleep(200);
  }
}
async function stop() { server?.kill(); await server?.exited; server = null; }

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lofiwave-settings-"));
  for (const d of ["home", "data", "tmux"]) mkdirSync(join(tmp, d));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  env = { ...(process.env as Record<string, string>) };
  delete env.TMUX; delete env.TMUX_PANE; delete env.OPEN_TERMINAL;
  Object.assign(env, { HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: TOKEN, PASSWORD: "" });
  await start();
}, 30_000);

afterAll(async () => {
  await stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("terminal_mode defaults to managed", async () => {
  const { data } = await call("GET", "/settings");
  expect(data.terminal_mode).toBe("managed");
  expect(data.terminal_modes).toEqual(["managed", "window", "tab"]);
  expect(data.open_terminal).toBe("auto");
});

test("bad values and unknown keys are refused", async () => {
  expect((await call("PUT", "/settings", { terminal_mode: "popup" })).status).toBe(400);
  expect((await call("PUT", "/settings", { nope: 1 })).status).toBe(400);
  expect((await call("GET", "/settings")).data.terminal_mode).toBe("managed");
});

test("window and tab are kept, across a restart", async () => {
  expect((await call("PUT", "/settings", { terminal_mode: "window" })).data.terminal_mode).toBe("window");
  expect((await call("PUT", "/settings", { terminal_mode: "tab" })).data.terminal_mode).toBe("tab");
  await stop();
  await start();
  expect((await call("GET", "/settings")).data.terminal_mode).toBe("tab");
}, 30_000);
