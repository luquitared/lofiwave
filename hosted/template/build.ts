/**
 * Builds the E2B template every user's machine starts from: E2B's `claude` template (Claude Code installed) plus
 * tmux, Bun and a checkout of lofiwave. lofiwave isn't started here: each machine starts it with its own token
 * (src/machines.ts), so no secret is baked into the template.
 *
 *   E2B_API_KEY=… bun run build-template            # builds `lofiwave` from github.com/luquitared/lofiwave main
 *   LOFIWAVE_REF=some-branch TEMPLATE=lofiwave-dev bun run build-template
 *
 * Existing machines keep the lofiwave they were created with; a new build only reaches new machines.
 */
import { Template, defaultBuildLogger } from "e2b";

const name = process.env.TEMPLATE || "lofiwave";
const ref = process.env.LOFIWAVE_REF || "main";
const repo = process.env.LOFIWAVE_REPO || "https://github.com/luquitared/lofiwave.git";

const template = Template()
  .fromTemplate("claude")
  .aptInstall(["tmux", "unzip", "git", "curl", "ca-certificates"])
  .setUser("user")
  .runCmd("curl -fsSL https://bun.sh/install | bash")
  // ref in the command so a new ref isn't served from the build cache
  .runCmd(`git clone --depth 1 --branch ${ref} ${repo} /home/user/lofiwave && echo built-from-${ref}`)
  .setWorkdir("/home/user");

const info = await Template.build(template, name, {
  cpuCount: Number(process.env.CPU_COUNT || 2),
  memoryMB: Number(process.env.MEMORY_MB || 2048),
  onBuildLogs: defaultBuildLogger(),
});
console.log(`built template ${name}:`, JSON.stringify(info));
