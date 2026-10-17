// The statusLine command of interactive claude runs (src/chat/settings.ts). Claude passes the session's model,
// context use, cost and rate limits on stdin at every refresh: send a copy to lofiwave for the chat view, then run
// the statusline the user would otherwise see (project local, project, then user settings) and print its output.
// Never fails: a statusline that errors only blanks the line.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const raw = await Bun.stdin.text();
let input: any = {};
try { input = JSON.parse(raw || "{}"); } catch { /* not JSON: still run the user's statusline */ }

const runId = process.env.AGENT_CONSOLE_RUN_ID;
const base = process.env.AGENT_CONSOLE_URL;
const token = process.env.AGENT_CONSOLE_TOKEN ?? "";
const report = runId && base
  ? fetch(`${base}/api/hooks/statusline`, {
      method: "POST", body: raw, signal: AbortSignal.timeout(1000),
      headers: { "content-type": "application/json", "x-lofiwave-run": runId, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }).catch(() => {})
  : Promise.resolve();

/** The statusLine command that --settings replaced, skipping this one. */
function userStatusLine(): string {
  const dir = input?.workspace?.project_dir || input?.cwd || process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  for (const f of [join(dir, ".claude", "settings.local.json"), join(dir, ".claude", "settings.json"), join(configDir, "settings.json")]) {
    try {
      if (!existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, "utf8"))?.statusLine;
      if (s?.type === "command" && typeof s.command === "string" && !s.command.includes("claude-statusline.ts")) return s.command;
    } catch { /* unreadable settings: try the next */ }
  }
  return "";
}

const cmd = userStatusLine();
if (cmd) {
  try {
    const p = Bun.spawn(["/bin/sh", "-c", cmd], { stdin: new TextEncoder().encode(raw), stdout: "pipe", stderr: "ignore", env: process.env });
    const timer = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    process.stdout.write(out);
  } catch { /* the user's statusline failed: show nothing */ }
}
await report;
process.exit(0);
