# Issues

Open work, newest first within each status. One heading per issue; close it by moving it to
**Closed** with the commit that fixed it.

## Open

### #8 Hosted lofiwave: what's left after the first control plane
*Opened 2026-10-22 · `hosted/`, see `hosted/README.md`*

People sign in with Google and get their own E2B sandbox running lofiwave, behind a proxy that holds the
sandbox's traffic token and lofiwave's token. Sign-in, machine creation, the proxied UI and terminal, and waking a
paused machine all work (`hosted/test/e2e.ts`, and by hand in Chrome). Left:

- [ ] Google sign-in against a real OAuth client (only the dev sign-in has run).
- [ ] Cron workflows: lofiwave's scheduler only runs while the machine is awake. The control plane should read
      each machine's schedules and wake it in time (or keep machines with schedules awake).
- [ ] Pausing while an agent is mid-turn: the keeper extends machines whose agents are `working`, but a turn that
      starts between two keeper ticks just before the timeout can still be paused, and its API connection drops.
- [ ] Remote Control from the Claude app can't wake a paused machine: it doesn't come through the proxy.
- [ ] API keys made on a machine's *Connect* page don't work from outside: every request needs the browser
      cookie. Needs per-machine hostnames (or a key prefix the proxy can route on).
- [ ] lofiwave updates: machines keep the lofiwave they were created with. Pull + restart on wake, or a button.
- [ ] Billing and abuse: nothing but `MAX_USERS` and `ALLOW_EMAILS`. Card on file / metered machine-hours /
      per-user caps before opening sign-ups.
- [ ] One machine per user; no way to delete your machine from the UI.
- [ ] The keeper reads only the first page of E2B's sandbox list.
- [ ] Ask E2B: paused-storage pricing, and whether paused sandboxes count toward the concurrency limit.

### #3 Chat view, toggleable with the terminal
*Opened 2026-10-09 · designed in [`docs/rendered-view.md`](docs/rendered-view.md), nothing built*

An interactive run gets a second view: the same live session as messages, tool cards, diffs and images,
with a composer that takes uploads and answers approvals. You can switch between it and the xterm view at
any time. The TUI in tmux stays the only process running the session; the chat view tails the transcript
and types into the pane. It also ends the terminal scrolling back-and-forth (`81e63a9` → `ed62c8d` →
`ad17cb8`), because the chat view scrolls separately in each browser.

Six phases, one PR each (in the doc). First, the five spikes at the end of the doc:
- Does pasting an image path into a live TUI with `tmux paste-buffer -p` attach it?
- Do `--settings` hooks merge with the user's own hooks or replace them?
- Do HTTP hooks need `allowedHttpHookUrls`, and can their headers carry the token?
- What does `MessageDisplay` send, and how often?
- Is a Codex TUI's rollout written item by item, and does pasting an image path work there?

### #2 Codex: untested paths
*Opened 2026-10-09 · audit against `codex-cli 0.153.4`; see #1 for what's confirmed broken*

Never exercised end to end:
- [ ] Resume from the UI
- [ ] Workflows and cron with the codex type
- [ ] Restarting a Codex run
- [ ] Cleaning up Codex's child processes when a run is killed
- [ ] `codex exec resume`
- [ ] Image attachment (`exec -i`, and pasting a path into the TUI)
- [ ] The xterm view with Codex (scrolling, resizing)
- [ ] Approval and trust menus on the phone view
- [ ] Codex on Linux
- [ ] The Agents tab while the Codex Desktop app is running
- [ ] A clean exit: every interactive Codex run so far ended as "killed"
- [ ] Workflow runs never close on their own: Codex has no idle state like claude's session registry, so
      they stay open until stopped or `timeout_sec`

Waiting to break:
- [ ] Rollouts older than 7 days may be compressed to `.jsonl.zst`, and our lookups match only `.jsonl`.
- [ ] The session-id regex breaks with `--color always`.
- [ ] MCP startup warnings appear in every tmux Codex run (possibly the reduced environment in tmux).

### #1 Codex: broken on codex-cli 0.153
*Opened 2026-10-09 · from `--help`, the generated protocol schemas, existing rollouts and runs 9–24; no model was run*

Headless one-off runs work. These don't:
- [ ] `--full-auto` was removed from Codex (`codex exec --full-auto` → "unexpected argument"), but we still
      recommend it in the codex type description (`src/db.ts`), the extra-args placeholder
      (`public/app.js:389`) and README lines 147 and 260 (the nightly workflow example).
- [ ] Long headless runs lose their session: we read only the last 64KB of the log, but `session id:` is
      printed at the top (run 24: an 810KB log, no session recorded). Use `codex exec --json` and its
      `thread.started` event instead.
- [ ] Session titles often come out as "# AGENTS.md instructions for …" instead of the user's first message.
- [ ] The "Do you trust this directory?" prompt blocks interactive starts in untrusted folders, and the
      starting prompt then sits unsent (run 15).
- [ ] Session discovery takes any new rollout in the same cwd, including another Codex TUI, a VS Code or
      Desktop session, or a subagent. Use `~/.codex/state_5.sqlite` (`threads`, opened `immutable=1`) or
      `lsof` on the pane's processes.
- [ ] Resume is recorded as done without checking that Codex actually resumed.
- [ ] Codex processes lofiwave didn't start show no session info, and the detection regex probably also
      catches `codex app-server` and the Desktop app's helper processes.
- [ ] Codex has no equivalent of `CLAUDE_PERMISSION_MODE`, so headless runs are silently read-only.
- [ ] No Remote Control equivalent. Codex now ships `remote-control`, `app-server daemon`, TUI `--remote`
      and `queue`, and we use none of them.

## Closed
