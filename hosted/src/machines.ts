/**
 * A user's machine: one E2B sandbox from the `lofiwave` template (template/build.ts), running lofiwave on 7770.
 *
 * - Created with `onTimeout: "pause"` + `autoResume: true`: E2B pauses it (memory and disk kept) when its timeout
 *   runs out, and the next request to its URL resumes it in well under a second, tmux sessions and all.
 * - Created with `allowPublicTraffic: false`: its URLs answer only requests carrying its traffic token, and a
 *   request without one doesn't wake it. Only this server holds that token and lofiwave's AUTH_TOKEN.
 * - Activity doesn't extend the timeout on E2B's side, so we do: on proxied requests (`touch`), and from the keeper
 *   while an agent in it is working, even with nobody watching.
 */
import { Sandbox, NotFoundError } from "e2b";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { db, getUser, now, type UserRow } from "./db";

export const PORT = 7770;
const APP = "lofiwave-hosted";
const api = { apiKey: config.e2bApiKey };
const log = (...a: unknown[]) => console.log("[machines]", ...a);

/** The upstream base URL and the headers that get a request into this user's lofiwave. */
export function upstream(u: UserRow) {
  return {
    base: `https://${PORT}-${u.sandbox_id}.e2b.app`,
    headers: { "e2b-traffic-access-token": u.traffic_token!, authorization: `Bearer ${u.lw_token}` },
  };
}

/** The lofiwave settings written into the machine's ~/lofiwave/.env (scripts/start.sh loads it). */
const lofiwaveEnv = (token: string) => [
  `AUTH_TOKEN=${token}`, "HOST=0.0.0.0", `PORT=${PORT}`, "OPEN_TERMINAL=none",
  ...(config.claudePermissionMode ? [`CLAUDE_PERMISSION_MODE=${config.claudePermissionMode}`] : []),
].join("\n") + "\n";

const creating = new Map<number, Promise<void>>();

/** Make sure the user has a machine; starts creating one if not. Resolves when it's ready (or failed). */
export function ensureMachine(userId: number): Promise<void> {
  const u = getUser(userId)!;
  if (u.machine_status === "ready") return Promise.resolve();
  let p = creating.get(userId);
  if (!p) {
    p = create(u).finally(() => creating.delete(userId));
    creating.set(userId, p);
  }
  return p;
}

async function create(u: UserRow) {
  const set = (fields: Partial<UserRow>) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(fields) as any[]), u.id);
  };
  set({ machine_status: "creating", machine_error: null });
  let sb: Sandbox | undefined;
  try {
    const t0 = now();
    sb = await Sandbox.create(config.template, {
      ...api,
      timeoutMs: config.idleSec * 1000,
      lifecycle: { onTimeout: "pause", autoResume: true },
      network: { allowPublicTraffic: false },
      metadata: { app: APP, user: String(u.id), email: u.email },
    });
    const token = `lwh_${randomBytes(24).toString("base64url")}`;
    // Saved before anything else can fail, so a half-made machine is never lost track of.
    set({ sandbox_id: sb.sandboxId, traffic_token: sb.trafficAccessToken ?? null, lw_token: token });
    await sb.files.write("/home/user/lofiwave/.env", lofiwaveEnv(token));
    await sb.commands.run("chmod 600 ~/lofiwave/.env");
    await sb.commands.run("cd ~/lofiwave && nohup scripts/start.sh > ~/lofiwave.log 2>&1 &", { background: true });
    await waitForLofiwave(sb);
    set({ machine_status: "ready" });
    log(`user ${u.id}: machine ${sb.sandboxId} ready in ${now() - t0} ms`);
  } catch (e: any) {
    log(`user ${u.id}: creating a machine failed:`, e?.message ?? e);
    set({ machine_status: "error", machine_error: String(e?.message ?? e).slice(0, 500) });
    if (sb) await sb.kill().catch(() => {});
  }
}

async function waitForLofiwave(sb: Sandbox) {
  for (let i = 0; i < 60; i++) {
    const r = await sb.commands.run(`curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/api`).catch(() => null);
    if (r?.stdout.trim() === "200") return;
    await Bun.sleep(500);
  }
  const logTail = await sb.commands.run("tail -20 ~/lofiwave.log").catch(() => null);
  throw new Error(`lofiwave didn't start: ${logTail?.stdout ?? ""}`);
}

export type MachineState = "none" | "creating" | "error" | "running" | "paused" | "missing";

/** Where the user's machine is. `missing`: we have a sandbox id but E2B doesn't (killed outside of us). */
export async function machineState(u: UserRow): Promise<MachineState> {
  if (u.machine_status !== "ready") return u.machine_status;
  try {
    return (await Sandbox.getInfo(u.sandbox_id!, api)).state as "running" | "paused";
  } catch (e) {
    if (e instanceof NotFoundError) return "missing";
    throw e;
  }
}

/** Forget a machine E2B no longer has, so the next visit creates a new one. */
export function forgetMachine(userId: number) {
  db.prepare("UPDATE users SET sandbox_id = NULL, traffic_token = NULL, lw_token = NULL, machine_status = 'none', machine_error = NULL WHERE id = ?").run(userId);
}

/** Delete the user's machine for good (its disk goes with it). */
export async function destroyMachine(userId: number) {
  const u = getUser(userId);
  if (u?.sandbox_id) await Sandbox.kill(u.sandbox_id, api).catch(() => {});
  forgetMachine(userId);
}

// ---- keeping machines awake while they're used

const extendedAt = new Map<string, number>();

/** Push the machine's pause back to idleSec from now (at most once every 30 s per machine). */
async function extend(sandboxId: string) {
  if (now() - (extendedAt.get(sandboxId) ?? 0) < 30_000) return;
  extendedAt.set(sandboxId, now());
  // A paused machine refuses this; the request that's being proxied resumes it, and the next touch extends it.
  await Sandbox.setTimeout(sandboxId, config.idleSec * 1000, api).catch(() => extendedAt.delete(sandboxId));
}

const seenAt = new Map<number, number>();

/** Someone just used the machine through the proxy (every request and keystroke: both writes are throttled). */
export function touch(u: UserRow) {
  if (u.sandbox_id) void extend(u.sandbox_id);
  if (now() - (seenAt.get(u.id) ?? 0) < 60_000) return;
  seenAt.set(u.id, now());
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), u.id);
}

/** True if any agent on the machine is working (a live session whose status is `working`, or any headless run). */
export async function busy(u: UserRow): Promise<boolean> {
  const up = upstream(u);
  const r = await fetch(`${up.base}/api/console`, { headers: up.headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return false;
  const c = await r.json() as { live?: { sessions?: { status?: string }[] }[]; headless?: unknown[] };
  return (c.headless?.length ?? 0) > 0 || (c.live ?? []).some((run) => (run.sessions ?? []).some((s) => s.status === "working"));
}

/**
 * Every keeperIntervalMs: for each machine E2B lists as running, extend it if an agent in it is working. Only
 * running machines are asked (asking a paused one would wake it); one that pauses between the listing and the
 * question gets woken by it, and pauses again idleSec later.
 */
export function startKeeper() {
  const tick = async () => {
    try {
      const running = await Sandbox.list({ ...api, query: { metadata: { app: APP }, state: ["running"] } }).nextItems();
      for (const s of running) {
        const u = db.query<UserRow, [string]>("SELECT * FROM users WHERE sandbox_id = ?").get(s.sandboxId);
        if (!u || u.machine_status !== "ready") continue;
        if (await busy(u).catch(() => false)) await extend(s.sandboxId);
      }
    } catch (e: any) {
      log("keeper:", e?.message ?? e);
    }
  };
  setInterval(tick, config.keeperIntervalMs);
}
