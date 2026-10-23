/**
 * The `--settings` file interactive claude runs start with (see buildCommand in ../runner.ts). Hooks in it merge
 * with the user's and the project's own; a run that brings its own `--settings` doesn't get it.
 *
 *  - PermissionRequest → approvals answered from the chat view (./approvals.ts)
 *  - MessageDisplay → streaming text; UserPromptSubmit, Stop → per-turn git checkpoints (./live.ts)
 *  - statusLine → usage and context (scripts/claude-statusline.ts, which still runs the user's own statusline)
 *  - tui → the renderer (CLAUDE_TUI)
 *
 * The run id and token reach the hooks as headers from the run's env (only variables listed in allowedEnvVars are
 * interpolated), so one file serves every run.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { permissionHookEntry } from "./approvals";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let settingsFile = "";
/** Written once per server start (the port may have changed). */
export function chatSettingsPath(): string {
  if (settingsFile) return settingsFile;
  const base = `http://127.0.0.1:${config.port}`;
  const http = (path: string, timeout: number) => ({
    type: "http", url: `${base}${path}`, timeout,
    headers: { Authorization: "Bearer $AGENT_CONSOLE_TOKEN", "X-Lofiwave-Run": "$AGENT_CONSOLE_RUN_ID" },
    allowedEnvVars: ["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_RUN_ID"],
  });
  const settings = {
    hooks: {
      PermissionRequest: [{ hooks: [permissionHookEntry(base)] }],
      // The TUI waits on this before drawing each paragraph: lofiwave answers at once, and a short timeout keeps a
      // stopped lofiwave from stalling the screen.
      MessageDisplay: [{ hooks: [http("/api/hooks/message", 2)] }],
      UserPromptSubmit: [{ hooks: [http("/api/hooks/turn", 10)] }],
      Stop: [{ hooks: [http("/api/hooks/turn", 10)] }],
    },
    statusLine: { type: "command", command: `${shq(process.execPath)} ${shq(join(config.root, "scripts", "claude-statusline.ts"))}`, padding: 0 },
    // The renderer (CLAUDE_TUI): "default" keeps claude off the alternate screen, so tmux keeps the history.
    ...(config.claudeTui !== "keep" ? { tui: config.claudeTui } : {}),
  };
  const path = join(config.dataDir, "claude-chat.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return (settingsFile = path);
}
