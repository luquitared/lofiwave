// GET /api/system/usage against a scratch lofiwave (own data dir, HOME, port and tmux server) with a live run whose
// process tree has children: the run's numbers must be the sum of the whole tree.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-usage";
const tmux = Bun.which("tmux");

let tmp = "", base = "";
let server: Bun.Subprocess | null = null;
let env: Record<string, string> = {};

const api = async (method: string, path: string, body?: any) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
};

beforeAll(async () => {
  if (!tmux) return;
  // A short path: tmux's socket path has a length limit.
  tmp = mkdtempSync("/tmp/lwu-");
  for (const d of ["home", "data", "tmux", "work"]) mkdirSync(join(tmp, d));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env as Record<string, string> };
  delete env.TMUX; delete env.TMUX_PANE;
  Object.assign(env, {
    HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1",
    AUTH_TOKEN: TOKEN, OPEN_TERMINAL: "none", PASSWORD: "", MAX_AGENT_RUNS: "4", MIN_FREE_MEM_MB: "0",
  });
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 80; i++) { if (await api("GET", "/health").catch(() => null)) break; await Bun.sleep(250); }
  // An "agent" that is a shell with two children, like claude with its node and MCP servers.
  await api("POST", "/process-types", { name: "tree", kind: "agent", command: "bash", args: ["-c", "sleep 300 & sleep 300 & wait"], interactive_args: [] });
}, 30_000);

afterAll(async () => {
  if (!tmux) return;
  server?.kill();
  await server?.exited;
  Bun.spawnSync(["tmux", "kill-server"], { env });
  rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!tmux)("usage sums each live run's whole process tree and estimates what still fits", async () => {
  const before = await api("GET", "/system/usage");
  expect(before.machine.mem_total_mb).toBeGreaterThan(0);
  expect(before.machine.cpus).toBeGreaterThan(0);
  expect(before.machine.disk.free_mb).toBeGreaterThan(0);
  expect(before.estimate.per_agent_source).toBe("assumed");
  expect(before.estimate.per_agent_mb).toBe(600);
  expect(before.lofiwave.server.pid).toBeGreaterThan(0);

  const run = await api("POST", "/processes", { type: "tree", cwd: join(tmp, "work"), interactive: true, stop_when_idle: false, trust: false });
  let mine: any = null;
  for (let i = 0; i < 40 && !(mine?.procs >= 3); i++) {
    await Bun.sleep(250);
    mine = (await api("GET", "/system/usage")).lofiwave.runs.find((r: any) => r.run_id === run.id);
  }
  expect(mine.procs).toBe(3); // the pane's bash and its two sleeps
  expect(mine.rss_mb).toBeGreaterThanOrEqual(0);

  const u = await api("GET", "/system/usage");
  expect(u.lofiwave.runs_total.procs).toBe(3);
  expect(u.lofiwave.total.procs).toBe(u.lofiwave.server.procs + (u.lofiwave.tmux?.procs ?? 0) + 3);
  expect(u.estimate.live_agent_runs).toBe(1);
  expect(u.estimate.by_slots).toBe(3);
  expect(u.estimate.can_launch).toBe(Math.min(u.estimate.by_memory, 3));
  await api("POST", `/runs/${run.id}/kill`, {});
}, 30_000);
