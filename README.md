<p align="center"><img src="public/logo.png" width="96" alt=""></p>

# lofiwave

A small web console for the coding agents running on your machine: Claude Code, Codex, or any command you describe.

- **See** every agent process on the machine, including ones you started in a terminal: its session name, status (working / idle), model, and its claude.ai link.
- **Start, stop and restart** agents in a chosen folder. Every agent session is **interactive**: the real TUI in a tmux session you can watch and type into from the browser, and with Claude Code's Remote Control on, in the Claude app too. (Headless `claude -p` stays available through the API.)
- **Turn on Remote Control** for a Claude Code session that is already running.
- **Run targets**: give a session or workflow run its own [E2B](https://e2b.dev) sandbox VM instead of this machine, whose live terminal you still open and type into from the browser.
- **Workflows**: a saved agent launch you run by hand or on a cron schedule. Each run is a live session you can watch and step into; it closes itself when the agent is done. Every run is kept: status, duration, full logs.
- A REST API for all of it, documented at `/api/docs`, so other agents can drive it too. The *Connect* page gives you the URL to hand an agent and makes API keys for it.

The UI has four pages: **Sessions** (live sessions and their terminals), **Workflows**, **Connect** (API docs URL and API keys), and **Advanced** (every process on the machine, apps, run history, process types, and **System**: memory, CPU, swap and disk, what lofiwave and each live run use, and how many more agents fit).

It runs on [Bun](https://bun.sh) with SQLite and no other dependencies. Linux and macOS are the main targets; Windows is best-effort (no interactive runs).

## Requirements

- [Bun](https://bun.sh) 1.1+
- [tmux](https://github.com/tmux/tmux), for interactive runs (`brew install tmux` / `apt install tmux`)
- The agents you want to drive, on `PATH`: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), …

## Install

```bash
git clone https://github.com/luquitared/lofiwave.git
cd lofiwave
bun start
```

On first start it generates an access token and prints a link that logs your browser in:

```
lofiwave listening on http://127.0.0.1:7770
generated an access token (kept in …/lofiwave/data/auth-token); open:
  http://127.0.0.1:7770/#token=…
```

Lost the link? The token is in `data/auth-token`; the UI asks for it when it needs it.

### Run it as a service

```bash
scripts/install-service-macos.sh    # launchd agent: starts at login, logs to data/server.log
scripts/install-service-linux.sh    # systemd user service: starts at boot (journalctl --user -u agent-console -f)
```

Both use `scripts/start.sh`, which puts the usual tool folders (`~/.bun/bin`, `~/.local/bin`, Homebrew, nvm's node) on `PATH` so the service can find the agents, and loads `.env`.

### Link sessions to their transcripts (optional)

Add `scripts/claude-session-hook.sh` as a Claude Code `SessionStart` and `SessionEnd` hook in `~/.claude/settings.json` (the snippet is at the top of the script). Claude sessions the console starts then report their session id back, which gives runs their transcript, title and a *Resume* button. For any other Claude session the hook exits immediately. Without it, an interactive claude run still gets its session, from Claude's pid registry while the run is followed (see *Sessions* below).

## Security

The console starts agents and kills processes, so treat its token like a password.

- **Local only by default.** It listens on `127.0.0.1`. Set `HOST` to make it reachable from other machines (see *Remote access*).
- **Always a token.** Every API call needs it, on localhost too: any web page open in a browser on this machine can send requests to `127.0.0.1`. It comes from `AUTH_TOKEN`, or is generated into `data/auth-token` (mode 600).
- **Agents ask before acting.** The built-in `claude` type keeps Claude Code's permission prompts. In an interactive run you answer them in the browser or the Claude app; a headless `claude -p` run can't, so tools that need permission are refused. To let runs go unattended, add `--permission-mode acceptEdits` (or `--dangerously-skip-permissions`, if you understand what that allows) to the type's args under *Advanced → Types*, or per run as extra args.
- **Folders you start claude in are trusted.** Claude Code asks "Is this a project you created or one you trust?" the first time it runs in a folder, even with `--dangerously-skip-permissions`. The console answers yes for you: it marks the run's folder trusted in `~/.claude.json` (`projects[<folder>].hasTrustDialogAccepted`, as the dialog itself does; never for `/` or your home folder) and accepts the dialog on screen if it shows anyway. Pass `trust: false` to `POST /api/processes` to leave the dialog to a person.
- `data/` (database, run logs, which include agent output) is created owner-only.
- Agents started by the console get `AGENT_CONSOLE_URL` and `AGENT_CONSOLE_TOKEN` in their environment (that's how the session hook reports back), so an agent the console started can use the console's API.

## Remote access

To use it from your phone or another computer, put it on a private network rather than the internet. With [Tailscale](https://tailscale.com):

```bash
# keep the default HOST=127.0.0.1 and let tailscale proxy to it, with HTTPS, reachable only from your tailnet:
sudo tailscale serve --bg 7770      # → https://<machine>.<tailnet>.ts.net
```

Or set `HOST=0.0.0.0` in `.env` and use `http://<machine>:7770` over the tailnet; that also exposes it to your LAN, still behind the token. On a new device, open the link with `#token=…` once, or paste the token when asked. The UI is responsive: on a phone the tabs move to a row at the top, a run opens full screen, and an interactive run's terminal is resized to the phone's width.

Linux helpers: `scripts/install-tailscale-linux.sh` installs Tailscale and prints the address; `scripts/setup-ssh-tailscale-only.sh` (sudo) restricts SSH to the tailnet (ufw + sshd `AllowUsers`; `STRICT=1` also denies all other incoming traffic).

## Team login

For a console several people share (e.g. on a VM), set `PASSWORD` in `.env`. The UI then asks for **your name and the team password** instead of the token, and keeps you signed in for 30 days (an HttpOnly, SameSite=Strict cookie; `Secure` behind HTTPS). It's multiplayer:

- every run records who started it (`meta.started_by`: the name, or `api` for token calls; scheduled runs have none), shown on the session rail, the runs list and the run page;
- the header shows who else is here (anyone who used the console in the last ~45 s);
- interactive sessions are shared: anyone can watch and type into any live terminal.

Wrong passwords are throttled (10 per address per 10 minutes; behind a reverse proxy on the same machine, the `X-Forwarded-For` address). Changing `PASSWORD` signs everyone out. Serve it over HTTPS, e.g. with Caddy in front (`reverse_proxy 127.0.0.1:7770`).

API: `GET /api/auth` → `{password_login}` (public), `POST /api/login {name, password}` (public, sets the cookie), `POST /api/logout`, `GET /api/me` → `{name, password_login, online: [{name, last_seen}]}`.

## Configuration

Environment variables, or `KEY=VALUE` lines in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7770` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` makes it reachable from other machines. |
| `AUTH_TOKEN` | *(generated)* | The access token. Unset: generated once into `data/auth-token`. |
| `PASSWORD` | *(unset)* | Team password. Set: people sign in with a name and this password (see *Team login*); the token keeps working for agents and scripts. |
| `GIT_AUTHORS` | *(unset)* | Git identity per signed-in person: `"lucas=Lucas N <lucas@x.com>, seth=Seth N <seth@x.com>"` (key = first word of the sign-in name, any case). Runs they start get `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set, so commits carry their name; everyone else uses git's own config. |
| `DATA_DIR` | `./data` | SQLite database, run logs, generated token |
| `CLAUDE_PERMISSION_MODE` | *(unset)* | Permission mode every `claude` run starts in — new, restarted and resumed, headless or interactive: adds `--permission-mode <mode>` (`acceptEdits`, `bypassPermissions`, …) unless the run's args already choose one. Unset: Claude Code's own default (prompts on). |
| `CODEX_SANDBOX_MODE` | *(unset)* | The same for `codex`: adds `--sandbox <mode>` (`read-only`, `workspace-write`, `danger-full-access`) unless the run's args already choose a sandbox. Unset: Codex's own config, where `codex exec` defaults to `read-only`, so a headless run can't change files. |
| `CLAUDE_TUI` | `default` | Claude Code renderer for interactive runs: adds `--settings '{"tui":"<value>"}'` unless the run's args already pass `--settings`. `default` keeps claude out of the alternate screen, so tmux keeps the history and scrolling up in the browser terminal is private and smooth; `fullscreen` hands the wheel to claude (every viewer's screen moves, one redraw per tick); `keep` uses your own `~/.claude/settings.json`. |
| `SCHEDULER_INTERVAL_MS` | `15000` | How often scheduled workflows are checked |
| `IDLE_STOP_SEC` | `120` | How long a workflow's claude session (or one started with `stop_when_idle: true`) stays open once the agent is done and idle, with nobody watching it |
| `AGENT_IDLE_STOP_SEC` | `1800` | The same for every other interactive claude run (started from the UI or the API, resumed, or picked up again after a restart), so finished agents don't hold memory for days. `0` turns it off; a run opts out with `stop_when_idle: false` or sets its own `idle_stop_sec`. |
| `OUTPUT_TAIL_BYTES` | `65536` | How much of the end of each log is copied into the run record (`output`) |
| `MAX_AGENT_RUNS` | *(from RAM)* | At most this many agent runs at once; more are refused with 429 or queued (see *Swarms*). Default: (total RAM − 1 GB) / 600 MB, between 1 and 16. `0` = no cap. |
| `MIN_FREE_MEM_MB` | `500` | No agent run starts while less memory than this is available (Linux `MemAvailable`; macOS free + inactive pages). `0` = no check. |
| `CWD_ROOTS` | home and temp dirs | Colon-separated folders under which `mkdir_cwd` may create a run's folder |
| `OPEN_TERMINAL` | `auto` | Desktop terminal window opened on an interactive run. `auto` = iTerm then Terminal.app on macOS, the first of wezterm/kitty/alacritty/ghostty/foot/gnome-terminal/konsole/tilix/xfce4-terminal/mate-terminal/terminator/urxvt/xterm found on Linux; `none` to keep runs headless; or name one (`iterm`, `terminal`, `kitty`, …). Ignored on a headless machine (no `DISPLAY`/`WAYLAND_DISPLAY`). |

```
lofiwave/
├── src/       server.ts (HTTP + API), db.ts, runner.ts, targets.ts, e2b.ts, jobs.ts, capacity.ts, files.ts, connect.ts, vtscreen.ts, scheduler.ts, cron.ts, procs.ts, agents.ts, terminal.ts
├── public/    the single-page UI
├── scripts/   start.sh, service installers, Claude Code session hook, Tailscale helpers
└── data/      database, logs, token (created on first start, git-ignored)
```

## Concepts

**Process type** – a reusable command definition with a `kind`: `agent` (starts interactive, shown under *Sessions*) or `app` (runs headless, shown under *Advanced → Apps*; the default for types added via the API). Two agents are built in and can be edited (not deleted):

| name | kind | command | args | detect |
|---|---|---|---|---|
| `claude` | agent | `claude` | `["-p", "{prompt}"]` | `(^|/|\s)claude(\s|$)` |
| `codex` | agent | `codex` | `["exec", "{prompt}"]` | `(^|/|\s)codex(\s|$)` |

- `args` is a template; `{prompt}` and `{cwd}` are substituted when a process starts. If the template uses `{prompt}`, a prompt is required.
- `detect` is a regex tested against the command line of every OS process; matches show up in the Processes view even if the console did not start them. Leave it empty for types you only launch yourself.
- `env` is a map of extra environment variables applied to every process of that type.
- `default_cwd` lets `POST /api/processes` and workflows omit `cwd` (typical for apps that live in one folder).
- `url` is where the app's own UI lives, if it has one; *Advanced → Apps* shows it as an **Open** link. Write `{host}` for this machine (`http://{host}:8765`): the page substitutes the host it was opened on, so the link works from localhost and over Tailscale alike. The app must listen on an address the client can reach (not only `127.0.0.1`).

Add your own, e.g. a nightly test runner:

```bash
curl -H "authorization: Bearer $TOKEN" -X POST localhost:7770/api/process-types -H 'content-type: application/json' -d '{
  "name": "pytest", "command": "pytest", "args": ["-q", "{cwd}"], "detect": "pytest"
}'
```

**Interactive runs** – agent types start interactive by default (`POST /api/processes` with `interactive: false` for a headless run; apps are the other way round). An interactive run starts the type inside a detached **tmux** session (`ac-<run id>`) that stays open until the program exits or you stop the run. This is how you start a normal `claude` or `codex` TUI from your phone: the built-in `claude` type's interactive template is `claude [prompt] --remote-control`, so the session shows up in the Claude app / claude.ai as soon as it is up (the console picks the `https://claude.ai/code/session_…` link off the screen and shows it on the run as `meta.remote_url`), and the `codex` type opens the Codex TUI. The prompt is optional. Requires `tmux` on PATH. If the console is running on a desktop, it also opens a **real terminal window** attached to that session (iTerm, else Terminal.app, on macOS; the first emulator it finds on Linux) so the session is in front of you on the machine as well as in the browser — set `OPEN_TERMINAL=none` (or `terminal: "none"` on the request) if you don't want that, or `OPEN_TERMINAL=<name>` to pick one. The window is just another tmux client: closing it leaves the run running, and `meta.terminal` records which app was used (`meta.terminal_error` says why none opened). While it runs, *Sessions* shows it as a **real terminal** in the browser (xterm.js over a WebSocket, `GET /api/runs/:id/tty`, to its own `tmux attach` on a pty): colours, full-screen TUIs, Ctrl-keys, paste and mouse-wheel scrolling all work, and several people can watch and type into the same session at once (the window follows whoever typed last). For Claude runs the **Chat** view shows the same live session as messages, tool calls, diffs and images instead, read from its transcript (see *Chat view* below); it scrolls in each browser on its own, has a composer that types into the TUI, and answers Claude's permission prompts, questions and plans. Chat is the default on phones. Run details (*Advanced → Runs*) show a polled screen (`GET /api/runs/:id/screen`) with a text box (`POST /api/runs/:id/keys`) and buttons for Esc, Tab, arrows and Ctrl-C; on the machine itself `tmux attach -t ac-<id>` gives you the real terminal. When it ends, the screen and scrollback are saved as the run log. Each type has its own `interactive_args` template (*Advanced → Types*); when it is empty the normal `args` are used.

**Process** – an OS process that either matches a type's `detect` regex or was started by the console. Console-started processes are *managed*: they have a run record, a log, and can be restarted. Children of a managed process are attributed to the same run (`child: true`).

**Run** – one execution of a type (ad-hoc, from a workflow, or a restart). Statuses: `queued` (waiting for room on the machine, see *Swarms*), `running`, `success` (exit 0), `failed` (non-zero), `killed` (stopped via the console), `timeout`, `lost` (the console restarted and the process was gone), `error` (could not start). Killing a run kills its whole process tree.

**Workflow** – a saved launch: type + folder + prompt + extra args + env, optionally with a cron `schedule`, a `timeout_sec`, and `allow_overlap` (default off: a scheduled tick is skipped and recorded as an `error` run if the previous one is still running). Times use the server's local timezone.

A workflow with an agent type runs **interactive** (when tmux is installed), so you can watch it in *Sessions*, interrupt it or send it a message while it works. It doesn't open a desktop terminal window. A claude run **closes itself** once the agent has finished and stayed idle for `IDLE_STOP_SEC` (default 120s) with nobody watching it (a browser terminal, the simple view, a desktop window or `tmux attach`; the wait starts over while someone is); it is recorded as `success`, with its last screen saved in the log. Other interactive claude runs do the same after `AGENT_IDLE_STOP_SEC` (default 30 minutes) unless started with `stop_when_idle: false`. It is never closed while it waits on a permission prompt. Codex reports no idle state, so a Codex workflow run stays open until you stop it or its `timeout_sec` fires.

**Target** – where a workflow runs. Default: this machine. A workflow keeps its own target; *Run now* takes a different one for a single run (`POST /api/workflows/:id/run {"target": "..."}`).

**E2B target** – an `e2b` target runs each run in its own [E2B](https://e2b.dev) sandbox (a Firecracker microVM) and keeps the live terminal: an interactive run's agent runs in the sandbox, and *Sessions* shows it as a real terminal just like a tmux one (several viewers, colours, resize, Ctrl-keys), plus the simple view (`/screen` and `/keys` work too). Create one under *Settings → Run targets*, or with the API, with `E2B_API_KEY` in lofiwave's environment; then pick it under *Runs on* in *New session*:

```bash
curl -X POST localhost:7770/api/targets -H 'content-type: application/json' -d '{"name": "sandbox", "kind": "e2b",
  "config": {"permission_mode": "bypassPermissions", "idle_sec": 600, "idle_action": "pause"}}'
curl -X POST localhost:7770/api/processes -H 'content-type: application/json' -d '{"type": "claude", "target": "sandbox",
  "prompt": "summarize in/brief.md into out/summary.md", "input_dir": "/path/to/inputs"}'
```

Each run: creates a sandbox from the target's `template` (E2B's stock `claude` by default) → clones `repo` into `workdir` (`/home/user/work`) if set → uploads `input_dir` (a folder here) to `<workdir>/in/` → pre-accepts claude's onboarding, folder-trust, API-key and bypass-permissions prompts → starts the agent (a PTY for interactive runs, plain stdout for headless) with `--permission-mode` from the target (else `CLAUDE_PERMISSION_MODE`) → when it exits, copies its transcript back (Transcript and **Resume here** work as for a local run) and `<workdir>/out/` to `DATA_DIR/runs/<id>/out/` (`meta.e2b.out_dir`) → kills the sandbox (`on_exit: "pause"` keeps it paused instead). Stopping the run sends the agent SIGTERM first, so the transcript still comes back. The sandbox id is in `meta.e2b.sandbox_id`; an interactive agent runs in tmux in the sandbox (installed with apt if the template lacks it; `meta.e2b.tmux`), and what lofiwave follows is a tmux client on it, so after a pause and resume, or a console restart, it attaches a new client and the terminal carries on (without tmux it follows the agent's PTY by its tag, `lofiwave-<run>`, and that stream stays blank after a resume). The agent gets `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from this machine's environment when set (`env_from` changes which), plus the target's `env` and the run's env; never lofiwave's own token. Remote Control (`--remote-control`) is dropped unless an OAuth token goes in. The sandbox lives `timeout_sec` (default 3600; E2B allows 1h on Hobby, 24h on Pro), renewed every minute while the run is going. With `idle_sec`, a run with no output or input for that long (and no terminal open) is paused (`idle_action: "pause"`: memory and disk kept; opening its terminal or sending keys resumes it where it was) or ended (`"stop"`). A workflow on an e2b target runs interactive only when the target has `idle_sec` with `idle_action: "stop"`, so a finished agent doesn't sit open; otherwise headless. CPU and memory come from the template. See [docs/sandboxes.md](docs/sandboxes.md) for how it works and why E2B.

Cron: 5 fields `min hour day-of-month month day-of-week`, with `*`, lists, ranges, steps and month/day names, plus `@hourly @daily @weekly @monthly @yearly`.

The built-in `claude` type keeps Claude Code's permission prompts (see *Security*). A headless run has nobody to answer them, so give it `--permission-mode acceptEdits` (or `--dangerously-skip-permissions`) as extra args, or add it to the type's args under *Advanced → Types*.

Useful extra args: Claude Code `--output-format json`, `--model ...`; Codex `--sandbox workspace-write` (`--full-auto` was removed from Codex), `--skip-git-repo-check`, `-m ...`.

## API

**Live docs:** `GET /api/docs` returns this section as markdown with the real base URL filled in, plus a step-by-step quickstart for registering an app. Give that URL (e.g. `http://my-box:7770/api/docs`) to a coding agent and it has everything it needs. `/docs` shows the same rendered in the browser (linked from the *Connect* page), and `GET /api` returns a JSON index of endpoints. Both are readable without the auth token.

Base URL `http://host:7770/api`. All bodies and responses are JSON. Errors are `{"error": "message"}` with a 4xx/5xx status. Timestamps are Unix milliseconds. Fields that take an argument list (`args`, `extra_args`) accept either a JSON array or a single shell-style string (`"--foo 'a b'"`).

### Auth

Every `/api/*` call needs the token (`AUTH_TOKEN`, or the generated one in `data/auth-token`) or an **API key**, as one of: `Authorization: Bearer <key>`, `X-Auth-Token: <key>`, or `?token=<key>`. `GET /api` and `GET /api/docs` are public; so are the UI's static files.

API keys are named and revocable; make them on the *Connect* page. Runs started with one record `started_by: "key:<name>"`. Only the hash is stored, so a key is shown once. A key can use the whole API except key management.

| | |
|---|---|
| `GET /api/keys` | list: `{id, name, prefix, created_by, created_at, last_used_at}` |
| `POST /api/keys` | create: `{name}` → 201 with the same fields plus `key` (shown only here) |
| `DELETE /api/keys/:id` | revoke |

### System

| | |
|---|---|
| `GET /api/health` | `{ok, uptime_ms}` |
| `GET /api/system` | hostname, platform, bun version, bind host/port, data dir, LAN addresses, tailscale `{state, ips, dns_name}` (null if not installed) |
| `GET /api/system/usage` | what the machine has and what uses it (macOS and Linux; one `ps` per call, so poll it only while you show it): `machine: {mem_total_mb, mem_available_mb, mem_used_mb, swap: {total_mb, used_mb} \| null, cpus, load: [1m, 5m, 15m], cpu_busy_pct, disk: {path, total_mb, free_mb}}` (`cpu_busy_pct` is since the previous call, null on the first; `disk` is the filesystem holding `DATA_DIR`); `lofiwave: {server, tmux, runs: [{run_id, type, kind, workflow_name, group, cwd, started_at, …}], runs_total, total}`, where each entry is a whole process tree `{pid, procs, rss_mb, cpu, elapsed_sec}` (a run counts its tmux pane process and every descendant: claude + node + MCP servers; `tmux` is the tmux server holding the panes; `cpu` is % of one core); `outside: [{type, cmd, …tree}]` and `outside_total`: agents matched by a type's `detect` that lofiwave didn't start; `estimate: {per_agent_mb, per_agent_source: "measured"\|"assumed", measured_runs, min_free_mem_mb, by_memory, max_agent_runs, live_agent_runs, queued, by_slots, can_launch, limited_by: "memory"\|"slots"\|"both", blocked}`: `per_agent_mb` is the average RSS of the live agent runs (600 MB when none run), `by_memory` = (available − `MIN_FREE_MEM_MB`) ÷ `per_agent_mb`, `by_slots` = `MAX_AGENT_RUNS` − live − queued (null with no cap), `can_launch` the smaller |

### Paths

| | |
|---|---|
| `GET /api/paths?q=&limit=20` | working directories for the UI's path picker: `{paths: [{path, source, last_used}], home}`. With no `q`, recent directories from runs, workflows and live processes. With `q`, substring/fuzzy matches on those, plus directory completion on disk when `q` starts with `/`, `~` or `.` (`source: "fs"`). |

### Process types

| | |
|---|---|
| `GET /api/process-types` | list; each has `kind`, `default_cwd`, `available` (binary found on PATH) and `resolved` path |
| `GET /api/process-types/:name` | one |
| `POST /api/process-types` | create: `{name, command, args?, interactive_args?, resume_args?, env?, detect?, description?, kind?: "agent"\|"app", default_cwd?, url?}` → 201 |
| `PUT /api/process-types/:name` | update any subset of `command, args, interactive_args, resume_args, env, detect, description, kind, default_cwd, url` |
| `DELETE /api/process-types/:name` | delete (built-ins and types used by a workflow are refused) |

### Processes (live view)

| | |
|---|---|
| `GET /api/processes?type=&kind=` | running processes matching any type (filter by type name or kind): `{pid, ppid, user, cmd, cwd, elapsedSec, rssKb, cpu, type, managed, child, run_id, workflow_name, session}` – `session` is `{session_id, agent, title, name, status, model, web_url, resume_cmd, ...}` or null |
| `POST /api/processes` | start one: `{type, cwd?, prompt?, extra_args?, env?, timeout_sec?, interactive?, stop_when_idle?, idle_stop_sec?, trust?, terminal?, group?, parent_run?, files?, mkdir_cwd?, queue?}` → 201 with the run record. `cwd` falls back to the type's `default_cwd`. `interactive` (default: true for agent types when tmux is installed) starts it in a tmux session that stays open (see Concepts). An interactive claude run ends once it has been idle, with nobody watching, for `AGENT_IDLE_STOP_SEC` (default 1800); `stop_when_idle: true` makes that `IDLE_STOP_SEC` (120, like a workflow run), `false` keeps it open, and `idle_stop_sec` sets the seconds (0 = never). `trust` (default true) marks the folder trusted for claude and answers its trust dialog (see *Security*). A switch in `extra_args` that the type's template already passes (`--remote-control`) is not passed twice. The rest is for running agents as jobs (see *Swarms* below): `group` tags the run, `parent_run` (or an `X-Lofiwave-Run: <run id>` header) names the run that started it, `files` (`{"rel/path": "utf-8 text" or {"base64": "..."}}`) are written into `cwd` before it starts, `mkdir_cwd: true` creates a missing `cwd` (under `CWD_ROOTS`), and when the machine is full an agent run gets **429** unless `queue: true`, which answers **202** with a `queued` run. |
| `POST /api/processes/preview` | same body; returns the `{command, args}` that would be executed, without running |
| `DELETE /api/processes/:pid?force=1` | SIGTERM (or SIGKILL with `force`) the process **tree**. Works on unmanaged processes too. If the pid belongs to a run, the run is marked `killed`. |
| `POST /api/processes/:pid/remote-control` | Turn on Remote Control for a claude session that is already running, so it shows up in the Claude app. If it is in a tmux pane (an interactive run, or any claude started inside tmux), or on macOS in an iTerm or Terminal.app tab (found by its tty; the first time, macOS asks to let lofiwave control that app), the console clears its input box (Ctrl+Y brings a draft back) and types `/remote-control`, so the session keeps running; it refuses while the session is working. → `{status: "enabled"\|"pending"\|"already", web_url}`. Anywhere else there is nothing to type into: `{replace: true, terminal?}` stops the process and reopens the same conversation here in tmux with the type's `resume_args` → 201 `{status: "replaced", run}`; without `replace` it answers 409. |

Restarting is done through the run: `POST /api/runs/:id/restart`.

### Workflows

| | |
|---|---|
| `GET /api/workflows` | list (includes `next_run_at`, `last_run_at`, `last_run: {id, status, started_at, ended_at}`) |
| `GET /api/workflows/:id` | one |
| `POST /api/workflows` | create: `{name, type, cwd?, prompt?, extra_args?, env?, schedule?, enabled?, timeout_sec?, allow_overlap?, target?}` → 201. `target` is a target's name (`""` = this machine); with one, `cwd` is optional: the folder here its claude conversation is filed under, to resume. |
| `PUT /api/workflows/:id` | partial update of the same fields (e.g. `{"enabled": false}`) |
| `DELETE /api/workflows/:id` | delete; past runs are kept (their `workflow_id` becomes null, `workflow_name` stays) |
| `POST /api/workflows/:id/run` | run now → 201 with the run record; 409 if already running and overlap is off. Optional `{target}` runs it there this once (`""` = this machine). |

### Targets

| | |
|---|---|
| `GET /api/targets` | `{kinds, e2b_key, targets: [{id, name, kind, config, workflows}]}` (`e2b_key` = whether `E2B_API_KEY` is set) |
| `GET /api/targets/:name` | one |
| `POST /api/targets` | create: `{name, kind: "e2b", config: {template?: "claude", api_key_env?: "E2B_API_KEY", workdir?: "/home/user/work", repo?, env?, env_from?: {SANDBOX_VAR: "LOCAL_VAR"}, permission_mode?, timeout_sec?: 3600, idle_sec?: 0, idle_action?: "pause"\|"stop", on_exit?: "kill"\|"pause"}}` → 201 |
| `PUT /api/targets/:name` | `{config}`: any subset of the fields above |
| `DELETE /api/targets/:name` | delete (refused while a workflow uses it) |
| `POST /api/targets/:name/check` | is it usable from here: `{ok, running, error?}` (the key works; how many sandboxes it has running) |

`POST /api/processes` takes `target` too (and, for an e2b target, `input_dir`; agents start interactive there). A run on a target has `meta.target` and, once started, `meta.e2b: {tag, sandbox_id, pid, tmux?, paused?, out_dir?, out_files?}`.

### Runs

| | |
|---|---|
| `GET /api/runs?workflow_id=&status=&type=&trigger=&group=&parent_run=&limit=50&offset=0` | newest first: `{total, limit, offset, runs: [...]}` (without `output`) |
| `GET /api/runs/:id` | full record incl. `output` (log tail), `duration_ms`, `live`, `session_id` (the agent session it is on now, the latest in `sessions`; null until one is known) |
| `GET /api/runs/:id/log?offset=0` | `{data, offset, size, status}` – poll with the returned `offset` to tail a running log |
| `GET /api/runs/:id/log?raw=1` | the whole log as `text/plain` |
| `POST /api/runs/:id/pin` | `{pinned: true\|false}` (default true): pin the run to the top of the *Sessions* list, or unpin it → updated run (`pinned_at` is when it was pinned, else null) |
| `POST /api/runs/:id/kill?force=1` | stop (tree) → updated run. A `queued` run is taken out of the queue (`killed`). |
| `POST /api/runs/:id/restart` | start a new run with the same parameters (kills the old one first if it is running) → 201 |
| `GET /api/runs/:id/wait?until=idle&timeout=60&after=` | long-poll: answers once the run is `idle` (its turn is over, it waits on a prompt, or it ended) or `done` (ended), or after `timeout` seconds (max 600). `after` (Unix ms, e.g. a message's `sent_at`): only an idle that began then or later counts. → the run (without `output`) plus `{reached, timed_out, waited_ms}`. An agent running monitors or background tasks may never be idle: each task notification starts a new turn. To wait for the answer to a message use `until=replied`. |
| `GET /api/runs/:id/wait?until=replied&message=<message_id>&timeout=60` | long-poll until the turn that read that message is over (or it was taken out of the queue unread, or the run ended): the run plus `{reached, timed_out, waited_ms, message}`, `message` as below |
| `GET /api/runs/:id/screen?lines=200&cols=` | interactive runs: `{text, alive, cols, error?}` – the terminal's last `lines` lines (scrollback + screen). `cols` (40–220) resizes the tmux window to the viewer's width first, so the TUI reflows for a phone. `error` is set when tmux couldn't read the screen this time (an empty `text` then means nothing). Reading the screen counts as watching the run (it won't be closed for idling). Plain text with the styling stripped: a dim suggested prompt in claude's input box looks typed, though nobody typed it. To follow an agent use `activity`, `wait` and `sessions/:session_id/messages` instead. |
| `POST /api/runs/:id/message` | interactive runs: send the agent a message and check it arrived: `{text}` → `{message_id, delivered, queued, attempts, sent_at, run}`. Long or multi-line text goes in as one bracketed paste; Enter is pressed once the text has landed, and again (up to 3 times) while claude's input box still holds it. `delivered` is true once claude's input box has emptied, false if it never did, null for a TUI whose input box can't be read (codex). `queued`: the agent was mid-turn and reads it when the turn ends. 409 while it waits on a prompt (permission, trust): answer that with `keys`. Keep `message_id`: `GET …/messages/:message_id` says what became of it and gives the reply. |
| `GET /api/runs/:id/messages/:message_id?wait=` | what became of a message sent with `message`, read from the Claude transcript: `{message_id, text, sent_at, delivered, queued, state, queued_at, read_at, read_as, prompt_id, removed_reason, reply, answered_at, session_id, transcript_path, tracked, note?}`. `state`: `sent` (not in the transcript yet), `queued` (in Claude Code's queue: it is busy and hasn't read it), `answering` (read; the turn that read it is still going), `answered` (that turn is over), `removed` (taken out of the queue unread, `removed_reason` says why), `not_delivered`. `read_as`: `turn` (it started its own turn, `prompt_id`) or `mid_turn` (handed to the running turn between tool calls). `reply`: `{text, messages: [{text, at}], done, interrupted, at}`, what the assistant said from reading it to the end of that turn (so far, while `answering`). `wait` (seconds, max 600) long-polls until `answered`/`removed`, adding `{reached, timed_out, waited_ms}`. `tracked: false` (with a `note`) for runs whose replies can't be read this way: not claude, or on a target. |
| `GET /api/runs/:id/messages?limit=20` | the last `limit` messages sent to the run with `message`, oldest first, each as above |
| `POST /api/runs/:id/keys` | interactive runs: raw keystrokes, for a menu or prompt (send messages with `message`): `{text?, keys?: ["Down", "Escape", "C-c", ...], enter?: true}` (`keys` are tmux key names, sent after `text`). `text` with `enter` and no `keys` is delivered like `message` (unless the agent waits on a prompt) and the answer includes `delivered` and `attempts`. |
| `DELETE /api/runs/:id` | delete record + log (must not be running) |

Run record fields: `id, workflow_id, workflow_name, type_name, type (the same as type_name), cwd, command, args, prompt, env, trigger (manual|schedule|restart), status, pid, started_at, ended_at, exit_code, log_path, output, error, pinned_at, live, duration_ms, activity, activity_since, waiting_for?, group, parent_run, out_dir, meta {timeout_sec, orphan, interactive, tmux, stop_when_idle, idle_stop_sec, trust, group, parent_run, queued_at, ...}`. `GET /api/runs/:id` also includes `sessions` (below).

`activity` is what the agent is doing now: `working` (on a turn), `idle` (its turn is over), `waiting_input` (a permission prompt or question, or the folder trust dialog; `waiting_for` says which when known) or `done` (the run ended); `activity_since` is when that began. For claude it comes from Claude Code's own session registry; for other TUIs from the screen (`esc to interrupt` means working); a headless run is `working` until it ends.

List shapes: `GET /api/runs` is paginated, so its list is under `runs`; the other list endpoints (`/processes`, `/workflows`, `/process-types`, `/runs/:id/sessions`) return a bare array.

### Swarms: runs as jobs (groups, files, results, capacity)

For a controller (a person's script, or an agent that is itself a lofiwave run) starting workers and collecting what they produce, without SSH, tar pipes or another user's home directory. Files are read and written as the console's own user.

- **Group.** Runs started for one job share a `group` (`[A-Za-z0-9_.:@-]`, up to 100). A run started from inside another lofiwave run can pass `"parent_run": $AGENT_CONSOLE_RUN_ID` (or the header `X-Lofiwave-Run: $AGENT_CONSOLE_RUN_ID`); it then joins the parent's group unless it names its own. Restarting a run keeps both.
- **Output folder.** Every run gets `LOFIWAVE_OUT_DIR=<cwd>/out` in its environment, and the folder is created (except in the home folder or `/`). Tell workers to put their results there (`$LOFIWAVE_OUT_DIR/REPORT.md`); `GET /api/runs/:id/results` returns them.
- **Capacity.** At most `MAX_AGENT_RUNS` agent runs at once, and none started while less than `MIN_FREE_MEM_MB` of memory is available (app types are not limited). Over that, starting an agent run answers **429** with the reason; with `queue: true` it is kept as a run with status `queued` and started, oldest first, one at a time, as soon as there is room (the queue survives a console restart). While runs are queued, new ones queue behind them. The limit holds for every agent start (the UI, restarts, resumes, workflows); only `POST /api/processes` can queue, and a scheduled workflow that finds the machine full is recorded as an `error` run. `GET /api/system` shows `capacity: {max_agent_runs, live_agent_runs, queued, mem_available_mb, min_free_mem_mb, blocked}`. `GET /api/system/usage` (*Advanced → System* in the UI) measures what the live agents really use and estimates how many more fit.

| | |
|---|---|
| `GET /api/groups` | `[{group, total, by_status: {running: 2, success: 3, ...}, first_started_at, last_started_at}]`, most recently active first |
| `GET /api/runs?group=<g>` | the group's runs (also `?parent_run=<id>`: the runs a controller started) |
| `PUT /api/runs/:id/files?path=<rel>` | raw body → that file in the run's folder (parent folders made as needed) → 201 `{path, size}`. With `?extract=1` (or `content-type: application/gzip` / `application/x-tar`) the body is a tar or tar.gz, unpacked into `path` (a folder; `""` = the run's folder) → 201 `{extracted: [{path, size}], dirs, skipped}`. Only regular files and folders are unpacked; links, devices and macOS metadata (`._*`, `.DS_Store`, `__MACOSX/`) are skipped. |
| `GET /api/runs/:id/files?path=<rel>` | a file's contents; for a folder, `{path, type: "dir", entries: [{path, type, size, mtime}], truncated}` (`&recursive=1` walks subfolders), or with `&archive=1` the folder as a `.tar.gz` download. `path` defaults to the run's folder. |
| `GET /api/runs/:id/results` | what the run left in `out/`: `{run_id, status, out_dir, exists, files: [{path, type, size, mtime, text?}], truncated}`; UTF-8 files up to 64 KB come inlined as `text` (1 MB in all) |

Paths are relative to the run's `cwd` and must stay inside it: absolute paths, `..` that leaves it, and symlinks that point outside it are refused with 400. This also works before the run starts (`files` on `POST /api/processes`) and after it ends.

```bash
# controller: start a worker with its brief, in a fresh folder, waiting for room if the machine is full
curl -H "authorization: Bearer $TOKEN" -X POST localhost:7770/api/processes -H 'content-type: application/json' -d '{
  "type": "claude", "cwd": "/home/me/jobs/fix-42/worker-1", "mkdir_cwd": true, "queue": true,
  "group": "fix-42", "parent_run": '"$AGENT_CONSOLE_RUN_ID"', "interactive": false,
  "prompt": "Follow BRIEF.md. Write your findings to $LOFIWAVE_OUT_DIR/REPORT.md.",
  "extra_args": "--permission-mode acceptEdits",
  "files": {"BRIEF.md": "# Task\n..."} }'
# more inputs, as a tarball
tar -czf - data/ | curl -H "authorization: Bearer $TOKEN" -X PUT --data-binary @- -H 'content-type: application/gzip' 'localhost:7770/api/runs/57/files?path=inputs'
# how is the swarm doing, and what did worker 57 produce
curl -H "authorization: Bearer $TOKEN" 'localhost:7770/api/runs?group=fix-42'
curl -H "authorization: Bearer $TOKEN" localhost:7770/api/runs/57/results
```

### Sessions (linking a run to its Claude Code transcript)

Every process the console starts gets `AGENT_CONSOLE_RUN_ID`, `AGENT_CONSOLE_URL` and `AGENT_CONSOLE_TOKEN` in its environment. `scripts/claude-session-hook.sh` is a Claude Code **SessionStart / SessionEnd hook** that, when those variables are present, reports the session back to the console; in any other Claude session it exits immediately. Install it once, globally, in `~/.claude/settings.json` (absolute path):

```json
{ "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/lofiwave/scripts/claude-session-hook.sh", "timeout": 5 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/lofiwave/scripts/claude-session-hook.sh", "timeout": 5 }] }]
} }
```

It works for `claude` started directly by the console *and* for claude processes started by a wrapper script the console launched (the environment is inherited). The hook isn't the only way in: while an interactive claude run is followed, the console also records the session its process is on from Claude's pid registry (`source: "registry"`, which also follows a `/clear` or a resume to the new id), from each turn's `UserPromptSubmit`/`Stop` hook (`source: "turn hook"`), and, for a run with no session at all, from the transcript a message sent with `POST /message` turned up in (`source: "message"`). These never overwrite what the hook reported. Codex needs no hook: the console reads the `session id:` that `codex exec` prints, or finds the rollout file a Codex TUI creates under `~/.codex/sessions`.

On top of the recorded id, the console reads what the agents themselves know: Claude Code's per-process registry (`~/.claude/sessions/<pid>.json`: the **name** it gave the session – what the Claude app shows – its idle/working **status** and its Remote Control bridge) and the transcript (auto **title**, `/rename` title, model). That is also how *Advanced → Processes* labels claude processes you started from a terminal. Each session in the UI shows title/name, id, model, and offers **Open on web** (the same session on claude.ai, when it has Remote Control), **Resume here** (reopens it in a tmux session on this machine using the type's `resume_args`; for claude that is `claude --resume <id> --dangerously-skip-permissions --remote-control`, so it appears in the Claude app too), **Copy resume** (the terminal command) and **Transcript**.

| | |
|---|---|
| `GET /api/runs/:id/sessions` | `[{session_id, agent, cwd, transcript_path, model, source, started_at, ended_at, end_reason, title, name, status, web_url, resume_cmd}]` |
| `POST /api/runs/:id/sessions/:session_id/resume` | reopen the session interactively (tmux) → 201 with the new run |
| `POST /api/sessions/resume` | same for a session the console did not start: `{agent: "claude"\|"codex", session_id, cwd?, terminal?}` → 201. If the session is still open elsewhere, claude continues it as a copy under a new id. |
| `POST /api/runs/:id/sessions` | register (upsert by `session_id`): `{session_id, agent?, cwd?, transcript_path?, model?, source?}` → 201 |
| `PUT /api/runs/:id/sessions/:session_id` | `{ended: true, reason?, model?}` marks it ended |
| `GET /api/runs/:id/sessions/:session_id/transcript` | the raw JSONL transcript (`text/plain`; only files under the home directory are served) |
| `GET /api/runs/:id/sessions/:session_id/messages?limit=500` | the same conversation, readable: `[{role: user\|assistant\|tool, text, at}]`, newest `limit` (thinking and tool output left out); *Sessions → Ended* shows it |

### Chat view (a Claude session read from its transcript)

The Console's **Chat** view, and **View chat** on Claude sessions lofiwave didn't start, show a session as messages, tool calls, diffs and images. The TUI in tmux stays the only process running the session: the server only tails its transcript (`~/.claude/projects/…/<session>.jsonl`), follows the active branch (rewinds and edits leave old branches in the file), switches files on `/clear`, and reads the live idle/busy/waiting status from Claude's own `~/.claude/sessions/<pid>.json`. On a live run of ours the view has a composer that types into the TUI through tmux: text goes in as one bracketed paste, images as pasted paths (the TUI attaches them), other files as `@path` references. A message sent while Claude works is queued by the TUI. Sending is refused while Claude waits on a dialog, and when the terminal's input box already holds an unsent draft the server asks what to do with it. Permission prompts, Claude's questions (AskUserQuestion) and plan approval show up as cards above the composer: interactive claude runs start with `--settings data/claude-chat.json`, which adds an HTTP `PermissionRequest` hook pointing back at lofiwave (it merges with your own hooks). The server holds the hook open until someone answers in the browser; the TUI shows its own dialog at the same time, and whichever is answered first wins. A run started with its own `--settings` doesn't get the hook, and anything no card covers (menus, the trust prompt) still shows the "terminal needs you" banner. Edited files open in a **files panel** beside the conversation, from an edit row, the "Edited N files" card at the end of a turn, or a path in Claude's text (linked only when the file exists): the edit's diff, the file as it is on disk now (scrolled to the line), and a rendered preview for markdown and images. Only files in the session's folder or your home directory are shown, after resolving symlinks, up to 1 MB. The same `--settings` file also streams Claude's text into the view as it's written (a `MessageDisplay` hook that lofiwave answers at once), shows the model, context use, cost and rate limits in the footer (a `statusLine` command, `scripts/claude-statusline.ts`, which passes a copy to lofiwave and still runs your own statusline), and takes **git checkpoints** when a prompt is sent and when Claude stops (`UserPromptSubmit` and `Stop` hooks). Each checkpoint is a commit built in a throwaway index and kept under `refs/lofiwave/run-<id>/…`, so your branch, index and stash are never touched. Untracked files follow `.gitignore`, and ones over 5 MB are skipped. A finished turn's card then lists everything it changed, including files written by commands, and opens each file's diff for that turn. Deleting the run deletes its refs. Any session also shows its task list (Claude's `~/.claude/tasks/<session>/`) as a strip above the composer while anything on it is open. Sessions lofiwave didn't start stay read-only. Design and the phases still to come: [`docs/rendered-view.md`](docs/rendered-view.md).

| | |
|---|---|
| `GET /api/runs/:id/chat` (WebSocket) | live feed: `{t:"hello", session_id, cwd, status, items, floor, has_earlier, requests, todos, usage, changes}` with the last 30 turns, then `{t:"items", upsert, remove}` (whole items, keyed by `id`; text Claude is still writing is an assistant item with `streaming: true`), `{t:"status", status, waiting_for, read_only}`, `{t:"requests", requests}` (the approvals waiting on an answer), `{t:"todos", todos}` (`[{text, active, status}]`), `{t:"usage", usage}` (`{model, context_pct, context_tokens, context_size, cost_usd, rate_limits}`) and `{t:"changes", changes}` (each finished turn's git changes, by prompt id) |
| `GET /api/runs/:id/chat?before=<ordinal>` | the 30 turns before `before`: `{session_id, items, floor, has_earlier}` |
| `GET /api/runs/:id/chat/blob?ref=&agent=` | a payload too big to send inline (`{omitted: true, bytes, preview, blob}` in an item): an image, a long output or a diff |
| `GET /api/runs/:id/chat/subagent/:agent_id` | a subagent's own conversation: `{agent_id, items}` |
| `GET /api/runs/:id/chat/file?path=` | a file as it is on disk now, for the files panel: `{path, size, mtime, text}` (or `binary` / `image` instead of `text`). `path` may be relative to the session's cwd or start with `~/`; only files in the cwd or the home directory (after `realpath`), up to 1 MB. `&raw=1` returns an image's bytes |
| `POST /api/runs/:id/chat/paths` | `{paths: [...]}` → `{files: {<path as given>: <absolute path>}}` for the ones that are files the panel would show (up to 300) |
| `/api/sessions/:session_id/chat…` | the same six, for any Claude session on this machine by id (read-only) |
| `POST /api/runs/:id/chat/send` | `{text, files?: [upload ids], draft?: "replace"\|"append"}` types a message into the run's TUI and presses Enter: `{ok, queued, opens_menu}`. 409 while Claude waits on a dialog, or `{error, draft}` when the input box has an unsent draft (send again with `draft`) |
| `POST /api/runs/:id/chat/interrupt` | Escape, only while Claude is working |
| `POST /api/runs/:id/uploads?name=` | the raw file as the body (20 MB cap): `{id, name, kind, bytes}`. Saved under `data/uploads/<run>/` (mode 600, HEIC converted to PNG on macOS) and deleted with the run |
| `GET /api/runs/:id/chat/commands` | the `/` list: built-ins (`menu: true` when it opens a TUI menu), and commands and skills from the project, the user and installed plugins |
| `GET /api/runs/:id/chat/screen?lines=20` | the bottom of the terminal as text, for the "terminal needs you" banner |
| `GET /api/runs/:id/chat/requests` | the approvals Claude is waiting on: `{requests: [{id, kind: "permission"\|"question"\|"plan", tool_name, tool_input, suggestions, mode, item_id?}]}` |
| `POST /api/runs/:id/chat/requests/:request_id` | answer one: `{decision: "allow"\|"deny", suggestion?, answers?, mode?, message?}`. `suggestion` is an index into `suggestions` ("always allow …"); `answers` maps each question to its label(s), comma-separated; `mode` (`acceptEdits`, `default`, `auto`, `bypassPermissions`) is where an approved plan continues; `message` tells Claude why it was denied. 409 once it's gone (answered in the terminal) |
| `POST /api/hooks/permission` | called by Claude's `PermissionRequest` hook (token in `Authorization`, run in `X-Lofiwave-Run`); held open until answered, or `{}` to leave it to the TUI |
| `GET /api/runs/:id/chat/changes?prompt=` | what a turn changed in git: `{root, files: [{path, status, added, removed, binary?}], added, removed, truncated, live}`; 404 without checkpoints |
| `GET /api/runs/:id/chat/changes/file?prompt=&path=` | one file's change in that turn: `{hunks, binary}` (hunks as in `structuredPatch`) |
| `POST /api/hooks/message`, `/api/hooks/turn`, `/api/hooks/statusline` | called by Claude's `MessageDisplay`, `UserPromptSubmit`/`Stop` hooks and by `scripts/claude-statusline.ts` (same headers as above); all reply `{}` |

### Examples

```bash
TOKEN=$(cat data/auth-token)   # or your AUTH_TOKEN

# Start Claude Code headlessly in a repo, auto-accepting edits, with a 30 min cap
curl -H "authorization: Bearer $TOKEN" -X POST localhost:7770/api/processes -H 'content-type: application/json' -d '{
  "type": "claude", "cwd": "/path/to/repo",
  "prompt": "Run the test suite and fix any failures.",
  "extra_args": "--permission-mode acceptEdits", "timeout_sec": 1800 }'

# Nightly Codex review at 02:00 on weekdays
curl -H "authorization: Bearer $TOKEN" -X POST localhost:7770/api/workflows -H 'content-type: application/json' -d '{
  "name": "nightly-review", "type": "codex", "cwd": "/path/to/other-repo",
  "prompt": "Review yesterday'"'"'s commits and write findings to REVIEW.md",
  "extra_args": ["--sandbox", "workspace-write"], "schedule": "0 2 * * 1-5", "timeout_sec": 3600 }'

# Tail a running log
curl -H "authorization: Bearer $TOKEN" 'localhost:7770/api/runs/12/log?offset=0'

# Stop a Claude session you started in a terminal
curl -H "authorization: Bearer $TOKEN" -X DELETE localhost:7770/api/processes/41617
```

## Notes

- Processes launched by the console keep running if the console itself restarts. On startup it follows interactive runs (tmux) again: their activity, idle stop and final status (from the pane's exit code) work as before, and their log gets the final screen. Headless runs still alive are marked *orphan* (log capture is not possible for them) and are marked `lost` once they're gone, like any run whose process vanished.
- Agents are launched with the console's environment plus the type's and workflow's `env`, and `AGENT_CONSOLE_RUN_ID` set to the run id.
- Process discovery uses `ps` on Linux/macOS and `Get-CimInstance Win32_Process` on Windows; working directories come from `/proc` (Linux) or `lsof` (macOS).

## License

MIT. See [LICENSE](LICENSE).
