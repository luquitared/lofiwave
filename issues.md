# Issues

Open work, newest first within each status. One heading per issue; close it by moving it to
**Closed** with the commit that fixed it.

## Open

### #7 E2B sessions: what's left after running them in the sandbox's tmux
*Opened 2026-10-21 · seen running real claude sessions on an e2b target, with all open PRs merged*

Interactive sessions on an `e2b` target now work end to end, and still work after a pause and resume or a
console restart: claude runs in tmux in the sandbox and lofiwave follows a tmux client. Before that, envd's
stream of the agent's PTY stayed silent after a resume, so the terminal went blank while input still reached it.

- [ ] The chat view shows a running sandbox session as off: it reads the transcript from this machine, and that
      only comes back when the run ends. It could fetch it from the sandbox (`/files`) while the run is going.
- [ ] `activity` says `working` while claude sits idle: activity for sandbox runs comes from the screen, not the
      hook registry (no hooks in the sandbox). Parse the screen like codex's, or forward claude's hooks.
- [ ] With `--remote-control`, no claude.ai link is picked up for the run (`remote_url` stays empty):
      link capture watches tmux panes on this machine only. Read it from the sandbox screen instead.
- [ ] tmux is installed with apt at the start of each run (stock `claude` template), which adds seconds. A
      lofiwave template with tmux in it would skip that.
- [ ] The *New session* dialog can pick a target (*Runs on*) but not set the run's env or `input_dir`; the API can.
- [ ] No volumes: data goes in through `repo` and `input_dir` and out through `out/`.

### #5 Runs as jobs: follow-ups
*Opened 2026-10-17 · left over from groups, files, results and admission control (README → Swarms)*

- [ ] A scheduled workflow that finds the machine full is recorded as an `error` run; it could queue instead.
- [ ] The UI shows `queued` runs in the run list but has no button to cancel one (`POST /api/runs/:id/kill`
      does) and doesn't show the capacity (`GET /api/system` → `capacity`).
- [ ] The default `MAX_AGENT_RUNS` assumes ~600 MB per agent. Measure real claude/codex RSS on a small box
      and count agents the console didn't start (they use memory but hold no slot; only `MIN_FREE_MEM_MB` sees them).
- [ ] No way to delete files in a run's folder over the API, or to write outside `cwd` (e.g. a shared input folder
      for a whole group).

### #6 Driving agents: what's left after message / wait / activity
*Opened 2026-10-17 · follow-ups to `swarm-1-reliable-control`*

- [ ] Codex: `delivered` is always null (its input box isn't parsed), its `activity` comes from the screen only
      (`esc to interrupt`), and it never stops for idling. Its trust prompt is answered on screen but not
      pre-set (`~/.codex/config.toml`, `[projects."<path>"] trust_level = "trusted"`). Untested with a real
      Codex run.
- [ ] Pre-trusting rewrites `~/.claude.json` (read, change, rename). A claude process writing it in the same
      few milliseconds would lose its own change. Claude's own writes have the same race; no lock is shared.
- [ ] Claude's "How is Claude doing?" survey (it answers to digit keys) showed up mid-test. The message went
      through that time, but a message starting with a digit could answer the survey instead.
- [ ] Headless orphans (still alive after a restart) are only polled for their end, so they finish as
      `lost` with no exit code.

### #3 Chat view, toggleable with the terminal
*Opened 2026-10-09 · designed in [`docs/rendered-view.md`](docs/rendered-view.md) · phases 1 (read-only chat view), 2 (composer), 3 (approvals), 4 (files panel) and 5 (live polish) built*

An interactive run gets a second view: the same live session as messages, tool cards, diffs and images,
with a composer that takes uploads and answers approvals. You can switch between it and the xterm view at
any time. The TUI in tmux stays the only process running the session; the chat view tails the transcript
and types into the pane. It also ends the terminal scrolling back-and-forth (`81e63a9` → `ed62c8d` →
`ad17cb8`), because the chat view scrolls separately in each browser.

Six phases, one PR each (in the doc). Phase 1 is in: the Chat view for Claude runs and, read-only in a dialog,
for Claude sessions lofiwave didn't start. Phase 2 adds the composer: text, Stop, queued messages, the
unsent-draft check, image and file uploads, the `/` list, and a "terminal needs you" banner with a live snapshot.
Phase 3 answers permission prompts, questions and plans from cards in the chat view, through a `PermissionRequest`
hook injected with `--settings`. Phase 4 adds the files panel: an edit row, a turn's "Edited N files" card or a
path in Claude's text opens the file beside the conversation, with the edit's diff, the file as it is now (at the
line), and a preview for markdown and images. Phase 5 streams Claude's text as it's written (`MessageDisplay`), shows
the model, context, cost and rate limits from the statusline, keeps a live task-list strip above the composer, and
lists what each turn changed from git checkpoints (hidden refs), commands' changes included. Still untested from
phase 5: a message queued mid-turn (if it fires its own prompt hook, it splits the turn for git), checkpoints in a very large repo, and the strip
with real TaskCreate calls (the test session didn't offer the tools). Still untested from phase 4: the panel as an overlay on a real phone,
files near the 1 MB cap, and edits made inside a subagent. Still untested from phase 3: the hook timing out, a server restart while a request
is held, bypass and `acceptEdits` modes, requests from inside a subagent, and the cards on a real phone.
Still untested from phase 2: very long pastes and non-ASCII text, several images in one message, HEIC, Stop
during a tool call, two browsers sending at once. Still open from phase 1's checklist: warning when two live runs share
a session id, nested subagents, the phone layout on a real device. Before phases 2 and 3, the five spikes at the
end of the doc. All five ran on 2026-10-11 (results at the end of the doc). Image paste, hook merging, HTTP hooks
with the token, and the approval race all work. `MessageDisplay` streams by paragraph but blocks the TUI
until it returns, so lofiwave's endpoint must reply at once. ExitPlanMode and `deny` with a message were
checked in phase 3 (ExitPlanMode needs `updatedInput` on allow; see the doc's "Phase 3 findings").

### #2 Codex: untested paths
*Opened 2026-10-09 · audit against `codex-cli 0.153.4`; see #1 for what's confirmed broken*

Never exercised end to end:
- [ ] Resume from the UI
- [ ] Workflows and cron with the codex type
- [ ] Restarting a Codex run
- [ ] Cleaning up Codex's child processes when a run is killed
- [ ] `codex exec resume`
- [ ] Image attachment with `exec -i` (pasting a path into the TUI works on 0.162.1, see `docs/rendered-view.md`)
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

### #4 tmux targets match by prefix: a dead run's commands can reach another session
*Opened 2026-10-17 · seen while testing #1 · closed by the `tmux-exact-targets` branch*

`tmux … -t ac-4` picks any session whose name *starts with* `ac-4` when there's no `ac-4`, so once run 4's
session is gone, commands meant for it go to `ac-42` (here, `capture-pane` read run 42's screen). The runner, the
screen and keys endpoints, the xterm view and the terminal window all targeted `ac-<id>` this way, so a stale
browser could type into the wrong run, and a cleanup could kill it. Fix: every command builds its target with
`tmuxTarget()` (`=ac-4:`, the exact session's current pane; a bare `=ac-4` is rejected by pane commands).
Also: on tmux 3.6, `display-message -p` on a missing target prints empty fields and exits 0, so the runner's
"session vanished" check never fired while other sessions existed; it now treats empty output as vanished.
