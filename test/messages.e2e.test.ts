// End to end: a scratch lofiwave (its own data dir, HOME, port and tmux server) drives test/fake-claude/claude, an agent
// that is busy when the message comes, queues it, answers it, and then never goes idle. The caller gets the reply
// through the API alone, and the run gets its session though no SessionStart hook ever reports it.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const FAKE = join(ROOT, "test", "fake-claude", "claude");
const TOKEN = "test-token-messages";
const tmux = Bun.which("tmux");

let tmp = "", base = "", work = "";
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
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

beforeAll(async () => {
  if (!tmux) return;
  tmp = mkdtempSync(join(tmpdir(), "lofiwave-msgq-"));
  for (const d of ["home", "data", "tmux", "work"]) mkdirSync(join(tmp, d));
  work = join(tmp, "work");
  chmodSync(FAKE, 0o755);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env as Record<string, string> };
  // Our own tmux server (TMUX_TMPDIR), never the one the person's sessions are in: drop the inherited $TMUX.
  delete env.TMUX; delete env.TMUX_PANE;
  Object.assign(env, {
    HOME: join(tmp, "home"), DATA_DIR: join(tmp, "data"), TMUX_TMPDIR: join(tmp, "tmux"), PORT: String(port), HOST: "127.0.0.1",
    AUTH_TOKEN: TOKEN, OPEN_TERMINAL: "none", PASSWORD: "", FAKE_FIRST_TURN_MS: "8000",
  });
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  await until("the server", () => api("GET", "/health"));
  await api("POST", "/process-types", { name: "fakeclaude", kind: "agent", command: FAKE, args: [], interactive_args: [] });
}, 30_000);

afterAll(async () => {
  if (!tmux) return;
  server?.kill();
  await server?.exited;
  Bun.spawnSync(["tmux", "kill-server"], { env });
  rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!tmux)("a queued message's reply comes back through the API while the agent never goes idle", async () => {
  const run = await api("POST", "/processes", { type: "fakeclaude", cwd: work, interactive: true, stop_when_idle: false, trust: false });
  await until("the agent working", async () => (await api("GET", `/runs/${run.id}`)).activity === "working");

  // The run finds its session from claude's registry: no SessionStart hook reported it.
  const withSession = await until("a session on the run", async () => { const r = await api("GET", `/runs/${run.id}`); return r.session_id ? r : null; });
  expect(withSession.sessions[0].source).toBe("registry");

  // Mid-turn: the message queues.
  const sent = await api("POST", `/runs/${run.id}/message`, { text: "what is six times seven" });
  expect(sent.delivered).toBe(true);
  expect(sent.queued).toBe(true);
  expect(typeof sent.message_id).toBe("number");
  const early = await api("GET", `/runs/${run.id}/messages/${sent.message_id}`);
  expect(["queued", "sent"]).toContain(early.state);

  // What the caller did before: wait for idle after it. It never comes.
  const idle = await api("GET", `/runs/${run.id}/wait?until=idle&timeout=8&after=${sent.sent_at}`);
  expect(idle.reached).toBe(false);
  expect(idle.activity).toBe("working");

  // What it does now: wait for the reply to that message.
  const got = await api("GET", `/runs/${run.id}/messages/${sent.message_id}?wait=30`);
  expect(got.reached).toBe(true);
  expect(got.state).toBe("answered");
  expect(got.read_as).toBe("turn");
  expect(got.queued_at).toBeGreaterThan(0);
  expect(got.read_at).toBeGreaterThanOrEqual(got.queued_at);
  expect(got.reply.done).toBe(true);
  expect(got.reply.text).toBe("ANSWER: what is six times seven");
  expect(got.session_id).toBe(withSession.session_id);
  // The agent is still busy (its notification turns), so this is the only way to that answer short of the screen.
  expect((await api("GET", `/runs/${run.id}`)).activity).toBe("working");

  // And /messages of the session has it too, now that the run knows its session.
  const convo = await api("GET", `/runs/${run.id}/sessions/${withSession.session_id}/messages`);
  expect(convo.some((m: any) => m.role === "assistant" && m.text === "ANSWER: what is six times seven")).toBe(true);

  // A second message, typed during a notification turn: read mid-turn and answered at that turn's end.
  const second = await api("POST", `/runs/${run.id}/message`, { text: "and eight times nine" });
  expect(second.queued).toBe(true);
  const w = await api("GET", `/runs/${run.id}/wait?until=replied&message=${second.message_id}&timeout=30`);
  expect(w.reached).toBe(true);
  expect(w.message.state).toBe("answered");
  expect(w.message.read_as).toBe("mid_turn");
  expect(w.message.reply.text).toContain("ANSWER: and eight times nine");

  const list = await api("GET", `/runs/${run.id}/messages`);
  expect(list.map((m: any) => [m.message_id, m.state])).toEqual([[sent.message_id, "answered"], [second.message_id, "answered"]]);

  await api("POST", `/runs/${run.id}/kill?force=1`);
}, 90_000);
