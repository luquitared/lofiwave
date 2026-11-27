/**
 * What every run on this machine gets from lofiwave itself: the `lw` command on its PATH (a shim in DATA_DIR/bin that
 * runs scripts/lw.ts with lofiwave's own bun), and, for agents, a few lines saying where they are running and which
 * commands they have (lw, ccx). The lines go in with the run config's instructions (--append-system-prompt for
 * claude, developer_instructions for codex). LOFIWAVE_AGENT_CONTEXT=off leaves them out; `lw` stays on the PATH.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { runHooks } from "./runner";
import { ccxInstalled } from "./ccx";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * DATA_DIR/bin/lw. A run has AGENT_CONSOLE_URL and _TOKEN; the shim's defaults are for your own terminal
 * (ln -s <data>/bin/lw ~/.local/bin/lw): this console, and its token file when the token was generated.
 */
export function installCli(): string {
  const dir = join(config.dataDir, "bin");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "lw");
    writeFileSync(file, [
      "#!/bin/sh",
      `: "\${LW_DEFAULT_URL:=http://127.0.0.1:${config.port}}"`,
      config.tokenFile ? `: "\${LW_TOKEN_FILE:=${config.tokenFile.replace(/["$`\\]/g, "\\$&")}}"` : "",
      "export LW_DEFAULT_URL LW_TOKEN_FILE",
      `exec ${sh(process.execPath)} ${sh(join(config.root, "scripts", "lw.ts"))} "$@"`,
      "",
    ].filter((l) => l !== "").join("\n") + "\n");
    chmodSync(file, 0o755);
  } catch (e) { console.warn("[lw] could not install the lw command:", e); }
  return dir;
}

/** The lines an agent run starts with. Short: it is in every session's system prompt. */
export function agentContext(): string {
  const lines = [
    "## lofiwave",
    "You are running inside lofiwave, a console on this machine that starts and watches coding agents. People may be following this session in a browser and typing to it.",
    "- `lw` is lofiwave's command line, on your PATH (`lw help`). `lw keys` holds this machine's API keys and secrets, encrypted: `lw keys search <words>` finds one, `lw keys env <name> -- <command>` runs a command with it, `lw keys write <name> --to .env` puts it in a file, `lw keys add` / `lw keys import` saves a new one with a note. Use these instead of printing a key (what you print stays in this conversation's transcript), and look there before asking someone for a key.",
    "- Waiting on something (a build, CI, a deploy, a job, a file, another run)? Don't end your turn saying you'll report back (nothing wakes you) and don't loop on sleep: `lw watch --until-cmd \"<check>\" --then \"<what to do next>\"` (or `--until-exit <pid>`, `--until-file`, `--until-run <run>`, `--in 20m`; add `--progress \"<cmd>\" --stall 30m` to hear about stalls), then end your turn. lofiwave messages you when it happens, and people see it in the Watching tab.",
  ];
  if (ccxInstalled()) lines.push("- `ccx` searches the Claude Code conversations on this machine: `ccx search \"<words>\"`, then `ccx show <session> --line <n>`. Use it to find how something was done or decided before.");
  return lines.join("\n");
}

/** Hook into run starts. Composes with a context hook set before this one (src/autopilot's, when it is there). */
export function registerLw() {
  const bin = installCli();
  const prev = runHooks.context;
  runHooks.context = (meta, o) => {
    const p = prev?.(meta, o) ?? null;
    const path = p?.env.PATH ?? process.env.PATH ?? "";
    const env = { ...(p?.env ?? {}), PATH: path.split(":").includes(bin) ? path : `${bin}:${path}` };
    const mine = o.agent && config.agentContext ? agentContext() : "";
    return { instructions: [mine, p?.instructions ?? ""].filter((x) => x.trim()).join("\n\n"), env };
  };
}
