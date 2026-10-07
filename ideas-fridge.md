# Ideas fridge

Things worth building, parked with enough context to pick up cold. Each entry says what it is, what's
already been verified, and what the catch is.

---

## 1. Real terminal instead of virtual buttons

**Done (2026-10):** `src/tty.ts` — xterm.js ⟷ WebSocket ⟷ `tmux attach` on a pty from Bun's own `Bun.spawn({ terminal })` (no node-pty). The resize hack stays for the simple view only, and is skipped while a real terminal is attached. Notes below kept for context.

Today an interactive run is driven by polling `GET /api/runs/:id/screen` (tmux `capture-pane`) and posting
`POST /api/runs/:id/keys` (tmux `send-keys`), with on-screen ⏎ / Esc / ⇥ / ↑ / ↓ / ^C buttons standing in for
keys a text field can't send.

**The upgrade:** xterm.js in the browser ⟷ WebSocket ⟷ a real `tmux attach -t ac-<id>` on a pty. Raw bytes
both ways, so scrollback, colours, mouse, Ctrl-R, paste and TUI menus all just work.

The groundwork is already right — going through tmux was the hard part. What's missing:

- **A WebSocket.** `Bun.serve` in `src/server.ts` has no `websocket` handler yet; needs `server.upgrade(req)`.
  Auth via query-param token already works (`authorized()` accepts `?token=`), which is what a browser WS needs.
- **A pty.** Three options, in order of preference:
  1. `node-pty` — the normal answer, native N-API addon. **Unverified under Bun 1.4.2** — spike this first.
  2. `script -q /dev/null tmux attach -t ac-25` — allocates a pty with no native dep. Grubby, and the flags
     differ between macOS and Linux, but it works today.
  3. `tmux -CC attach` (control mode) — structured output over plain pipes, no pty at all. This is how iTerm
     does it. Most protocol work.

Keep `screen`/`keys` as the fallback for flaky links (a plane, a phone on cellular).

**When this lands, delete the resize hack.** `screenOf()` in `src/runner.ts` calls `tmux resize-window` to
whichever viewer polled last, sized from a font-probe in `screenCols()`. xterm.js reports its own size, so
that goes away — and it has to, see below.

## 2. Multiplayer

Already solved by construction: sharing one session between many clients *is* what tmux is for. Each browser
tab opens its own `tmux attach` client against the same session; everyone sees the same output and everyone
can type. Nothing to synchronise by hand.

Two catches:

- **Resize fights.** With the current per-poll `resize-window`, two viewers of different widths thrash.
  tmux's own answer is to size to the smallest client, or `setw -g aggressive-resize on`.
- **Auth becomes load-bearing.** A terminal into a `--remote-control` run is effectively shell access, and
  right now one shared `AUTH_TOKEN` in `.env` is the only thing between anyone on the tailnet and a live
  agent. Wants per-viewer tokens, and `tailscale serve` for HTTPS, before the URL goes to a second person.

## 3. Remote sessions: federate over the tailnet

**Goal:** one console listing sessions on every machine, with `host` as an absolute field on each — replacing
the vague local/remote framing. Everything the console sees today comes from `ps` on *this* box, so "local"
is currently universal and therefore not a distinction worth drawing.

### What was verified (2026-09-12, against lucas-XPS-8930 over `ssh xps`)

- **Claude Code's own peer roster does see remote sessions** — a session can list Remote Control peers on
  other machines, with idle/offline status. **But there is no supported external access to it:** no CLI
  subcommand (`claude agents` is background agents, local only), no local cache (grepped `~/.claude` for the
  remote session names — zero hits; `daemon/roster.json` is background workers), and the list is fetched live
  from claude.ai over the session's own auth. Reproducing it means an undocumented endpoint plus the account
  OAuth token. Don't.
- **Reading `~/.claude` over ssh is a strict superset** and needs no API at all:
  - `~/.claude/sessions/<pid>.json` → live sessions (check the pid is alive; stale files linger)
  - `~/.claude/projects/**/<id>.jsonl` → every session ever, i.e. the closed ones
  - On the XPS: **4 live, 31 on disk.** The roster only showed the 3 with an *active* Remote Control bridge,
    and none of the 27 closed ones.
- **`cwd` must come from inside the transcript.** The project folder name is a lossy slug (every
  non-alphanumeric becomes `-`, so `/home/lucas/robot/ent-scrub-tech` →
  `-home-lucas-robot-ent-scrub-tech`) and cannot be inverted. The `.jsonl` records the real `cwd` on its own
  lines — read it there.

### Performance (measured on plane wifi, i.e. the worst case)

| | |
|---|---|
| ssh handshake alone | 13.23s |
| full probe, 31 transcripts / 51 MB | 14.83s |
| → so the actual work is | ~1.6s |
| 1st connect with `ControlMaster` | 9.79s |
| reuse | 1.64s |
| probe over the master | 2.76s |

So: **`ControlMaster` + `ControlPersist` is mandatory** (14.5s → 2.8s), and the probe must be a **background
poll with a TTL, never on the request path** — the UI refreshes every 3s and cannot wait on a remote host.

Gotcha: keep `ControlPath` **short**. A path under a long scratchpad dir silently blows the ~104-char Unix
socket limit, and ssh then "succeeds" in 0.01s while doing nothing. Check exit codes, not timings.

### Why this beats the roster

`tmux()` in `src/runner.ts` is just `Bun.spawn(["tmux", ...args])`, and `screenOf`/`sendKeys` are nothing but
`capture-pane` and `send-keys`. **Give that one function a host** and the same primitives run as
`ssh xps tmux capture-pane …` over the persistent master — remote sessions become fully drivable from the
browser, which a claude.ai roster entry can never be. Same code, one indirection.

### Shape

- a `hosts` config/table (`{name, ssh, enabled}`), the local machine implicit
- a background poller per host, cached with a TTL, surfacing `last_error` when a box is asleep
- `host` on every session, everywhere
- rail grouped by host; `tmux(host, …)` for remote panes

## 4. Label same-conversation runs apart

`claude --resume <id>` on a session that is *still running* keeps the **same session id** — verified: two pids
(8658, 9381) both reported `0cd29314…` in `~/.claude/sessions/`. So both processes write **one transcript**
and their histories interleave. In the UI they appear as two identical rows (two "Unpushed changes").

Mitigated already: the Agents tab now offers "Open terminal" for a session the console drives, "Take over
here" (with a confirm spelling out the consequence) only for one it doesn't.

Still wanted: when two live runs share a session id, label them apart by the thing that actually differs —
claude's own per-process name and the run id (`#25 · ent-scrub-tech-df` vs `#26 · ent-scrub-tech-dd`) — plus a
banner on the pane naming the twin, with a jump to it.

## 5. Restarts leave children behind — and the memory figure lies

Noticed 2026-09-12 on the XPS, where `systemctl --user status agent-console` reported **`Memory: 8.3G`** for a
console that had restarted three seconds earlier.

**It was page cache, not usage.** `systemctl status` prints `memory.current`, which charges the cgroup for the
page cache of every file its processes read:

| | |
|---|---|
| `anon` (actual memory) | 245.73 MB |
| `file` (page cache) | 8272.50 MB |
| of which `inactive_file` (reclaimable, never re-touched) | 8019.46 MB |
| pressure events (`low`/`high`/`max`/`oom`) | all 0 |

Machine was 3.6 GB used / 11 GB available of 15 GB, with ~10 GB in `buff/cache` — the same cache seen from the
other side. Real RSS: **bun server 47 MB**; a dashboard python in the same cgroup held 297 MB and had read
**16.8 GB** off disk in 20 hours (the bun process: 0).

Two gotchas worth keeping:

- `/proc/<pid>/statm` field 1 is **VmSize, not RSS** — bun reserves ~1.7 GB of address space for its JS heap,
  which reads as alarming and means nothing. Use `VmRSS` from `/proc/<pid>/status`.
- A cgroup memory number is only meaningful split into `anon` vs `file` (`memory.stat`), against
  `memory.events` for whether anything ever had to be reclaimed.

**The real finding underneath:** that python was `run 34`, still `status: running` with `meta.orphan: true`. It
survived `systemctl --user restart agent-console` and stayed inside the unit's cgroup, so its page cache is
billed to the console forever.

Ideas:

- **Decide the policy, because right now it's accidental.** Either `KillMode=control-group` on the unit so a
  restart takes children down with it, or a deliberate choice that long-lived apps outlive a console restart.
- If children are *meant* to survive, start them in their own scope (`systemd-run --scope`) so their memory and
  IO are accounted to themselves rather than to the console.
- `reconcileRuns()` already flags these (`meta.orphan`). The UI could act on it: a run whose process outlived
  the console should offer *adopt* or *stop*, instead of sitting at `running` indefinitely.
- Unrelated but spotted on the way past: the yam dashboard reading 16.8 GB/day suggests it rescans recordings
  on a timer rather than keeping an index.

## 6. Smaller notes

- **`ideas-fridge.md` is not a backlog.** If something here is actually next, it belongs in an issue.
- Per-viewer auth tokens (see §2) are worth doing on their own, before any of the terminal work.
- `tailscale serve` would put the console on HTTPS 443 instead of plain HTTP on 7770.
