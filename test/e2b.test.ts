/**
 * runE2B against a fake E2B: one local server plays both the control plane (REST) and the sandbox's envd
 * (Connect-RPC + /files), so the whole run is exercised: create → mkdir → upload inputs → trust → PTY start →
 * output/input/resize → exit → transcript + out/ back → kill.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope, FrameReader } from "../src/connect";

const tmp = mkdtempSync(join(tmpdir(), "lw-e2b-"));
process.env.DATA_DIR = join(tmp, "data");

const dec = new TextDecoder();
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Call = { path: string; headers: Record<string, string>; body: any };
const calls: Call[] = [];
const files = new Map<string, Uint8Array>();
let ptyCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
let killed = false;
const inputs: string[] = [];
const resizes: any[] = [];

function stream(frames: (ctl: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) {
  return new Response(new ReadableStream({ start: frames }), { headers: { "content-type": "application/connect+json" } });
}
const ev = (e: any) => envelope({ event: e });

let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headers = Object.fromEntries(req.headers);
      // ---- control plane
      if (u.pathname === "/v2/sandboxes" && req.method === "POST") {
        const body = await req.json();
        calls.push({ path: u.pathname, headers, body });
        return Response.json({ sandboxID: "sbx1", envdAccessToken: "envd-tok", envdVersion: "0.5.0", templateID: body.templateID, domain: null }, { status: 201 });
      }
      if (u.pathname.startsWith("/sandboxes/sbx1")) {
        calls.push({ path: `${req.method} ${u.pathname}`, headers, body: null });
        if (req.method === "DELETE") { killed = true; return new Response(null, { status: 204 }); }
        if (u.pathname.endsWith("/timeout")) return new Response(null, { status: 204 });
        return Response.json({ sandboxID: "sbx1", state: killed ? "killed" : "running" });
      }
      // ---- envd files
      if (u.pathname === "/files") {
        const path = u.searchParams.get("path")!;
        calls.push({ path: `${req.method} /files ${path}`, headers, body: null });
        if (req.method === "POST") {
          const form = await req.formData();
          files.set(path, new Uint8Array(await (form.get("file") as Blob).arrayBuffer()));
          return Response.json([{ path }]);
        }
        const f = files.get(path);
        return f ? new Response(f) : new Response("not found", { status: 404 });
      }
      // ---- envd processes
      if (u.pathname.startsWith("/process.Process/")) {
        const method = u.pathname.split("/").pop()!;
        const raw = new Uint8Array(await req.arrayBuffer());
        const body = method === "Start" || method === "Connect" ? JSON.parse(dec.decode(new FrameReader().push(raw)[0].data)) : JSON.parse(dec.decode(raw));
        calls.push({ path: u.pathname, headers, body });
        if (method === "SendInput") {
          const s = Buffer.from(body.input.pty, "base64").toString();
          inputs.push(s);
          ptyCtl?.enqueue(ev({ data: { pty: b64(`echo:${s}`) } }));
          if (s.includes("/exit")) { ptyCtl?.enqueue(ev({ end: { exited: true, status: "exit status 0" } })); ptyCtl?.enqueue(envelope({}, 2)); ptyCtl?.close(); ptyCtl = null; }
          return Response.json({});
        }
        if (method === "Update") { resizes.push(body.pty.size); return Response.json({}); }
        if (method === "SendSignal") return Response.json({});
        if (method === "Start" && body.pty) {
          return stream((c) => { ptyCtl = c; c.enqueue(ev({ start: { pid: 42 } })); c.enqueue(ev({ data: { pty: b64("\x1b[2J\x1b[H\x1b[1mWelcome\x1b[0m\r\n> ") } })); });
        }
        // A plain command: answer by what the script does.
        const script: string = body.process.args[2];
        const args: string[] = body.process.args.slice(4);
        let out = "";
        if (script.includes("find out")) out = [...files.keys()].filter((k) => k.startsWith(`${args[0]}/out/`)).map((k) => k.slice(args[0].length + 1)).join("\n") + "\n";
        else if (script.includes(".jsonl")) out = `/home/user/.claude/projects/-home-user-work/${args[0]}.jsonl\n`;
        return stream((c) => {
          c.enqueue(ev({ start: { pid: 100 + calls.length } }));
          if (out) c.enqueue(ev({ data: { stdout: b64(out) } }));
          c.enqueue(ev({ end: { exited: true, status: "exit status 0" } }));
          c.enqueue(envelope({}, 2));
          c.close();
        });
      }
      return new Response("no", { status: 404 });
    },
  });
  process.env.E2B_API_URL = `http://localhost:${srv.port}`;
  process.env.E2B_SANDBOX_URL = `http://localhost:${srv.port}`;
  process.env.LW_TEST_E2B_KEY = "e2b_test_key";
  process.env.LW_TEST_ANTHROPIC = "sk-ant-test-0123456789abcdefghij";
});
afterAll(() => srv.stop(true));

test("an interactive claude run on e2b, end to end against a fake E2B", async () => {
  const { runE2B, e2bTerms } = await import("../src/e2b");
  const { parseE2BConfig } = await import("../src/targets");
  const c = parseE2BConfig({ api_key_env: "LW_TEST_E2B_KEY", env_from: { ANTHROPIC_API_KEY: "LW_TEST_ANTHROPIC" }, env: { FOO: "bar" } });
  const inDir = join(tmp, "in"); mkdirSync(join(inDir, "sub"), { recursive: true });
  writeFileSync(join(inDir, "brief.md"), "do the thing"); writeFileSync(join(inDir, "sub", "data.csv"), "a,b");
  // What the agent "leaves behind" in the sandbox.
  files.set("/home/user/work/out/report.md", new TextEncoder().encode("# done"));
  files.set("/home/user/.claude/projects/-home-user-work/sess-1.jsonl", new TextEncoder().encode('{"type":"user"}\n'));

  const log: string[] = [];
  const meta: Record<string, unknown> = {};
  let transcript: { id: string; data: string } | null = null;
  const h = runE2B({
    runId: 9, c, command: "claude", args: ["--session-id", "sess-1", "--permission-mode", "acceptEdits"], env: { RUNVAR: "1", AGENT_CONSOLE_TOKEN: "secret" },
    interactive: true, sessionId: "sess-1", inputDir: inDir, outDir: join(tmp, "out"), forbiddenValues: ["master-token"],
    write: (s) => log.push(s), onMeta: (p) => Object.assign(meta, p), saveTranscript: (id, d) => { transcript = { id, data: d.toString() }; },
  });
  const term = e2bTerms.get(9)!;
  expect(term).toBeTruthy();
  for (let i = 0; i < 100 && !term.screen.screenText().includes("Welcome"); i++) await Bun.sleep(20);
  expect(term.screen.screenText()).toContain("Welcome");
  expect(meta.sandbox_id).toBe("sbx1");
  expect(meta.pid).toBe(42);

  // A browser viewer gets output; its input reaches the PTY in order.
  const seen: string[] = [];
  term.viewers.add({ send: (b) => seen.push(dec.decode(b)), close: () => {} });
  await term.input("hi");
  await term.resize(100, 30);
  await term.input("/exit\r");
  const r = await h.done;
  expect(r).toEqual({ code: 0, message: "", failed: false });
  expect(inputs).toEqual(["hi", "/exit\r"]);
  expect(seen.join("")).toContain("echo:hi");
  expect(resizes).toContainEqual({ cols: 100, rows: 30 });

  // Request shaping.
  const create = calls.find((x) => x.path === "/v2/sandboxes")!;
  expect(create.headers["x-api-key"]).toBe("e2b_test_key");
  expect(create.body.templateID).toBe("claude");
  expect(create.body.timeout).toBe(3600);
  expect(create.body.envVars).toEqual({ FOO: "bar", ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdefghij", RUNVAR: "1" });
  const start = calls.find((x) => x.path === "/process.Process/Start" && x.body.pty)!;
  expect(start.headers["x-access-token"]).toBe("envd-tok");
  expect(start.headers["e2b-sandbox-id"]).toBe("sbx1");
  expect(start.headers["content-type"]).toBe("application/connect+json");
  expect(start.body.tag).toBe("lofiwave-9");
  expect(start.body.stdin).toBe(true);
  expect(start.body.process.cwd).toBe("/home/user/work");
  expect(start.body.process.args).toEqual(["-l", "-c", 'exec "$0" "$@"', "claude", "--session-id", "sess-1", "--permission-mode", "acceptEdits"]);
  expect(start.body.pty).toEqual({ size: { cols: 120, rows: 40 } });
  const trust = calls.find((x) => x.path === "/process.Process/Start" && String(x.body.process.args[2]).includes("hasTrustDialogAccepted"));
  expect(trust?.body.process.args.slice(4)).toEqual(["/home/user/work"]);
  // Inputs uploaded, outputs and transcript back, sandbox killed.
  expect(dec.decode(files.get("/home/user/work/in/brief.md")!)).toBe("do the thing");
  expect(dec.decode(files.get("/home/user/work/in/sub/data.csv")!)).toBe("a,b");
  expect(readFileSync(join(tmp, "out", "report.md"), "utf8")).toBe("# done");
  expect(transcript).toEqual({ id: "sess-1", data: '{"type":"user"}\n' });
  expect(killed).toBe(true);
  expect(e2bTerms.has(9)).toBe(false);
  expect(log.join("\n")).toContain("Welcome");   // the last screen goes into the log
});

test("parseProcEvent: proto3 JSON leaves zeros out", async () => {
  const { parseProcEvent } = await import("../src/e2b");
  expect(parseProcEvent({ event: { end: { exited: true, status: "exit status 0" } } })).toEqual({ kind: "end", code: 0, status: "exit status 0", error: "" });
  expect(parseProcEvent({ event: { end: { exitCode: 3, exited: true } } })).toMatchObject({ code: 3 });
  expect(parseProcEvent({ event: { end: { exitCode: -1, status: "signal: killed" } } })).toMatchObject({ code: null });
  expect(parseProcEvent({ event: { start: { pid: 5 } } })).toEqual({ kind: "start", pid: 5 });
  expect(parseProcEvent({ event: { keepalive: {} } })).toEqual({ kind: "keepalive" });
});

test("config: secrets of the console are never forwarded", async () => {
  const { parseE2BConfig } = await import("../src/targets");
  const { sandboxEnv } = await import("../src/e2b");
  expect(() => parseE2BConfig({ env_from: { X: "AUTH_TOKEN" } })).toThrow(/never sent/);
  expect(() => parseE2BConfig({ timeout_sec: 10 })).toThrow(/between 300/);
  const c = parseE2BConfig({ env: { A: "1", LEAK: "master" } });
  expect(sandboxEnv(c, { AGENT_CONSOLE_TOKEN: "master", B: "2" }, ["master"], { ANTHROPIC_API_KEY: "k" })).toEqual({ A: "1", ANTHROPIC_API_KEY: "k", B: "2" });
});

test("safeLocal keeps downloads inside the folder", async () => {
  const { safeLocal } = await import("../src/e2b");
  expect(safeLocal("/x/out", "a/b.txt")).toBe("/x/out/a/b.txt");
  expect(safeLocal("/x/out", "../etc/passwd")).toBeNull();
  expect(safeLocal("/x/out", "/etc/passwd")).toBeNull();
  expect(existsSync("/x/out")).toBe(false);
});
