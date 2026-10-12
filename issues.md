# Issues

Open work, newest first within each status. One heading per issue; close it by moving it to
**Closed** with the commit that fixed it.

## Open

### #3 Chat view, toggleable with the terminal
*Opened 2026-10-09 · designed in [`docs/rendered-view.md`](docs/rendered-view.md) · phases 1 (read-only chat view), 2 (composer), 3 (approvals) and 4 (files panel) built*

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
line), and a preview for markdown and images. Still untested from phase 4: the panel as an overlay on a real phone,
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
