# Watching: what agents are waiting on, and lofiwave doing the waiting

*2026-11-27 · PR "Watching tab and `lw watch`" · code: `src/watches.ts`, `scripts/lw-watch.ts`*

## Why

Two things showed up on a team box running a handful of long Claude Code sessions.

**Sessions that looked busy but weren't.** Claude Code's session registry (`~/.claude/sessions/<pid>.json`) has a
status of `shell` when the turn is over but background shells it started are still running. lofiwave only knew `idle`
and `waiting`, and read anything else as working, so three of seven sessions showed activity for hours or days while
they sat at an empty prompt. Two of them had a shell that had been running since days before.

**"status?"** We went through 117 messages where a person typed some form of "status?" into an agent, over six months
on two machines (found with `ccx`). Most came from a few long sessions: two orchestrators supervising other lofiwave
runs (19 and 18 asks) and one session watching a delivery build (10 asks in 12 hours). What went wrong, most common first:

1. **The agent ended its turn with "I'll report when it's done" and set nothing to wake it.** In 29 of the 117 the
   agent's previous message promised a report, and the only thing that ever triggered it was the person asking. The
   worst case: an agent ended its turn at 05:25 to wait for CI and a deploy, with nothing to wake it, and sat idle for
   about 10.5 hours while both finished. Some agents said it outright: "I'll check its progress at your next status
   request."
2. **A watcher was running, but it only spoke at the end.** The person asked again and again for progress (104/123,
   112/123, 115, 116, "no change in the two minutes since your last check"). Each answer was a whole turn.
3. **The agent was blocked on a person and nobody knew.** "Nothing has moved since 9:20 PM… waiting for your go",
   found the next morning; another waited about 3 hours; another 22 hours ("No, I haven't run anything… I was waiting
   for your go").
4. **Agents waiting on each other, with nothing to wake them.** Agents coordinated through a shared STATUS file; the
   orchestrator noticed one was idle "waiting for a turn the fix agent already gave it… it isn't watching the file"
   and nudged it by hand.
5. **The session died while it looked like it was waiting.** "Not logged in · Please run /login", "You've hit your
   limit", "API Error: 529": the agent had stopped hours earlier.
6. **Watchers that stalled, went stale or were replaced.** "That notification is only the old watcher, which I
   replaced", "my 90-minute stall limit could trip on a single slow gap", "finalize was claimed at 02:58 and has
   written no new files since 02:59". Background tasks also stayed open for days with no completion notice.

The common thread: nobody owns the wait, and the waiting can't be seen.

## What this adds

### `shell` reads as idle

`claudeActivity` (`src/runner.ts`) maps `shell` to `idle` with `background: true`; the API has
`background_shells: true` and the session tile says "idle · shells". Idle stop doesn't close a run with background
shells or an active watch (`idleKeepers`).

### Watches (`lw watch`, `/api/watches`)

A watch belongs to a run. It has:

- a **condition**: a process exits (`--until-exit`), a command exits 0 (`--until-cmd`), a file appears or changes
  (`--until-file`), a time (`--in`, `--at`), or another run finishes its turn or ends (`--until-run 21[:done]`);
- optionally a **progress reading**: a command's last output line (`--progress`) or a file's size and time
  (`--progress-file`, e.g. a background shell's `.output`), and a **stall** threshold (`--stall`, default 30m);
- `--every` (default 1m), `--for` (expiry, default 24h, max 7d), a `--label`, and `--then`: the agent's note to itself.

lofiwave checks it every `every_sec`. When the condition is met, or progress hasn't changed for `stall_sec`, or it
expires, it types a message into the session: `[lofiwave watch #N "label"] Done: …`, the command's output, then the
`--then` note. It waits for the agent to be idle (up to 10 minutes while it works; Claude Code queues a message typed
mid-turn), and holds while the agent is waiting on a person, since typing would answer the prompt. A stall keeps
the watch going: it's reported once, and again only after progress moves and stops again.

Watches are rows in SQLite (`watches`), so they survive a restart of lofiwave or of the agent. The agent context
(`src/lw.ts`) tells every agent to set one instead of promising to report back or looping on `sleep`.

### Measuring stall detection (`watch_events`, `/api/watches/stats`)

Every check that matters is logged: `progress` (with how long the reading had been quiet), `stall` (quiet time,
threshold), `stall_cleared` (how long after the stall progress moved again), `met` / `expired` (checks, longest quiet
stretch, stalls), `delivered` (how long it waited for the agent), errors. `GET /api/watches/stats` turns that into:

- **too many**: stalls whose progress moved again within one threshold were slow patches, not stalls;
- **too few**: near misses (watches that ended without a stall but were quiet for 75%+ of the threshold), and stalls
  that never cleared (it really was stuck: how long until we noticed is the threshold);
- the median longest-quiet-over-threshold across watches, and the median delivery wait.

The Watching tab shows these for the last 30 days, with a one-line reading when the numbers lean one way.

### The Watching tab (`/api/watching`)

For each live session: activity, background shells, background agents and monitors read from its transcript (with
each shell's output file size and when it last changed), a pending `ScheduleWakeup`, lofiwave's watches, and the last
thing the agent said. Sessions that need someone are flagged, and the nav shows how many:

| Flag | When | Action |
|---|---|---|
| needs you | waiting on a permission prompt or a question | Open |
| asked you | idle, and its last message ends with a question or asks for a go | Open |
| stopped | idle, and its last message is an API error, a login or a usage limit | Open |
| nothing will wake it | idle, its last message promises a report or says it's waiting on something, and it has no open background task, wakeup or watch | Nudge |
| missed wakeup | a ScheduleWakeup was due more than 3 minutes ago and no turn started | Nudge |
| quiet shell | an open background shell's output hasn't changed for 2h | Nudge |
| lost shells | the transcript has shells that never reported back, but Claude's registry says none are running | Nudge |

A nudge types a short `[lofiwave] …` message telling the agent what was noticed and to use `lw watch`.

The promise detector is a regex over the last message. On the 117 status asks it flags 55 of the messages that came
before them; most of the rest were not promises (a finished answer, a question). It only flags when nothing is
set to wake the agent, so in practice it fires less than that.

## Not done yet

See `issues.md` (#12): push notifications when a session starts needing someone; shells started by subagents (their
transcripts are separate files); watches for runs on a target; a "watch this shell" button that makes a watch from a
background shell's pid and output file.
