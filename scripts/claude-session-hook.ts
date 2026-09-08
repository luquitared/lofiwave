// Body of scripts/claude-session-hook.sh. Reads the hook payload Claude Code passes on stdin and
// reports the session to the agent-console run named by AGENT_CONSOLE_RUN_ID. Never fails the session.
const runId = process.env.AGENT_CONSOLE_RUN_ID;
const base = process.env.AGENT_CONSOLE_URL;
const token = process.env.AGENT_CONSOLE_TOKEN ?? "";
if (!runId || !base) process.exit(0);

let input: any = {};
try { input = JSON.parse(await Bun.stdin.text() || "{}"); } catch { /* not JSON: nothing to report */ }
const sessionId = input.session_id;
if (!sessionId) process.exit(0);

const headers: Record<string, string> = { "content-type": "application/json" };
if (token) headers.authorization = `Bearer ${token}`;
const ending = input.hook_event_name === "SessionEnd";
const url = ending ? `${base}/api/runs/${runId}/sessions/${sessionId}` : `${base}/api/runs/${runId}/sessions`;
const payload = ending
  ? { ended: true, reason: input.reason ?? "", model: input.model ?? "" }
  : { session_id: sessionId, agent: "claude", cwd: input.cwd ?? "", transcript_path: input.transcript_path ?? "", source: input.source ?? "", model: input.model ?? "" };

try {
  const res = await fetch(url, { method: ending ? "PUT" : "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
  // A SessionEnd for a session the console never saw (e.g. console restarted): register it late instead of dropping it.
  if (ending && res.status === 404) {
    await fetch(`${base}/api/runs/${runId}/sessions`, { method: "POST", headers, body: JSON.stringify({ session_id: sessionId, cwd: input.cwd ?? "", transcript_path: input.transcript_path ?? "" }), signal: AbortSignal.timeout(3000) });
    await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
  }
} catch { /* console down or unreachable: the session still runs; nothing to do */ }
process.exit(0);
