# Rendered view: a chat UI you can toggle with the terminal

Status: **design, nothing built yet** (2026-10-09); tracked as issues.md #3. Research behind it: claude-code-viewer (upstream v0.8.2),
T3 Code (pingdotgg/t3code), claude.ai/code, the Claude Code source (2026-03 snapshot) checked against the
installed 2.1.296, and Codex CLI 0.153.4.

## What we're building

An interactive run gets a second way to look at it. **Terminal** is today's xterm.js view into the tmux pane.
**Chat** shows the same session as messages, tool cards, diffs and images, and has a composer with uploads,
approvals and file previews. You can flip between them at any time without losing anything.

It also fixes scrolling. Claude draws on the alternate screen, so tmux keeps no history, and scrolling inside
tmux moves every viewer (see `ad17cb8`, `81e63a9`). The chat view is an ordinary page, so each browser scrolls
it on its own.

## The rule everything follows

**The TUI in tmux stays the only process that runs the session. The chat view only reads files and sends
keystrokes.** Toggling changes what the browser shows. It never starts, stops or resumes anything.

Everything else in this document follows from that rule. The alternatives we rejected:

| Alternative | Why not |
|---|---|
| A `claude -p --input-format stream-json` or Agent SDK process alongside the TUI | A second process writing the same session forks the transcript, and each process keeps its own copy of the context. 2.1.296 itself "starts a copy" when you resume a session that is still running. |
| Swapping: stop the TUI, resume headless, then swap back | Loses open dialogs, background tasks, the input draft and the tmux scrollback, and takes seconds each way. |
| Headless only, the way T3 Code and claude-code-viewer do it | There would be no terminal to toggle to, and nothing to fall back on for TUI-only things such as `/config`, login, the trust prompt or menus we don't support. |

Neither T3 Code nor claude.ai/code has a terminal alongside its chat (T3's terminal is a plain shell). This
toggle is the part nobody else has.

## Architecture

```
            ┌──────────── tmux ac-<run> ─────────────┐
 browser    │  claude TUI (the only writer)          │
 ┌──────┐   └──┬───────────────┬──────────────▲──────┘
 │Term- │◄─pty─┘ (today)       │writes        │ paste-buffer -p / send-keys
 │inal  │                      ▼              │
 ├──────┤        ~/.claude/projects/…/<sid>.jsonl ──tail──┐
 │ Chat │◄──ws── chat projector ◄── ~/.claude/sessions/<pid>.json (busy|idle|waiting)
 │      │                      ◄── hooks: SessionStart, PermissionRequest (http, held open),
 └──────┘                              MessageDisplay (streaming), Stop
```

### 1. Reading the session (server, new `src/chat/`)

**Tail the transcript.** Track a byte offset and keep the trailing partial line for the next read.
claude-code-viewer re-reads the whole file on every change, and for a moment shows half-written lines as
errors; we shouldn't. Watch with `fs.watch` and also poll every 1s, because watchers drop events on some
filesystems. **If the file shrinks** (Claude removes a failed stream from the end), re-read it from the start.

Claude-specific facts the parser depends on (from the source and real transcripts):

- **Entries are written as each content block completes**, within about 100ms, so the file updates during a
  turn. Each block (thinking, text, tool_use) gets its own line with its own `uuid`, but they share
  `message.id`/`requestId`. Group by `message.id`, and pair `tool_use.id` with the `tool_use_id` on the result.
- **The file is a tree.** Rewind and edit start new branches from old `parentUuid`s in the same file. The visible
  conversation is the chain you get by walking back from the newest entry. claude-code-viewer gets this wrong
  and shows abandoned branches.
- **Compaction** writes a `system/compact_boundary` entry (`parentUuid: null`, with `logicalParentUuid`),
  followed by a user entry marked `isCompactSummary`. Show it as a divider, with earlier history collapsed
  above it.
- **`/clear` starts a new session id and a new file.** The `SessionStart` hook reports `source: clear`; the
  hook already exists in `scripts/claude-session-hook.ts`, so use it to switch which file is tailed. Don't rely
  on the pid file's `sessionId` here; the source suggests it isn't updated on `/clear`.
- **Subagents** write `<sid>/subagents/agent-<id>.jsonl` plus a `.meta.json`, and older versions write
  `agent-<id>.jsonl` next to the session file. Link each one through `toolUseResult.agentId`.
- **`toolUseResult`** carries the rich data. For Edit and Write it has `structuredPatch` hunks, which are enough
  to draw a diff (`originalFile` is often null). For Bash it has `{stdout, stderr, interrupted}`.
- **Markers in user entries:** `[Request interrupted by user…]`; `<command-name>`/`<local-command-stdout>`, or
  `system/local_command` in newer versions; `<bash-input>`/`<bash-stdout>` for `!` commands;
  `<task-notification>`; and `isMeta` entries holding expanded skill text, which should be hidden.
- **New entry types keep appearing** (2.1.296 added `cost-state`, `permission-mode`, `file-history-delta`,
  `system/turn_duration` and others). **Unknown types become a quiet "raw" row and never an error.** T3's issue
  tracker shows provider format churn breaking adapters again and again.

**Live status** comes from `~/.claude/sessions/<pid>.json`, which gives `status: busy|idle|waiting` and
`waitingFor`, for example `"approve Bash"`. I checked that it updates live on 2.1.296. Map it from the pane's
pid. This is what drives the working spinner and the "the terminal needs you" banner (see Input).

**Streaming text (later phase):** the new `MessageDisplay` hook sends assistant text in line batches while it
streams (`{turn_id, message_id, index, final, delta}`). Without it, text shows up a whole block at a time, which
is acceptable for v1.

**Usage and context % (optional):** the statusline command receives a JSON object on each update, and an
injected statusline script can POST it to lofiwave. Todos are in `~/.claude/tasks/<sid>/*.json` and can also
be read from the TodoWrite/Task tool inputs.

### 2. The normalized model (shared with Codex)

The shape is borrowed from T3 Code (`packages/contracts/src/orchestrationV2.ts`). The server sends
**whole-item upserts keyed by id**, never deltas into the DOM. A streaming item is the same item sent again
with longer text.

```ts
type Item = {
  id: string; turnId: string; ordinal: number; parentId?: string;   // parentId = subagent / group
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted";
  native: { agent: "claude" | "codex"; ref: string };               // uuid / item id, for "Raw"
  startedAt?: number; completedAt?: number;
} & (
  | { kind: "user"; text: string; images: ImageRef[]; command?: string }   // command = /slash or !bash
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "thinking"; text: string; durationMs?: number }
  | { kind: "command"; label: string; command: string; output?: Omitted<string>; exitCode?: number }
  | { kind: "file_change"; path: string; op: "edit" | "write" | "delete"; added: number; removed: number; patch?: Omitted<Hunk[]> }
  | { kind: "read" | "search" | "web"; label: string; detail?: Omitted<string> }
  | { kind: "todo"; steps: { text: string; status: string }[] }
  | { kind: "plan"; markdown: string; decision?: "approved" | "rejected" }
  | { kind: "subagent"; label: string; childTurnId: string }
  | { kind: "request"; request: ApprovalRequest }   // permission / question / plan, see Input
  | { kind: "tool"; name: string; input: unknown; output?: Omitted<unknown> }  // MCP + anything unknown
  | { kind: "event"; event: "compact" | "clear" | "interrupt" | "error" | "raw"; text: string }
);
type Omitted<T> = T | { omitted: true; bytes: number };   // big payloads fetched when a row is expanded
```

Adapters emit only this model. Tool mapping for Claude:
- Bash → `command`, labelled with its `description` field the way claude.ai does it.
- Edit/Write/MultiEdit/NotebookEdit → `file_change`.
- Read → `read`; Grep/Glob → `search`; WebFetch/WebSearch → `web`.
- TodoWrite/Task* → `todo`.
- Task/Agent → `subagent`.
- ExitPlanMode → `plan`.
- Everything else, including `mcp__*` → `tool`.

The UI checks a `capabilities` object (`streaming`, `approvals`, `images`, `interrupt`), never the agent's name.

### 3. Getting it to the browser

Add a WebSocket at `/api/runs/:id/chat`, using the same `identify()` auth and same-origin check as `/tty`.
- **On connect:** send the active chain's last N turns plus a cursor. "Load earlier" fetches older turns over
  HTTP.
- **Large payloads:** command output above about 8KB, patches, file bodies and images arrive as `omitted` and
  are fetched with `GET /api/runs/:id/chat/blob/:itemId`. Images from the transcript are base64 data; serve them
  as blobs and never inline them.
- **Not tied to runs:** the projector also works for sessions lofiwave didn't start, such as those on the Agents
  tab. Those are read-only, because there's no tmux pane to type into.

### 4. Input: the composer types into the TUI

Everything goes through the run's tmux pane, which gets a new helper in `runner.ts`:

- **Text:** `tmux load-buffer` then `paste-buffer -p` (bracketed paste, so multi-line text arrives as one
  paste), then `send-keys Enter`. Do **not** use `send-keys -l` for multi-line text, because each newline would
  submit.
- **While busy:** the Claude TUI queues a message typed during a turn. Show it as "queued" until it appears in
  the transcript, using T3's optimistic-row approach and claude-code-viewer's "drop the optimistic row when a
  matching real user entry lands".
- **Interrupt:** `send-keys Escape`. The Stop button is shown only while the status is `busy`.
- **A draft already in the TUI's input box:** if someone typed in the terminal and didn't submit, our paste
  gets appended to it. Before sending, `capture-pane` the input line; if it isn't empty, ask "Terminal has an
  unsent draft: replace / append / cancel" (replace = `C-u` first).
- **Slash commands and `!`:** pass through as text. Commands that open TUI menus (`/config`, `/model` with no
  argument, `/resume`, `/login`) get a hint that switches to the terminal. A `/` autocomplete list comes from
  `~/.claude/commands`, `.claude/commands`, skills, and a built-in list.

**Images and files:** the Claude TUI turns any pasted absolute path ending in
`.png/.jpg/.jpeg/.gif/.webp` into an image attachment. The rule is in `usePasteHandler.ts` and unchanged in
2.1.296.
1. The browser uploads by drag-drop, paste or the `+` button to `POST /api/runs/:id/uploads`. Enforce a
   size cap.
2. The server saves it to `data/uploads/<run>/<sha>.<ext>` with mode 600.
3. The composer shows a thumbnail chip. On send, paste the path, wait until `[Image #N]` appears in the pane,
   then paste the text and press Enter.
4. Other formats:
   - HEIC: convert with `sips` on macOS, and refuse on Linux unless an encoder is available.
   - PDFs and text files: send as `@/abs/path`.
   - Anything else: upload it and insert the path as text.
5. Clean up uploads after the run ends, using the same retention as logs.

**Approvals, questions and plan approval:** start Claude with an injected `--settings` that adds a
`PermissionRequest` hook calling lofiwave. The hook can be `http` or a command hook like the existing session
hook.
- **How it works:** lofiwave holds the request open, shows a card above the composer (T3's pattern, with keys
  1–9 for options), and answers with `{behavior:"allow"|"deny", updatedInput?, updatedPermissions?, message?}`.
  The TUI shows the same dialog at the same time, and whichever is answered first wins; Claude removes the other
  (`interactiveHandler.ts`, the `claim()` race).
- **AskUserQuestion:** allow with `updatedInput.answers = {"<question>": "<label>"}`. For multiple choices,
  separate the labels with commas.
- **Plan approval (ExitPlanMode):** allow with `updatedPermissions: [{type:"setMode", mode, destination:"session"}]`
  to pick the mode after the plan, or deny with a `message` to give feedback.
- **The hook input has no `tool_use_id`,** so match it to the open tool_use by tool name and input.
- **If the terminal answers first,** clear the card once the matching tool_result appears or the status leaves
  `waiting`. Then answer the orphaned hook request with no decision.
- **Holding requests open:** cap the hold below the hook timeout (default 10 min). Return no decision on timeout
  so the TUI dialog keeps working.

**"The terminal needs you."** When `status === "waiting"` but no web card matches `waitingFor`, show a banner
with the `waitingFor` text, a live `capture-pane` snapshot of the bottom of the screen, and a button that
switches to the terminal. Unknown dialogs, the folder-trust prompt, login and `/config` all land here. This
fallback is what makes the long tail of edge cases safe to ship incrementally.

### 5. Frontend

The frontend stays vanilla JS with vendored libraries and no build step, matching `public/vendor`. That means
adding:
- **marked** and **DOMPurify** for markdown. Always sanitize, because transcript text is untrusted.
- **highlight.js** with a handful of languages.
- **A small diff renderer** working from `structuredPatch`.

Long sessions use `content-visibility: auto` on turn containers, plus showing only the last N turns with "Load
earlier", rather than a virtualization library.

**Rows,** following claude.ai/code's design:
- **Assistant text** is shown at full contrast. Everything else is a muted one-line row with a chevron.
- **Consecutive tool calls fold** into one summary row, e.g. "Ran 3 commands (1 failed), edited 2 files".
- **A finished turn folds** to "Worked for 2m 13s". Failures stay visible.
- **Bash rows** expand to show the `$ command` and its output in a box with its own scroll and a fixed height,
  plus a red Failed badge on a non-zero exit.
- **Edit rows** expand to an inline diff, and a write shows its `+N −M` counts.
- **At the end of each turn,** an "Edited N files" card lists each file with its `+/−` counts.
- **Subagents and plans** open in a side panel.
- **Unknown and MCP tools** show their inputs as key/value pairs, and their output on demand.

**Files panel (the "click the edited markdown file" request):**
- **What opens it:** clicking an edited file row, or any `path:line` in assistant text (linkify paths that exist).
- **The file:** `GET /api/runs/:id/file?path=` returns the current contents from disk, with a 1MB cap.
  - The path must resolve inside the run's cwd or `$HOME`. Use `realpath` so symlinks can't escape.
- **Tabs:** *Diff* (this edit's hunks), *Current* (highlighted, scrolled to the line), and **Preview** for `.md`
  (rendered markdown) and images. claude-code-viewer has no markdown preview, so that is ours to add.
- **Later:** a per-turn "what changed" view from git, with T3's hidden-ref checkpoints (`refs/lofiwave/…`) so
  nothing touches the user's branch.

**Scrolling:**
- **Auto-scroll:** only while the user is within about 150px of the bottom. Re-apply it over a few animation
  frames after markdown renders, as claude-code-viewer does.
- **When the user scrolls up:** show a ↓ "jump to latest" button.
- **After sending:** pin the sent message near the top, as T3 does.
- **Toggling views:** remember each view's scroll position per run.

**Toggle:**
- Extend the existing `ac_term_mode` (`public/app.js:890`) from Simple/Terminal to **Chat / Terminal /
  Simple**, still saved per browser. Default to Chat for interactive Claude runs once it's stable.
- Keep the xterm WebSocket open for about 60s after switching away, so flipping back is instant.
- **A hidden terminal must not send resizes:** `window-size latest` would otherwise let a hidden tab resize the
  pane for everyone.
- On a phone, Chat is the better default.

## Edge cases checklist

Reading:
- [ ] Partial last line, a file that shrinks, a file that doesn't exist yet (a new session has no file until the first prompt)
- [ ] Rewind/edit branches: render only the active chain
- [ ] `/clear` (new file), `/compact` (divider), `--resume` (same file), `--fork-session` (new file)
- [ ] Two live runs on one session id (ideas-fridge §4): writes interleave. Show a warning and use the active
      chain, never file order.
- [ ] Parallel tool calls whose results interleave between the assistant's block lines
- [ ] Subagents in separate files, both old and new layouts; nested subagents
- [ ] Huge outputs (tool results above 1MB, base64 images): omit and fetch on demand
- [ ] Unknown entry types and tools: a raw row, never a crash
- [ ] Interrupted turns, API errors, `turn_duration`, background `<task-notification>`
- [ ] Transcripts of sessions lofiwave didn't start (read-only), and sessions on a remote host (later, fridge §3)

Input:
- [ ] Multi-line text, text starting with `/`, `!` or `#`, very long pastes, emoji and other non-ASCII
- [ ] Sending while busy (queued), while waiting (blocked by a dialog), or while the pane is dead
- [ ] An unsent draft in the TUI input box
- [ ] Image paste timing (wait for `[Image #N]`), unsupported formats, size caps, several images in one message
- [ ] Interrupt during a tool versus during text
- [ ] Two browsers typing at once (fine, same as tmux), plus one in Terminal and one in Chat

Approvals:
- [ ] The web and the TUI both answering (first answer wins; clear the loser)
- [ ] The hook timing out, the server restarting while a request is held, or the run ending while held
- [ ] Bypass mode (only questions and plans prompt), `acceptEdits`, plan mode
- [ ] Prompts not handled through hooks (trust, MCP auth, `/config`): fall back to the terminal banner

Display:
- [ ] Untrusted markdown and HTML in transcripts: sanitize; images only from our blob endpoint
- [ ] Linkify only paths that exist; file reads restricted to cwd or `$HOME` through `realpath`
- [ ] Scroll anchoring with late-rendering markdown, images and syntax highlighting
- [ ] Mobile layout and the composer under the on-screen keyboard

## Codex

lofiwave's Codex support needs fixing before a Codex chat view makes sense. See issues.md #1 and #2 for the
status list. The plan for the view:

- **Reading:** tail `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Codex flushes it as each item completes.
  New threads use "paginated" mode, which writes clean `item_completed` lines (user and agent messages,
  reasoning, commands, file changes, image views, web search, compaction, subagents). That maps almost
  one-to-one onto the model above. Older threads have to be rebuilt from `event_msg` plus `response_item` pairs.
- **Not in the rollout:** streaming text, commands still running, and approval or trust prompts. So for Codex,
  `capabilities.approvals = false`, and approvals go through the "terminal needs you" banner, detected from
  `capture-pane`, with key buttons.
- **Input:** tmux paste, the same as for Claude. Image paste into the Codex TUI is untested.
- **Finding the rollout:** `~/.codex/state_5.sqlite` (the `threads` table, opened `immutable=1`) or `lsof` on
  the pane's process tree, instead of today's "newest rollout in the same cwd" guess.
- **Later, the proper route:** `codex app-server` as a daemon, with the TUI attached through `--remote` and
  lofiwave as a second JSON-RPC client. That gives streaming deltas and structured approval requests from
  the same live thread. Unverified, so it needs a spike. T3's experience: Codex protocol churn breaks clients,
  so pin versions with semver compatibility rules.

## Phases (one PR each)

1. **Read-only chat view for Claude.**
   - Server: the tailer, the Claude adapter, the active-chain projection and the `/chat` WebSocket.
   - Browser: the rendered view with the toggle, tool grouping, diffs, markdown, transcript images, the status
     pill from the pid file, and its own scrolling.
   - Also works for Agents-tab sessions lofiwave didn't start.
   - On its own, this already fixes the scrolling complaint.
2. **Composer:** text through bracketed paste, Stop, queued messages, the unsent-draft check, image and file
   uploads, the `/` list, and the "terminal needs you" banner.
3. **Approvals:** the PermissionRequest hook injected with `--settings`, cards for permissions, questions and
   plans, and the race and cleanup handling.
4. **Files panel:** click an edited file, markdown preview, the diff and current-file tabs, linkified paths,
   and the per-turn "Edited N files" card.
5. **Live polish:** streaming through `MessageDisplay`, usage and context from the statusline, a live todo
   strip, and git checkpoints for per-turn diffs.
6. **Codex:** the issues.md #1 fixes, then a read-only rollout adapter, then the composer, then the
   app-server spike.

## Spikes to run before phase 2 and 3

1. Paste an absolute `.png` path into a live TUI with `tmux paste-buffer -p`. Does `[Image #1]` appear?
   Does it also work with `send-keys -l`?
2. `--settings '{"hooks":{…}}'`: is it merged with the user's own hooks, or does it replace them? T3 issue
   #15073 saw a replacement happen through the SDK.
3. HTTP hooks: do they need an `allowedHttpHookUrls` entry? Can headers interpolate `$AGENT_CONSOLE_TOKEN`? If
   either answer is no, use a command hook (curl, plus the token from the environment).
4. `MessageDisplay`: payload shape and how often it fires on 2.1.296.
5. Codex 0.153 TUI: is the rollout paginated-mode and flushed per item when started from tmux? Does pasting
   an image path attach it?
