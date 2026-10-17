# Issues

Open work, newest first within each status. One heading per issue; close it by moving it to
**Closed** with the commit that fixed it.

## Open

### #4 tmux targets match by prefix: a dead run's commands can reach another session
*Opened 2026-10-17 · seen while testing #1*

`tmux … -t ac-4` picks any session whose name *starts with* `ac-4` when there's no `ac-4`, so once run 4's
session is gone, commands meant for it go to `ac-42` (here, `capture-pane` read run 42's screen). The runner, the
screen and keys endpoints and the chat composer all target `ac-<id>` this way (about 20 call sites), so a stale
browser could type into the wrong run. Fix: exact targets, `=ac-4` for a session and `=ac-4:` for its pane.

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
- [x] The session-id regex breaks with `--color always`. (ANSI codes are stripped first; see #1.)
- [ ] MCP startup warnings appear in every tmux Codex run (possibly the reduced environment in tmux).

### #1 Codex: broken on codex-cli 0.153
*Opened 2026-10-09 · from `--help`, the generated protocol schemas, existing rollouts and runs 9–24; no model was run ·
all but the last fixed 2026-10-17 against codex-cli 0.162.1, end to end*

Headless one-off runs work. These don't:
- [x] `--full-auto` was removed from Codex, but we still recommended it. The description, the extra-args
      placeholder and the README now say `--sandbox workspace-write`; existing built-in rows are updated.
- [x] Long headless runs lose their session (we read only the last 64KB of the log). Now the first 64KB is read
      too, with ANSI codes stripped, and `--json`'s `thread.started` is understood; failing both, Codex's index.
      The log stays readable: no `--json` by default.
- [x] Session titles came out as "# AGENTS.md instructions for …". Titles now come from Codex's index (its own short
      name, and the first message), and the rollout fallback skips AGENTS.md like the other injected context.
- [x] The trust prompt and the starting prompt: on 0.162.1 the prompt is sent once "Trust and continue" is
      answered (checked), so nothing sits unsent. The trust prompt itself is answered in the terminal, as
      Claude's is.
- [x] Session discovery took any new rollout in the same cwd. **0.16x runs the TUI's threads in a shared `codex
      app-server` daemon** (started by the first TUI, then on its own), so `lsof` on the pane finds nothing; and
      `immutable=1` reads a stale index (it skips the WAL, where the newest threads are). Runs now read
      `~/.codex/state_<n>.sqlite` read-only: a TUI's thread is the one with `originator = codex-tui`, in the run's
      folder, created after it started, not claimed by another run, preferring one whose first message is our
      prompt; `exec`'s has `source = exec`; subagents are skipped. Two TUIs started 3s apart in one folder got the
      right thread each.
- [x] Resume was recorded as done without checking. It's now "resume requested" until the index shows the thread
      used after the run started (Codex bumps `updated_at` on resume, before any message), then "resume". A new
      thread instead marks it "resume failed" with a line in the log, and so does a run that exits without
      either (a wrong id: Codex says "No saved session found" and exits 1).
- [x] Codex processes lofiwave didn't start showed no session; the detection regex caught the app-server daemon.
      They now get the newest thread in their folder used since they started, from the index, and `detect`
      skips `app-server`, `exec-server`, `mcp-server` and `remote-control`.
- [x] No equivalent of `CLAUDE_PERMISSION_MODE`: `CODEX_SANDBOX_MODE` adds `--sandbox <mode>` to every codex
      run unless its args pick a sandbox. A headless run with `workspace-write` created its file.
- [ ] No Remote Control equivalent. Codex now ships `remote-control`, `app-server daemon`, TUI `--remote`
      and `queue`, and we use none of them.

Also seen on 0.162.1: when an update is out, `codex resume` (and probably any start) first shows an "Update now /
Skip" menu, which blocks an unattended start the way the trust prompt does. Its default choice runs the installer.

## Closed
