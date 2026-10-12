/**
 * Approvals from the chat view: permission prompts, AskUserQuestion and plan approval, answered in the browser.
 * See docs/rendered-view.md, "Approvals, questions and plan approval".
 *
 * Interactive claude runs start with `--settings data/claude-approvals.json`, which adds an HTTP
 * `PermissionRequest` hook pointing here (it merges with the user's and the project's hooks). When Claude needs a
 * decision it shows its own dialog in the TUI and calls the hook at the same time. We hold the hook's request open,
 * show a card in the chat view, and reply with the decision when someone answers there. Whichever answer comes
 * first wins: Claude drops the other. When the terminal wins, the card goes away and the held request gets `{}`
 * (no decision), which Claude ignores.
 *
 * A request is let go, with no decision, when:
 *  - someone answers it in the browser (with that decision),
 *  - Claude closes the hook's connection (the run ended, or Claude gave up on it),
 *  - the tool call it was for gets a result in the transcript (see `settleAnswered`),
 *  - Claude's status leaves `waiting` after it was seen waiting (the terminal answered),
 *  - the run stops, or HOLD_MS passes.
 * A restart of lofiwave drops held requests; Claude takes that as a failed hook and its dialog keeps working.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { db, type RunRow } from "../db";
import { ApiError } from "../runner";
import { claudeRegistry } from "../agents";
import { shrinkInput } from "./claude";

/** The hook's timeout, in seconds, and how long we hold a request: a little less, so we answer before Claude gives up. */
const HOOK_TIMEOUT_SEC = 1800;
const HOLD_MS = (HOOK_TIMEOUT_SEC - 20) * 1000;

// ---------------------------------------------------------------- the injected settings

let settingsFile = "";
/** The `--settings` file interactive claude runs get. Written once per server start (the port may have changed). */
export function approvalSettingsPath(): string {
  if (settingsFile) return settingsFile;
  const path = join(config.dataDir, "claude-approvals.json");
  const settings = {
    hooks: {
      PermissionRequest: [{
        hooks: [{
          type: "http",
          url: `http://127.0.0.1:${config.port}/api/hooks/permission`,
          // Only variables listed in allowedEnvVars are interpolated; the run's env has both (see startRun).
          headers: { Authorization: "Bearer $AGENT_CONSOLE_TOKEN", "X-Lofiwave-Run": "$AGENT_CONSOLE_RUN_ID" },
          allowedEnvVars: ["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_RUN_ID"],
          timeout: HOOK_TIMEOUT_SEC,
        }],
      }],
    },
  };
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return (settingsFile = path);
}

// ---------------------------------------------------------------- held requests

export type RequestKind = "permission" | "question" | "plan";

/** What the browser gets. `tool_input` is shortened (a Write's whole file body isn't needed for the card). */
export type ApprovalRequest = {
  id: string; run_id: number; session_id: string; kind: RequestKind;
  tool_name: string; tool_input: any; suggestions: any[]; mode: string;
  created_at: number;
  /** The tool call in the transcript this is about, once found (the hook doesn't say). */
  item_id?: string;
};

type Held = ApprovalRequest & {
  input: any;           // the full tool input, for answers that send it back changed
  pid: number;
  sawWaiting: boolean;
  reply: (body: object) => void;
};

const held = new Map<string, Held>();
const listeners = new Set<(runId: number) => void>();

/** Called with a run id whenever its open requests change. */
export function onRequests(fn: (runId: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = (runId: number) => { for (const fn of listeners) { try { fn(runId); } catch (e) { console.error("[approvals]", e); } } };

const publicOf = ({ input, pid, sawWaiting, reply, ...r }: Held): ApprovalRequest => r;

export function requestsFor(runId: number): ApprovalRequest[] {
  return [...held.values()].filter((r) => r.run_id === runId).sort((a, b) => a.created_at - b.created_at).map(publicOf);
}

/** Let a request go. `decision` undefined: no decision, so the TUI's own dialog decides. */
function release(id: string, decision?: object) {
  const r = held.get(id);
  if (!r) return;
  held.delete(id);
  r.reply(decision ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } } : {});
  changed(r.run_id);
}

const kindOf = (tool: string): RequestKind => (tool === "AskUserQuestion" ? "question" : tool === "ExitPlanMode" ? "plan" : "permission");

/**
 * POST /api/hooks/permission, called by Claude's PermissionRequest hook. Resolves when the request is answered or
 * let go; the body is what Claude reads as the hook's output.
 */
export function permissionHook(req: Request, payload: any): Promise<object> {
  const runId = Number(req.headers.get("x-lofiwave-run"));
  const run = runId ? db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(runId) : null;
  const meta = JSON.parse(run?.meta || "{}");
  // Not one of ours, or not running: no opinion.
  if (!run || run.status !== "running" || !meta.tmux || !run.pid || payload?.hook_event_name !== "PermissionRequest" || typeof payload.tool_name !== "string")
    return Promise.resolve({});
  return new Promise((resolve) => {
    const id = `${runId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const input = payload.tool_input ?? {};
    let timer: ReturnType<typeof setTimeout>;
    const r: Held = {
      id, run_id: runId, session_id: String(payload.session_id ?? ""), kind: kindOf(payload.tool_name),
      tool_name: payload.tool_name, tool_input: shrinkInput(input), input,
      suggestions: Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [],
      mode: String(payload.permission_mode ?? ""), created_at: Date.now(),
      pid: run.pid!, sawWaiting: false,
      reply: (body) => { clearTimeout(timer); resolve(body); },
    };
    held.set(id, r);
    timer = setTimeout(() => release(id), HOLD_MS);
    // Claude hung up: the run ended, or it stopped waiting on us.
    req.signal?.addEventListener("abort", () => release(id));
    watch();
    changed(runId);
  });
}

// ---------------------------------------------------------------- cleanup when the terminal answers

let ticker: ReturnType<typeof setInterval> | null = null;
/** While anything is held, check every second whether Claude is still waiting on it. */
function watch() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!held.size) { clearInterval(ticker!); ticker = null; return; }
    const reg = claudeRegistry(true);
    for (const r of [...held.values()]) {
      const run = db.query<RunRow, [number]>("SELECT status, pid FROM runs WHERE id = ?").get(r.run_id);
      if (!run || run.status !== "running" || run.pid !== r.pid) { release(r.id); continue; }
      const st = reg.byPid.get(r.pid)?.status;
      if (st === "waiting") r.sawWaiting = true;
      // Claude was waiting and isn't any more: someone answered in the terminal (or pressed Esc).
      else if (r.sawWaiting && st && Date.now() - r.created_at > 1500) release(r.id);
    }
  }, 1000);
}

/** JSON with sorted keys: the hook and the transcript don't keep a tool input's keys in the same order. */
const canon = (v: any): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

/**
 * The feed's view of the transcript: link each request to its tool call (by tool name and input, since the hook
 * doesn't give the tool_use id), and let go of requests whose call already has a result (answered in the terminal).
 * `calls`: the active chain's tool calls, newest last. Returns whether a request got linked (releases notify on their own).
 */
export function settleAnswered(runId: number, calls: { id: string; name: string; input: any; done: boolean }[]): boolean {
  let linked = false;
  const taken = new Set([...held.values()].map((r) => r.item_id).filter(Boolean));
  for (const r of held.values()) {
    if (r.run_id !== runId) continue;
    if (r.item_id) {
      const c = calls.find((x) => x.id === r.item_id);
      if (c?.done) release(r.id);
      continue;
    }
    const want = canon(r.tool_input);
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i];
      if (c.done || taken.has(c.id) || c.name !== r.tool_name || canon(c.input) !== want) continue;
      r.item_id = c.id; taken.add(c.id); linked = true;
      break;
    }
  }
  return linked;
}

// ---------------------------------------------------------------- answers from the browser

export type Answer = {
  decision: "allow" | "deny";
  /** permission: index into the request's suggestions ("always allow …"), sent back as updatedPermissions. */
  suggestion?: number;
  /** question: question text → chosen label(s), comma-separated for multiple choices. */
  answers?: Record<string, string>;
  /** plan: the mode to continue in once the plan is approved. */
  mode?: string;
  /** deny: what to tell Claude instead. */
  message?: string;
};

const PLAN_MODES = new Set(["acceptEdits", "default", "auto", "bypassPermissions"]);

/** POST /api/runs/:id/chat/requests/:rid. 409 when it's already gone (answered in the terminal, or timed out). */
export function answerRequest(runId: number, requestId: string, a: Answer): { ok: true } {
  const r = held.get(requestId);
  if (!r || r.run_id !== runId) throw new ApiError(409, "that request isn't open any more (it was answered in the terminal, or it timed out)");
  if (a.decision === "deny") {
    // Claude gets this as the tool's error. The fixed opening is also how the chat view tells a denial from a failure.
    const note = a.message?.trim();
    const lead = r.kind === "plan" ? "The user wants to keep planning" : "The user denied this from lofiwave";
    release(r.id, { behavior: "deny", message: note ? `${lead} and said: ${note}` : `${lead}.` });
    return { ok: true };
  }
  if (a.decision !== "allow") throw new ApiError(400, `decision must be "allow" or "deny"`);
  const decision: any = { behavior: "allow" };
  if (r.kind === "question") {
    const qs: any[] = Array.isArray(r.input.questions) ? r.input.questions : [];
    const answers = a.answers ?? {};
    const missing = qs.filter((q) => typeof q?.question === "string" && !String(answers[q.question] ?? "").trim());
    if (missing.length) throw new ApiError(400, `no answer for: ${missing.map((q) => q.question).join("; ")}`);
    decision.updatedInput = { ...r.input, answers };
  } else if (r.kind === "plan") {
    const mode = a.mode || "";
    if (mode && !PLAN_MODES.has(mode)) throw new ApiError(400, `mode must be one of ${[...PLAN_MODES].join(", ")}`);
    if (mode) decision.updatedPermissions = [{ type: "setMode", mode, destination: "session" }];
    decision.updatedInput = r.input;
  } else if (a.suggestion !== undefined && a.suggestion !== null) {
    const s = r.suggestions[a.suggestion];
    if (!s) throw new ApiError(400, `no suggestion ${a.suggestion} on this request`);
    decision.updatedPermissions = [s];
  }
  release(r.id, decision);
  return { ok: true };
}
