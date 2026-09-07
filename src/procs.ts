/**
 * Cross-platform OS process discovery and termination.
 * Linux is the primary target; macOS and Windows are best-effort.
 */
import { readlinkSync } from "node:fs";

export type OsProcess = {
  pid: number;
  ppid: number;
  user: string;
  cmd: string;
  elapsedSec: number | null;
  rssKb: number | null;
  cpu: number | null;
  cwd: string | null;
};

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

/** Parse ps etime: [[dd-]hh:]mm:ss */
function parseEtime(s: string): number | null {
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + Number(mi) * 60 + Number(se);
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

async function listUnix(): Promise<OsProcess[]> {
  const out = await run(["ps", "-eo", "pid=,ppid=,etime=,rss=,pcpu=,user=,args="]);
  const procs: OsProcess[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]), ppid: Number(m[2]), elapsedSec: parseEtime(m[3]), rssKb: Number(m[4]),
      cpu: Number(m[5]), user: m[6], cmd: m[7], cwd: null,
    });
  }
  return procs;
}

async function listWindows(): Promise<OsProcess[]> {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name,WorkingSetSize,CreationDate | ConvertTo-Json -Compress";
  const out = await run(["powershell", "-NoProfile", "-Command", script]);
  let arr: any[] = [];
  try { arr = JSON.parse(out); if (!Array.isArray(arr)) arr = [arr]; } catch { return []; }
  const nowMs = Date.now();
  return arr.map((p) => {
    let elapsed: number | null = null;
    const cd = p.CreationDate;
    if (typeof cd === "string") {
      const m = cd.match(/\/Date\((\d+)\)\//);
      if (m) elapsed = Math.round((nowMs - Number(m[1])) / 1000);
    }
    return {
      pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), user: "",
      cmd: p.CommandLine || p.Name || "", elapsedSec: elapsed,
      rssKb: p.WorkingSetSize ? Math.round(p.WorkingSetSize / 1024) : null, cpu: null, cwd: null,
    };
  });
}

export async function listOsProcesses(): Promise<OsProcess[]> {
  return isWin ? listWindows() : listUnix();
}

/** Best-effort working directory lookup for one pid. */
export async function cwdOf(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    if (isMac) {
      const out = await run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = out.split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : null;
    }
  } catch { /* permission denied or gone */ }
  return null;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export async function killPid(pid: number, force = false): Promise<void> {
  if (isWin) {
    const p = Bun.spawn(["taskkill", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return;
  }
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

/** Kill a process and all of its descendants (children first). */
export async function killTree(pid: number, force = false): Promise<void> {
  if (isWin) return killPid(pid, force);
  const procs = await listOsProcesses();
  const children = new Map<number, number[]>();
  for (const p of procs) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p.pid);
  const order: number[] = [];
  const walk = (id: number) => { for (const c of children.get(id) ?? []) walk(c); order.push(id); };
  walk(pid);
  let firstErr: unknown = null;
  for (const id of order) {
    try { await killPid(id, force); } catch (e) { if (id === pid) firstErr = e; }
  }
  if (firstErr) throw firstErr;
}
