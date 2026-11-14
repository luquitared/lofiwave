// /api/ccx against a scratch lofiwave with team login on and a stand-in ccx (test/fake-ccx): the arguments ccx gets,
// who each session belongs to, the user filter, and which files `show` will read.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "test-token-ccx";
const ME = userInfo().username;
// dana started one in the console, her API key started another, and one comes from a terminal.
const DANA = "11111111-1111-4111-8111-111111111111", KEYED = "22222222-2222-4222-8222-222222222222", TERMINAL = "33333333-3333-4333-8333-333333333333";

let tmp = "", base = "";
let server: Bun.Subprocess | null = null;

const call = async (method: string, path: string, auth: Record<string, string>, body?: any) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
};
const token = { authorization: `Bearer ${TOKEN}` };
const get = async (path: string) => (await call("GET", path, token)).data;

beforeAll(async () => {
  tmp = mkdtempSync("/tmp/lwc-");
  for (const d of ["home/.claude/projects/-work", "data", "work"]) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, "home/.claude/projects/-work/sub.jsonl"), "{}\n");
  writeFileSync(join(tmp, "home/secret.jsonl"), "{}\n");
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env as Record<string, string>, HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), PORT: String(port), HOST: "127.0.0.1",
    AUTH_TOKEN: TOKEN, OPEN_TERMINAL: "none", PASSWORD: "pw", MIN_FREE_MEM_MB: "0", CCX_BIN: join(ROOT, "test", "fake-ccx", "ccx"), FAKE_CCX_SESSIONS: [TERMINAL, DANA, KEYED].join(",") };
  delete env.CLAUDE_CONFIG_DIR; delete env.CCX_CLAUDE_DIRS;
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 80; i++) { if ((await call("GET", "/health", token).catch(() => null))?.status === 200) break; await Bun.sleep(250); }

  await call("POST", "/process-types", token, { name: "nap", kind: "app", command: "sleep", args: ["30"] });
  // Signed in like the console's own pages: the cookie, and an Origin that is this console.
  const dana = { cookie: (await call("POST", "/login", {}, { name: "Dana K", password: "pw" })).cookie, origin: base };
  const key = { authorization: `Bearer ${(await call("POST", "/keys", dana, { name: "bot" })).data.key}` };
  for (const [auth, session_id] of [[dana, DANA], [key, KEYED]] as const) {
    const run = (await call("POST", "/processes", auth, { type: "nap", cwd: join(tmp, "work") })).data;
    await call("POST", `/runs/${run.id}/sessions`, token, { session_id });
  }
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(tmp, { recursive: true, force: true });
});

test("status names the machine and the users its sessions have", async () => {
  const s = await get("/ccx");
  expect(s.available).toBe(true);
  expect(s.os_user).toBe(ME);
  expect(s.users.sort()).toEqual([ME, "Dana K"].sort());
});

test("search passes ccx's filters through and says whose each hit is", async () => {
  const r = await get(`/ccx/search?q=${encodeURIComponent("--tool deploy")}&project=api&since=2w&kind=user&main=1&limit=3`);
  expect(r.results.map((h: any) => h.user)).toEqual([ME, "Dana K", "Dana K"]);
  // The query comes after `--`, so one that looks like an option is still the query.
  expect(r.results[0].args).toEqual(["search", "--project=api", "--since=2w", "--kind=user", "--main", "--limit=3", "--json", "--", "--tool deploy"]);
});

test("user= keeps that person's hits, in ccx's order, looking past the first page", async () => {
  const dana = await get("/ccx/search?q=x&limit=150&user=dana");
  expect(dana.results.length).toBe(150);
  expect(dana.results.every((h: any) => h.user === "Dana K")).toBe(true);
  expect(dana.results.slice(0, 3).map((h: any) => h.line)).toEqual([2, 3, 5]);
  const mine = await get(`/ccx/search?q=x&limit=5&user=${ME}`);
  expect(mine.results.map((h: any) => h.session)).toEqual(Array(5).fill(TERMINAL));
  expect((await get("/ccx/search?q=x&user=nobody")).results).toEqual([]);
});

test("sessions carry their user and take the same filter", async () => {
  expect((await get("/ccx/sessions")).sessions.map((s: any) => [s.session, s.user])).toEqual([[TERMINAL, ME], [DANA, "Dana K"], [KEYED, "Dana K"]]);
  expect((await get("/ccx/sessions?user=Dana%20K&query=fix")).sessions.map((s: any) => s.session)).toEqual([DANA, KEYED]);
});

test("show reads a session or a transcript file, nothing else, and returns all of a large slice", async () => {
  const s = await get(`/ccx/show?target=${DANA.slice(0, 8)}&line=12&context=3&full=1`);
  expect(s.args).toEqual(["show", "--line=12", "--context=3", "--full", "--json", "--", DANA.slice(0, 8)]);
  expect(s.blocks[0].text.length).toBe(200_000);
  const sub = join(tmp, "home/.claude/projects/-work/sub.jsonl");
  expect((await call("GET", `/ccx/show?target=${encodeURIComponent(sub)}`, token)).status).toBe(200);
  expect((await call("GET", `/ccx/show?target=${encodeURIComponent(join(tmp, "home/secret.jsonl"))}`, token)).status).toBe(403);
  expect((await call("GET", `/ccx/show?target=${encodeURIComponent(join(tmp, "home/.claude/projects/-work/../../../secret.jsonl"))}`, token)).status).toBe(403);
  expect((await call("GET", `/ccx/show?target=${encodeURIComponent("/etc/passwd")}`, token)).status).toBe(403);
});

test("ccx's refusal comes back as a 400 with its message, a missing q too, and nothing is left behind", async () => {
  const bad = await call("GET", "/ccx/search?q=boom", token);
  expect(bad.status).toBe(400);
  expect(bad.data.error).toContain("syntax error");
  expect((await call("GET", "/ccx/search", token)).status).toBe(400);
  expect((await call("GET", "/ccx/search?q=x", {})).status).toBe(401);
  expect(readdirSync(join(tmp, "data", "ccx"))).toEqual([]);
});
