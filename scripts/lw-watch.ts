/**
 * `lw watch`: have lofiwave wait for something and tell this session when it happens (src/watches.ts). Made for
 * agents: instead of ending a turn with "I'll report when it's done" (nothing wakes them) or looping on sleep, they
 * set a watch and end the turn. lofiwave checks it, types a message into the session when the condition is met, when
 * the progress reading stalls, or when the watch expires, and shows it in the Watching tab meanwhile.
 */
import { call, die, parse } from "./lw-keys";

export const WATCH_HELP = `Watches (lofiwave waits on something and messages this session when it happens)
  lw watch <condition> [options] [--then "<note to yourself>"]
    conditions (one):
      --until-exit <pid>             the process exits
      --until-cmd "<command>"        the command exits 0 (run every --every; its output goes in the message)
      --until-file <path>            the file appears (or changes, if it's there already)
      --until-run <run>[:idle|done]  another lofiwave run finishes its turn (idle, the default) or ends
      --in <dur> | --at <time>       a time: 20m, 2h, or an ISO time
    progress and stalls (optional; with only these, it watches for stalls until it expires):
      --progress "<command>"         its last line is the progress reading, shown in the Watching tab
      --progress-file <path>         the file's size and time are the reading (e.g. a background shell's .output)
      --stall <dur>                  tell me when the reading hasn't changed this long (default 30m with a progress)
    --every <dur> (default 1m) · --for <dur> (expires after; default 24h, max 7d) · --label "<name>"
    --run <id> (default: this session's run) · --json
  lw watch ls [--all] [--run <id>]   this machine's watches (active and recent)
  lw watch show <id>                 one watch and its log
  lw watch rm <id>                   stop it
  lw watch fire <id>                 deliver its message now
  lw watch stats [--days n]          how often stall detection fired, cleared, nearly fired
`;

const RUN = process.env.AGENT_CONSOLE_RUN_ID || "";

/** 90s, 20m, 2h, 1d, 1h30m → seconds. */
export function durSec(s: string, flag: string): number {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  let total = 0, rest = t;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)/g)) { total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d"]; rest = rest.replace(m[0], ""); }
  if (!total || rest.trim()) die(`--${flag} wants a duration like 90s, 20m, 2h or 1h30m, not "${s}"`);
  return Math.round(total);
}
const ago = (ms: number | null) => { if (!ms) return "never"; const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

function line(w: any): string {
  const state = w.status === "active" ? (w.stalled ? "STALLED" : "watching") : w.status === "delivering" ? "telling the agent" : `${w.status}${w.outcome && w.outcome !== w.status ? ` (${w.outcome})` : ""}`;
  const bits = [`#${w.id}`, `run ${w.run_id}`, state, w.label ? `"${w.label}"` : "", `until ${w.until}`].filter(Boolean).join(" · ");
  const prog = w.progress_kind ? `\n    progress: ${w.progress ? `"${w.progress}"` : "(no reading yet)"}${w.progress_at ? `, changed ${ago(w.progress_at)}` : ""}${w.stall_sec ? ` · stall after ${dur(w.stall_sec)}` : ""}` : "";
  const err = w.check_error ? `\n    last check failed: ${w.check_error}` : "";
  return `${bits}\n    checks: ${w.checks}, last ${ago(w.last_check_at)} · every ${dur(w.every_sec)}${prog}${err}`;
}

export async function watchCommand(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") { console.log(WATCH_HELP); return; }
  if (sub === "ls" || sub === "list") {
    const { flags } = parse(argv.slice(1), ["all", "json"]);
    const q = new URLSearchParams();
    if (flags.all) q.set("all", "1");
    if (flags.run) q.set("run", flags.run);
    const ws = await call("GET", `/watches${q.size ? `?${q}` : ""}`);
    if (flags.json) return console.log(JSON.stringify(ws, null, 2));
    console.log(ws.length ? ws.map(line).join("\n") : "No watches.");
    return;
  }
  if (sub === "show") {
    const { pos, flags } = parse(argv.slice(1), ["json"]);
    if (!pos[0]) die("which watch? (lw watch ls)");
    const w = await call("GET", `/watches/${Number(pos[0])}`);
    if (flags.json) return console.log(JSON.stringify(w, null, 2));
    console.log(line(w));
    if (w.message) console.log(`    then: ${w.message.split("\n")[0]}`);
    for (const e of w.events.slice(0, 30)) console.log(`  ${new Date(e.at).toISOString().slice(5, 19).replace("T", " ")}  ${e.kind}  ${JSON.stringify(e.detail)}`);
    return;
  }
  if (sub === "rm" || sub === "stop" || sub === "cancel") {
    if (!argv[1]) die("which watch? (lw watch ls)");
    const w = await call("DELETE", `/watches/${Number(argv[1])}`);
    console.log(`watch #${w.id}: ${w.status}`);
    return;
  }
  if (sub === "fire") {
    if (!argv[1]) die("which watch? (lw watch ls)");
    const w = await call("POST", `/watches/${Number(argv[1])}/fire`);
    console.log(`watch #${w.id}: fired; its message goes to run ${w.run_id} once it's free`);
    return;
  }
  if (sub === "stats") {
    const { flags } = parse(argv.slice(1));
    console.log(JSON.stringify(await call("GET", `/watches/stats${flags.days ? `?days=${Number(flags.days)}` : ""}`), null, 2));
    return;
  }
  // lw watch [add] --until-… : make one.
  const { flags } = parse(sub === "add" ? argv.slice(1) : argv, ["json"]);
  const run = flags.run || RUN;
  if (!run) die("which run? Inside a lofiwave session it's this one; elsewhere pass --run <id>");
  const b: Record<string, unknown> = { run_id: Number(run), label: flags.label, message: flags.then ?? flags.message };
  if (flags["until-exit"]) b.until_exit = Number(flags["until-exit"]);
  if (flags["until-cmd"]) b.until_cmd = flags["until-cmd"];
  if (flags["until-file"]) b.until_file = flags["until-file"];
  if (flags["until-run"]) b.until_run = flags["until-run"];
  if (flags.in) b.in_sec = durSec(flags.in, "in");
  if (flags.at) b.at = /^\d+$/.test(flags.at) ? Number(flags.at) : flags.at;
  if (flags.progress) b.progress_cmd = flags.progress;
  if (flags["progress-file"]) b.progress_file = flags["progress-file"];
  if (flags.stall) b.stall_sec = durSec(flags.stall, "stall");
  if (flags.every) b.every_sec = durSec(flags.every, "every");
  if (flags.for) b.for_sec = durSec(flags.for, "for");
  const known = ["run", "label", "then", "message", "until-exit", "until-cmd", "until-file", "until-run", "in", "at", "progress", "progress-file", "stall", "every", "for", "json"];
  const unknown = Object.keys(flags).filter((k) => !known.includes(k));
  if (unknown.length) die(`unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `--${k}`).join(", ")} (lw watch help)`);
  const w = await call("POST", "/watches", b);
  if (flags.json) return console.log(JSON.stringify(w, null, 2));
  console.log(`watch #${w.id} set: until ${w.until}${w.stall_sec ? `, or no progress for ${dur(w.stall_sec)}` : ""}; checked every ${dur(w.every_sec)}, expires in ${dur(Math.round((w.expires_at - Date.now()) / 1000))}.`);
  console.log(`You'll get a message starting "[lofiwave watch #${w.id}" in this session. You can end your turn now; \`lw watch rm ${w.id}\` stops it.`);
}
