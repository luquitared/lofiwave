/**
 * What the machine has and what the agents on it use, for Advanced → System (GET /api/system/usage): memory, swap,
 * CPU and disk; lofiwave's own process; every live run's whole process tree (claude + node + MCP servers …); agents
 * lofiwave didn't start; and how many more agents fit. One `ps` per call and no other dependencies; macOS and Linux.
 */
import { readFileSync, statfsSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { db, type RunRow, type ProcessTypeRow } from "./db";
import { config } from "./config";
import { listOsProcesses, type OsProcess } from "./procs";
import { memAvailableMb, liveAgentRuns, queuedRuns, admissionBlocker } from "./capacity";

const MB = 2 ** 20;
/** What config.ts assumes one agent needs when it sizes the default MAX_AGENT_RUNS. */
export const ASSUMED_AGENT_MB = 600;

/** Swap from /proc/meminfo text. */
export function parseMeminfoSwap(m: string): { total_mb: number; used_mb: number } | null {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(m)?.[1] ?? NaN);
  const total = kb("SwapTotal"), free = kb("SwapFree");
  return Number.isFinite(total) && Number.isFinite(free) ? { total_mb: Math.round(total / 1024), used_mb: Math.round((total - free) / 1024) } : null;
}

/** Swap from macOS `sysctl -n vm.swapusage`: "total = 3072.00M  used = 1623.44M  free = 1448.56M  (encrypted)". */
export function parseSwapUsage(out: string): { total_mb: number; used_mb: number } | null {
  const mb = (k: string) => { const m = new RegExp(`${k} = ([\\d.]+)([KMG])`).exec(out); return m ? Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 } as Record<string, number>)[m[2]] : NaN; };
  const total = mb("total"), used = mb("used");
  return Number.isFinite(total) && Number.isFinite(used) ? { total_mb: Math.round(total), used_mb: Math.round(used) } : null;
}

/** Swap in MB, or null where there is none to read. */
function swapMb(): { total_mb: number; used_mb: number } | null {
  try {
    if (process.platform === "linux") return parseMeminfoSwap(readFileSync("/proc/meminfo", "utf8"));
    if (process.platform === "darwin") return parseSwapUsage(Bun.spawnSync(["sysctl", "-n", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" }).stdout.toString());
  } catch { /* none */ }
  return null;
}

function diskOf(path: string): { path: string; total_mb: number; free_mb: number } | null {
  try {
    const s = statfsSync(path);
    return { path, total_mb: Math.round((s.blocks * s.bsize) / MB), free_mb: Math.round((s.bavail * s.bsize) / MB) };
  } catch { return null; }
}

/** Whole-machine CPU busy %, from os.cpus() counters since the previous call (null on the first, or within 0.5 s of it). */
let lastCpu: { at: number; busy: number; total: number; pct: number | null } | null = null;
function cpuBusyPct(): number | null {
  let busy = 0, total = 0;
  for (const c of cpus()) { const t = c.times; busy += t.user + t.nice + t.sys + t.irq; total += t.user + t.nice + t.sys + t.irq + t.idle; }
  const at = Date.now();
  if (lastCpu && at - lastCpu.at < 500) return lastCpu.pct;
  const pct = lastCpu && total > lastCpu.total ? Math.round(((busy - lastCpu.busy) / (total - lastCpu.total)) * 1000) / 10 : null;
  lastCpu = { at, busy, total, pct };
  return pct;
}

/**
 * Per-process CPU %. macOS `ps` already reports a recent (decaying) average; Linux `ps` reports the lifetime average,
 * which hides an agent that is busy right now, so there it comes from /proc/<pid>/stat ticks since the last call.
 */
const lastTicks = new Map<number, { at: number; ticks: number; pct: number | null }>();
function linuxCpu(pids: number[]): Map<number, number> {
  const out = new Map<number, number>(), at = Date.now(), seen = new Set<number>();
  for (const pid of pids) {
    try {
      // Fields after the ")" that ends the command name: state is 3rd, utime 14th, stime 15th (in USER_HZ, 100 a second).
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      const ticks = Number(f[11]) + Number(f[12]);
      const prev = lastTicks.get(pid);
      if (!prev || at - prev.at >= 500) {
        const pct = prev ? Math.max(0, Math.round(((ticks - prev.ticks) / 100 / ((at - prev.at) / 1000)) * 1000) / 10) : null;
        lastTicks.set(pid, { at, ticks, pct });
      }
      const pct = lastTicks.get(pid)!.pct;
      if (pct !== null) out.set(pid, pct);
      seen.add(pid);
    } catch { /* gone */ }
  }
  for (const pid of lastTicks.keys()) if (!seen.has(pid)) lastTicks.delete(pid);
  return out;
}

type Tree = { pid: number; procs: number; rss_mb: number; cpu: number; elapsed_sec: number | null };

export async function systemUsage() {
  const os = await listOsProcesses();
  const byPid = new Map(os.map((p) => [p.pid, p]));
  const kids = new Map<number, number[]>();
  for (const p of os) if (p.pid !== p.ppid) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p.pid);
  /** A pid and all its descendants, stopping at `stop` (pids counted somewhere else). */
  const treeOf = (root: number, stop: Set<number> = new Set()): number[] => {
    const out: number[] = [], todo = [root];
    while (todo.length) {
      const pid = todo.pop()!;
      if (out.length > 4096) break;
      out.push(pid);
      for (const c of kids.get(pid) ?? []) if (!stop.has(c)) todo.push(c);
    }
    return out.filter((pid) => byPid.has(pid));
  };

  const runs = db.query<RunRow & { kind: string }, []>(
    "SELECT r.*, t.kind FROM runs r LEFT JOIN process_types t ON t.name = r.type_name WHERE r.status = 'running' AND r.pid IS NOT NULL ORDER BY r.id").all()
    .filter((r) => byPid.has(r.pid!));
  const runRoots = new Set(runs.map((r) => r.pid!));
  const runTrees = runs.map((r) => ({ run: r, pids: treeOf(r.pid!) }));
  // lofiwave itself: this server and what it spawned that isn't a run (terminal attach clients, ps), plus the tmux
  // server that holds the interactive runs' panes (their parent).
  const serverPids = treeOf(process.pid, runRoots).filter((pid) => !/^ps -eo /.test(byPid.get(pid)!.cmd));
  const tmuxPid = runs.map((r) => byPid.get(r.pid!)!.ppid).find((pp) => pp > 1 && pp !== process.pid && /(^|\/)tmux/.test(byPid.get(pp)?.cmd ?? "")) ?? null;

  // Agents running that lofiwave didn't start: matched by their type's `detect`, outside every tree above, and only
  // the topmost match of each tree (claude's own children would match too).
  const ours = new Set([...serverPids, ...runTrees.flatMap((t) => t.pids), ...(tmuxPid ? [tmuxPid] : [])]);
  const detectors = db.query<ProcessTypeRow, []>("SELECT * FROM process_types WHERE kind = 'agent' AND detect != ''").all()
    .map((t) => { try { return { name: t.name, re: new RegExp(t.detect) }; } catch { return null; } }).filter(Boolean) as { name: string; re: RegExp }[];
  const typeOf = (p: OsProcess) => (/^tmux(\s|$)|^ps -eo /.test(p.cmd) ? null : detectors.find((d) => d.re.test(p.cmd))?.name ?? null);
  const matched = new Map<number, string>();
  for (const p of os) { if (ours.has(p.pid)) continue; const t = typeOf(p); if (t) matched.set(p.pid, t); }
  const hasMatchedAncestor = (pid: number) => {
    let cur = byPid.get(pid)?.ppid;
    for (let i = 0; i < 64 && cur && cur > 1; i++) { if (matched.has(cur)) return true; cur = byPid.get(cur)?.ppid; }
    return false;
  };
  const outsideRoots = [...matched.keys()].filter((pid) => !hasMatchedAncestor(pid));
  const outsideTrees = outsideRoots.map((pid) => ({ pid, pids: treeOf(pid, ours) }));

  const linux = process.platform === "linux" ? linuxCpu([...ours, ...outsideTrees.flatMap((t) => t.pids)]) : null;
  const cpuOf = (pid: number) => linux?.get(pid) ?? byPid.get(pid)?.cpu ?? 0;
  const sum = (root: number, pids: number[]): Tree => {
    let kb = 0, cpu = 0;
    for (const pid of pids) { kb += byPid.get(pid)?.rssKb ?? 0; cpu += cpuOf(pid); }
    return { pid: root, procs: pids.length, rss_mb: Math.round(kb / 1024), cpu: Math.round(cpu * 10) / 10, elapsed_sec: byPid.get(root)?.elapsedSec ?? null };
  };
  const total = (ts: Tree[]) => ({
    procs: ts.reduce((n, t) => n + t.procs, 0), rss_mb: ts.reduce((n, t) => n + t.rss_mb, 0), cpu: Math.round(ts.reduce((n, t) => n + t.cpu, 0) * 10) / 10,
  });

  const runOut = runTrees.map(({ run, pids }) => {
    const meta = JSON.parse(run.meta || "{}");
    return { run_id: run.id, type: run.type_name, kind: run.kind ?? "agent", workflow_name: run.workflow_name, group: meta.group ?? null, cwd: run.cwd, started_at: run.started_at, ...sum(run.pid!, pids) };
  });
  const server = sum(process.pid, serverPids);
  const tmux = tmuxPid ? sum(tmuxPid, [tmuxPid]) : null;
  const outside = outsideTrees.map(({ pid, pids }) => ({ type: matched.get(pid)!, cmd: byPid.get(pid)!.cmd.slice(0, 300), ...sum(pid, pids) }));
  const agentRuns = runOut.filter((r) => r.kind === "agent" && r.rss_mb > 0);

  // How many more agents fit: memory over the MIN_FREE_MEM_MB reserve divided by what an agent uses here (the
  // average of the live agent runs, or the assumption the default MAX_AGENT_RUNS was sized with), against the free slots.
  const memTotal = Math.round(totalmem() / MB), memAvail = memAvailableMb();
  const measured = agentRuns.length ? Math.round(agentRuns.reduce((n, r) => n + r.rss_mb, 0) / agentRuns.length) : null;
  const perAgent = measured ?? ASSUMED_AGENT_MB;
  const byMemory = Math.max(0, Math.floor((memAvail - config.minFreeMemMb) / perAgent));
  const live = liveAgentRuns(), queued = queuedRuns();
  const bySlots = config.maxAgentRuns > 0 ? Math.max(0, config.maxAgentRuns - live - queued) : null;
  const canLaunch = bySlots === null ? byMemory : Math.min(byMemory, bySlots);

  return {
    at: Date.now(), platform: process.platform,
    machine: {
      mem_total_mb: memTotal, mem_available_mb: memAvail, mem_used_mb: Math.max(0, memTotal - memAvail), swap: swapMb(),
      cpus: cpus().length, load: loadavg().map((l) => Math.round(l * 100) / 100), cpu_busy_pct: cpuBusyPct(), disk: diskOf(config.dataDir),
    },
    lofiwave: {
      server, tmux, runs: runOut, runs_total: total(runOut),
      total: total([server, ...(tmux ? [tmux] : []), ...runOut]),
    },
    outside, outside_total: total(outside),
    estimate: {
      per_agent_mb: perAgent, per_agent_source: measured === null ? "assumed" : "measured", measured_runs: agentRuns.length,
      min_free_mem_mb: config.minFreeMemMb, by_memory: byMemory,
      max_agent_runs: config.maxAgentRuns, live_agent_runs: live, queued, by_slots: bySlots,
      can_launch: canLaunch, limited_by: bySlots !== null && bySlots < byMemory ? "slots" : bySlots === byMemory ? "both" : "memory",
      blocked: admissionBlocker(),
    },
  };
}
