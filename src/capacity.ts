/**
 * Admission control: how many agent runs may be live at once, and whether there is memory for one more.
 * A small VM running a swarm got OOM-killed (the console included) when several agents started together, so
 * startRun asks here first and answers 429 when the machine is full; POST /api/processes {queue: true} waits instead.
 */
import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { db } from "./db";
import { config } from "./config";

const MB = 2 ** 20;

/** Memory that can be handed to a new process without swapping, in MB (Linux MemAvailable; macOS free + inactive + purgeable pages). */
export function memAvailableMb(): number {
  try {
    if (process.platform === "linux") {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
      if (m) return Math.floor(Number(m[1]) / 1024);
    } else if (process.platform === "darwin") {
      // os.freemem() on macOS counts only free pages, which is near zero on a healthy machine: use the cache too.
      const out = Bun.spawnSync(["vm_stat"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (k: string) => Number(new RegExp(`^Pages ${k}:\\s+(\\d+)`, "m").exec(out)?.[1] ?? 0);
      const n = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
      if (n) return Math.floor((n * page) / MB);
    }
  } catch { /* fall through */ }
  return Math.floor(freemem() / MB);
}

/** Agent runs holding a slot: running (including ones still starting). */
export function liveAgentRuns(): number {
  return db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM runs r JOIN process_types t ON t.name = r.type_name WHERE r.status = 'running' AND t.kind = 'agent'").get()!.n;
}

export function queuedRuns(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs WHERE status = 'queued'").get()!.n;
}

/** Why another agent run can't start right now, or null if it can. */
export function admissionBlocker(): string | null {
  if (config.maxAgentRuns > 0) {
    const n = liveAgentRuns();
    if (n >= config.maxAgentRuns) return `${n} agent runs are live and the limit is ${config.maxAgentRuns} (MAX_AGENT_RUNS)`;
  }
  if (config.minFreeMemMb > 0) {
    const free = memAvailableMb();
    if (free < config.minFreeMemMb) return `only ${free} MB of memory is available and a new agent needs ${config.minFreeMemMb} MB free (MIN_FREE_MEM_MB)`;
  }
  return null;
}

export function capacity() {
  return {
    max_agent_runs: config.maxAgentRuns, live_agent_runs: liveAgentRuns(), queued: queuedRuns(),
    mem_available_mb: memAvailableMb(), min_free_mem_mb: config.minFreeMemMb, blocked: admissionBlocker(),
  };
}
