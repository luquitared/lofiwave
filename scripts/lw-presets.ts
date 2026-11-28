/**
 * `lw presets`: the prompts sessions start with (src/presets.ts), and this machine's defaults. `lw restart` starts a
 * session again, optionally with other presets.
 */
import { readFileSync } from "node:fs";
import { call, die, parse } from "./lw-keys";

export const PRESETS_HELP = `Presets (prompts a session starts with; several are joined in order)
  lw presets [list] [--json]       every preset, and which ones new sessions on this machine start with
  lw presets show <name>           its full prompt
  lw presets add <name> --prompt-file <path> | --prompt - (stdin) | --prompt "<text>" [--description "…"]
  lw presets set <name> [--prompt… as add] [--description "…"]
                                   change one; for a built-in one this saves your version over it
  lw presets rm <name>             delete one made here; a built-in one goes back to its own text
  lw presets default [<name>...] [--none] [--env]
                                   show or set the presets new sessions start with (--none: no presets,
                                   --env: back to LOFIWAVE_DEFAULT_PRESETS)
  lw presets view [chat|terminal|--env]
                                   how sessions open in the browser
  lw restart <run> [--presets a,b | --no-presets] [--fresh]
                                   start a session again with its presets or these; an interactive session
                                   keeps its conversation unless --fresh
`;

const enc = encodeURIComponent;

async function promptOf(flags: Record<string, string>): Promise<string | undefined> {
  if (flags["prompt-file"]) { try { return readFileSync(flags["prompt-file"], "utf8"); } catch (e: any) { die(`can't read ${flags["prompt-file"]}: ${e?.message ?? e}`); } }
  if (flags.prompt === "-") return await new Response(Bun.stdin.stream()).text();
  return flags.prompt;
}

function printList(r: any) {
  const w = Math.max(...r.presets.map((p: any) => p.name.length), 4);
  for (const p of r.presets) {
    const on = r.defaults.names.includes(p.name) ? "*" : " ";
    const from = p.source === "builtin" ? (p.edited ? "built-in, edited" : "built-in") : p.source === "file" ? (p.edited ? "folder, edited" : "folder") : "custom";
    console.log(`${on} ${p.name.padEnd(w)}  ${from.padEnd(16)}  ${p.description}`);
  }
  console.log(`\n* = new sessions start with it (${r.defaults.names.length ? r.defaults.names.join(", ") : "none"}; ${r.defaults.from === "settings" ? "set on this machine" : r.defaults.from === "env" ? "from LOFIWAVE_DEFAULT_PRESETS" : "nothing set"}). Sessions open in ${r.default_view.view}.`);
}

export async function presetsCommand(argv: string[]) {
  const [sub = "list", ...rest] = argv;
  const { pos, flags } = parse(rest, ["json", "none", "env"]);
  switch (sub) {
    case "list": case "ls": {
      const r = await call("GET", "/presets");
      if (flags.json) console.log(JSON.stringify(r, null, 2)); else printList(r);
      return;
    }
    case "show": {
      if (!pos[0]) die("usage: lw presets show <name>");
      const p = await call("GET", `/presets/${enc(pos[0])}`);
      if (flags.json) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log(`${p.name}${p.description ? ` — ${p.description}` : ""}\n\n${p.prompt}`);
      return;
    }
    case "add": case "set": {
      if (!pos[0]) die(`usage: lw presets ${sub} <name> --prompt-file <path> | --prompt "<text>"`);
      const prompt = await promptOf(flags);
      if (sub === "add" && !prompt?.trim()) die("a preset needs a prompt: --prompt-file <path>, --prompt - (stdin) or --prompt \"<text>\"");
      const body = { ...(prompt !== undefined ? { prompt } : {}), ...(flags.description !== undefined ? { description: flags.description } : {}) };
      const p = sub === "add" ? await call("POST", "/presets", { name: pos[0], ...body }) : await call("PUT", `/presets/${enc(pos[0])}`, body);
      console.log(`${sub === "add" ? "added" : "saved"} ${p.name}`);
      return;
    }
    case "rm": case "delete": {
      if (!pos[0]) die("usage: lw presets rm <name>");
      const r = await call("DELETE", `/presets/${enc(pos[0])}`);
      console.log(r.reset ? `${pos[0]} is back to its own text` : `deleted ${pos[0]}`);
      return;
    }
    case "default": case "defaults": {
      if (flags.none || flags.env || pos.length) {
        const names = flags.env ? null : flags.none ? [] : pos.flatMap((p) => p.split(",")).filter(Boolean);
        await call("PUT", "/settings", { default_presets: names });
      }
      const r = await call("GET", "/presets");
      console.log(`new sessions start with: ${r.defaults.names.length ? r.defaults.names.join(", ") : "no presets"} (${r.defaults.from === "settings" ? "set on this machine" : r.defaults.from === "env" ? "from LOFIWAVE_DEFAULT_PRESETS" : "nothing set"})`);
      return;
    }
    case "view": {
      if (flags.env || pos[0]) {
        if (pos[0] && pos[0] !== "chat" && pos[0] !== "terminal") die("usage: lw presets view [chat|terminal|--env]");
        await call("PUT", "/settings", { default_view: flags.env ? null : pos[0] });
      }
      const r = await call("GET", "/presets");
      console.log(`sessions open in ${r.default_view.view}${r.default_view.from === "env" ? " (from LOFIWAVE_DEFAULT_VIEW)" : r.default_view.from === "settings" ? " (set on this machine)" : ""}`);
      return;
    }
    default:
      die(`unknown presets command "${sub}" (lw help)`);
  }
}

/**
 * Start a session again with its presets, or other ones. An interactive agent session with a recorded conversation is
 * stopped and reopened (the conversation goes on, with the new instructions); anything else is restarted afresh.
 */
export async function restartCommand(argv: string[]) {
  const { pos, flags } = parse(argv, ["no-presets", "fresh"]);
  const id = Number(pos[0]);
  if (!Number.isInteger(id) || id <= 0) die("usage: lw restart <run id> [--presets a,b | --no-presets] [--fresh]");
  const presets = flags["no-presets"] ? [] : flags.presets !== undefined ? flags.presets.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const body = presets === undefined ? {} : { presets };
  const run = await call("GET", `/runs/${id}`);
  let r: any;
  if (run.session_id && run.meta?.interactive && !flags.fresh) {
    if (run.status === "running") await call("POST", `/runs/${id}/kill`);
    r = await call("POST", `/runs/${id}/sessions/${encodeURIComponent(run.session_id)}/resume`, body);
  } else r = await call("POST", `/runs/${id}/restart`, body);
  console.log(`run ${id} is now run ${r.id}${r.meta?.presets?.length ? `, with ${r.meta.presets.join(", ")}` : ", with no presets"}${run.session_id && run.meta?.interactive && !flags.fresh ? " (same conversation)" : ""}`);
}
