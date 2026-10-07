<p align="center"><img src="public/logo.png" width="96" alt=""></p>

# lofiwave

A small web console for the coding agents running on your machine: Claude Code, Codex, or any command you describe.

- **See** every agent process on the machine, including ones you started in a terminal: its session name, status (working / idle), model, and its claude.ai link.
- **Start, stop and restart** agents in a chosen folder, headless (`claude -p`) or **interactive**: the real TUI in a tmux session you can watch and type into from the browser, and with Claude Code's Remote Control on, in the Claude app too.
- **Turn on Remote Control** for a Claude Code session that is already running.
- **Schedule workflows** (cron) that launch an agent in a folder, with a **history of runs**: status, exit code, duration, full logs.
- A REST API for all of it, documented at `/api/docs`, so other agents can drive it too.

It runs on [Bun](https://bun.sh) with SQLite and no other dependencies. Linux and macOS are the main targets; Windows is best-effort (no interactive runs).

## Requirements

- [Bun](https://bun.sh) 1.1+
- [tmux](https://github.com/tmux/tmux), for interactive runs (`brew install tmux` / `apt install tmux`)
- The agents you want to drive, on `PATH`: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), …

## Install

```bash
git clone https://github.com/synjuku/lofiwave.git
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

Add `scripts/claude-session-hook.sh` as a Claude Code `SessionStart` and `SessionEnd` hook in `~/.claude/settings.json` (the snippet is at the top of the script). Claude sessions the console starts then report their session id back, which gives runs their transcript, title and a *Resume* button. For any other Claude session the hook exits immediately.

## Security

The console starts agents and kills processes, so treat its token like a password.

- **Local only by default.** It listens on `127.0.0.1`. Set `HOST` to make it reachable from other machines (see *Remote access*).
- **Always a token.** Every API call needs it, on localhost too: any web page open in a browser on this machine can send requests to `127.0.0.1`. It comes from `AUTH_TOKEN`, or is generated into `data/auth-token` (mode 600).
- **Agents ask before acting.** The built-in `claude` type keeps Claude Code's permission prompts. In an interactive run you answer them in the browser or the Claude app; a headless `claude -p` run can't, so tools that need permission are refused. To let runs go unattended, add `--permission-mode acceptEdits` (or `--dangerously-skip-permissions`, if you understand what that allows) to the type's args on the *Types* tab, or per run as extra args.
- `data/` (database, run logs, which include agent output) is created owner-only.
- Agents started by the console get `AGENT_CONSOLE_URL` and `AGENT_CONSOLE_TOKEN` in their environment (that's how the session hook reports back), so an agent the console started can use the console's API.

## Remote access

To use it from your phone or another computer, put it on a private network rather than the internet. With [Tailscale](https://tailscale.com):

```bash
# keep the default HOST=127.0.0.1 and let tailscale proxy to it, with HTTPS, reachable only from your tailnet:
sudo tailscale serve --bg 7770      # → https://<machine>.<tailnet>.ts.net
```

Or set `HOST=0.0.0.0` in `.env` and use `http://<machine>:7770` over the tailnet; that also exposes it to your LAN, still behind the token. On a new device, open the link with `#token=…` once, or paste the token when asked. The UI is responsive: on a phone the tabs move to a bottom bar, a run opens full screen, and an interactive run's terminal is resized to the phone's width.

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
| `SCHEDULER_INTERVAL_MS` | `15000` | How often scheduled workflows are checked |
| `OUTPUT_TAIL_BYTES` | `65536` | How much of the end of each log is copied into the run record (`output`) |
| `OPEN_TERMINAL` | `auto` | Desktop terminal window opened on an interactive run. `auto` = iTerm then Terminal.app on macOS, the first of wezterm/kitty/alacritty/ghostty/foot/gnome-terminal/konsole/tilix/xfce4-terminal/mate-terminal/terminator/urxvt/xterm found on Linux; `none` to keep runs headless; or name one (`iterm`, `terminal`, `kitty`, …). Ignored on a headless machine (no `DISPLAY`/`WAYLAND_DISPLAY`). |

```
lofiwave/
├── src/       server.ts (HTTP + API), db.ts, runner.ts, scheduler.ts, cron.ts, procs.ts, agents.ts, terminal.ts
├── public/    the single-page UI
├── scripts/   start.sh, service installers, Claude Code session hook, Tailscale helpers
└── data/      database, logs, token (created on first start, git-ignored)
```

## Concepts

**Process type** – a reusable command definition with a `kind`: `agent` (shown on the *Agents* tab) or `app` (shown on the *Apps* tab; the default for types added via the API). Two agents are built in and can be edited (not deleted):

| name | kind | command | args | detect |
|---|---|---|---|---|
| `claude` | agent | `claude` | `["-p", "{prompt}"]` | `(^|/|\s)claude(\s|$)` |
| `codex` | agent | `codex` | `["exec", "{prompt}"]` | `(^|/|\s)codex(\s|$)` |

- `args` is a template; `{prompt}` and `{cwd}` are substituted when a process starts. If the template uses `{prompt}`, a prompt is required.
- `detect` is a regex tested against the command line of every OS process; matches show up in the Processes view even if the console did not start them. Leave it empty for types you only launch yourself.
- `env` is a map of extra environment variables applied to every process of that type.
- `default_cwd` lets `POST /api/processes` and workflows omit `cwd` (typical for apps that live in one folder).
- `url` is where the app's own UI lives, if it has one; the Apps tab shows it as an **Open** link. Write `{host}` for this machine (`http://{host}:8765`): the page substitutes the host it was opened on, so the link works from localhost and over Tailscale alike. The app must listen on an address the client can reach (not only `127.0.0.1`).

Add your own, e.g. a nightly test runner:

```bash
curl -H "authorization: Bearer $TOKEN" -X POST localhost:7770/api/process-types -H 'content-type: application/json' -d '{
  "name": "pytest", "command": "pytest", "args": ["-q", "{cwd}"], "detect": "pytest"
}'
```

**Interactive runs** – `POST /api/processes` with `interactive: true` (or the *Interactive* checkbox in the Start dialog) starts the type inside a detached **tmux** session (`ac-<run id>`) that stays open until the program exits or you stop the run. This is how you start a normal `claude` or `codex` TUI from your phone: the built-in `claude` type's interactive template is `claude [prompt] --remote-control`, so the session shows up in the Claude app / claude.ai as soon as it is up (the console picks the `https://claude.ai/code/session_…` link off the screen and shows it on the run as `meta.remote_url`), and the `codex` type opens the Codex TUI. The prompt is optional. Requires `tmux` on PATH. If the console is running on a desktop, it also opens a **real terminal window** attached to that session (iTerm, else Terminal.app, on macOS; the first emulator it finds on Linux) so the session is in front of you on the machine as well as in the browser — set `OPEN_TERMINAL=none` (or `terminal: "none"` on the request) if you don't want that, or `OPEN_TERMINAL=<name>` to pick one. The window is just another tmux client: closing it leaves the run running, and `meta.terminal` records which app was used (`meta.terminal_error` says why none opened). While it runs, the Console tab shows it as a **real terminal** in the browser (xterm.js over a WebSocket, `GET /api/runs/:id/tty`, to its own `tmux attach` on a pty): colours, full-screen TUIs, Ctrl-keys, paste and mouse-wheel scrolling all work, and several people can watch and type into the same session at once (the window follows whoever typed last). The **Simple view** button (the default on phones) switches to a polled screen (`GET /api/runs/:id/screen`) and a text box (`POST /api/runs/:id/keys`) with buttons for Esc, Tab, arrows and Ctrl-C — better on a flaky link; on the machine itself `tmux attach -t ac-<id>` gives you the real terminal. When it ends, the screen and scrollback are saved as the run log. Each type has its own `interactive_args` template (Types tab); when it is empty the normal `args` are used.

**Process** – an OS process that either matches a type's `detect` regex or was started by the console. Console-started processes are *managed*: they have a run record, a log, and can be restarted. Children of a managed process are attributed to the same run (`child: true`).

**Run** – one execution of a type (ad-hoc, from a workflow, or a restart). Statuses: `running`, `success` (exit 0), `failed` (non-zero), `killed` (stopped via the console), `timeout`, `lost` (the console restarted and the process was gone), `error` (could not start). Killing a run kills its whole process tree.

**Workflow** – a saved launch: type + folder + prompt + extra args + env, optionally with a cron `schedule`, a `timeout_sec`, and `allow_overlap` (default off: a scheduled tick is skipped and recorded as an `error` run if the previous one is still running). Times use the server's local timezone.

Cron: 5 fields `min hour day-of-month month day-of-week`, with `*`, lists, ranges, steps and month/day names, plus `@hourly @daily @weekly @monthly @yearly`.

The built-in `claude` type keeps Claude Code's permission prompts (see *Security*). A headless run has nobody to answer them, so give it `--permission-mode acceptEdits` (or `--dangerously-skip-permissions`) as extra args, or add it to the type's args on the *Types* tab.

Useful extra args: Claude Code `--output-format json`, `--model ...`; Codex `--full-auto`, `--skip-git-repo-check`, `-m ...`.

## API

**Live docs:** `GET /api/docs` returns this section as markdown with the real base URL filled in, plus a step-by-step quickstart for registering an app. Give that URL (e.g. `http://lucas-xps-8930:7770/api/docs`) to a coding agent and it has everything it needs. `/docs` shows the same rendered in the browser (the **API** button in the UI header), and `GET /api` returns a JSON index of endpoints. Both are readable without the auth token.

Base URL `http://host:7770/api`. All bodies and responses are JSON. Errors are `{"error": "message"}` with a 4xx/5xx status. Timestamps are Unix milliseconds. Fields that take an argument list (`args`, `extra_args`) accept either a JSON array or a single shell-style string (`"--foo 'a b'"`).

### Auth

Every `/api/*` call needs the token (`AUTH_TOKEN`, or the generated one in `data/auth-token`), as one of: `Authorization: Bearer <token>`, `X-Auth-Token: <token>`, or `?token=<token>`. `GET /api` and `GET /api/docs` are public; so are the UI's static files.

### System

| | |
|---|---|
| `GET /api/health` | `{ok, uptime_ms}` |
| `GET /api/system` | hostname, platform, bun version, bind host/port, data dir, LAN addresses, tailscale `{state, ips, dns_name}` (null if not installed) |

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
| `POST /api/processes` | start one: `{type, cwd?, prompt?, extra_args?, env?, timeout_sec?, interactive?, terminal?}` → 201 with the run record. `cwd` falls back to the type's `default_cwd`. `interactive: true` starts it in a tmux session that stays open (see Concepts). |
| `POST /api/processes/preview` | same body; returns the `{command, args}` that would be executed, without running |
| `DELETE /api/processes/:pid?force=1` | SIGTERM (or SIGKILL with `force`) the process **tree**. Works on unmanaged processes too. If the pid belongs to a run, the run is marked `killed`. |
| `POST /api/processes/:pid/remote-control` | Turn on Remote Control for a claude session that is already running, so it shows up in the Claude app. If it is in a tmux pane (an interactive run, or any claude started inside tmux) the console clears its input box (Ctrl+Y brings a draft back) and types `/remote-control`; it refuses while the session is working. → `{status: "enabled"\|"pending"\|"already", web_url}`. Anywhere else there is nothing to type into: `{replace: true, terminal?}` stops the process and reopens the same conversation here in tmux with the type's `resume_args` → 201 `{status: "replaced", run}`; without `replace` it answers 409. |

Restarting is done through the run: `POST /api/runs/:id/restart`.

### Workflows

| | |
|---|---|
| `GET /api/workflows` | list (includes `next_run_at`, `last_run_at`) |
| `GET /api/workflows/:id` | one |
| `POST /api/workflows` | create: `{name, type, cwd?, prompt?, extra_args?, env?, schedule?, enabled?, timeout_sec?, allow_overlap?}` → 201 |
| `PUT /api/workflows/:id` | partial update of the same fields (e.g. `{"enabled": false}`) |
| `DELETE /api/workflows/:id` | delete; past runs are kept (their `workflow_id` becomes null, `workflow_name` stays) |
| `POST /api/workflows/:id/run` | run now → 201 with the run record; 409 if already running and overlap is off |

### Runs

| | |
|---|---|
| `GET /api/runs?workflow_id=&status=&type=&trigger=&limit=50&offset=0` | newest first: `{total, limit, offset, runs: [...]}` (without `output`) |
| `GET /api/runs/:id` | full record incl. `output` (log tail), `duration_ms`, `live` |
| `GET /api/runs/:id/log?offset=0` | `{data, offset, size, status}` – poll with the returned `offset` to tail a running log |
| `GET /api/runs/:id/log?raw=1` | the whole log as `text/plain` |
| `POST /api/runs/:id/kill?force=1` | stop (tree) → updated run |
| `POST /api/runs/:id/restart` | start a new run with the same parameters (kills the old one first if it is running) → 201 |
| `GET /api/runs/:id/screen?lines=200&cols=` | interactive runs: `{text, alive, cols}` – the terminal's last `lines` lines (scrollback + screen). `cols` (40–220) resizes the tmux window to the viewer's width first, so the TUI reflows for a phone. |
| `POST /api/runs/:id/keys` | interactive runs: type into the terminal: `{text?, keys?: ["Down", "Escape", "C-c", ...], enter?: true}` (`keys` are tmux key names, sent after `text`) |
| `DELETE /api/runs/:id` | delete record + log (must not be running) |

Run record fields: `id, workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger (manual|schedule|restart), status, pid, started_at, ended_at, exit_code, log_path, output, error, meta {timeout_sec, orphan, interactive, tmux}`. `GET /api/runs/:id` also includes `sessions` (below).

### Sessions (linking a run to its Claude Code transcript)

Every process the console starts gets `AGENT_CONSOLE_RUN_ID`, `AGENT_CONSOLE_URL` and `AGENT_CONSOLE_TOKEN` in its environment. `scripts/claude-session-hook.sh` is a Claude Code **SessionStart / SessionEnd hook** that, when those variables are present, reports the session back to the console; in any other Claude session it exits immediately. Install it once, globally, in `~/.claude/settings.json` (absolute path):

```json
{ "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/lofiwave/scripts/claude-session-hook.sh", "timeout": 5 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/lofiwave/scripts/claude-session-hook.sh", "timeout": 5 }] }]
} }
```

It works for `claude` started directly by the console *and* for claude processes started by a wrapper script the console launched (the environment is inherited). Codex needs no hook: the console reads the `session id:` that `codex exec` prints, or finds the rollout file a Codex TUI creates under `~/.codex/sessions`.

On top of the recorded id, the console reads what the agents themselves know: Claude Code's per-process registry (`~/.claude/sessions/<pid>.json`: the **name** it gave the session – what the Claude app shows – its idle/working **status** and its Remote Control bridge) and the transcript (auto **title**, `/rename` title, model). That is also how the Agents tab labels claude processes you started from a terminal. Each session in the UI shows title/name, id, model, and offers **Open on web** (the same session on claude.ai, when it has Remote Control), **Resume here** (reopens it in a tmux session on this machine using the type's `resume_args`; for claude that is `claude --resume <id> --dangerously-skip-permissions --remote-control`, so it appears in the Claude app too), **Copy resume** (the terminal command) and **Transcript**.

| | |
|---|---|
| `GET /api/runs/:id/sessions` | `[{session_id, agent, cwd, transcript_path, model, source, started_at, ended_at, end_reason, title, name, status, web_url, resume_cmd}]` |
| `POST /api/runs/:id/sessions/:session_id/resume` | reopen the session interactively (tmux) → 201 with the new run |
| `POST /api/sessions/resume` | same for a session the console did not start: `{agent: "claude"\|"codex", session_id, cwd?, terminal?}` → 201. If the session is still open elsewhere, claude continues it as a copy under a new id. |
| `POST /api/runs/:id/sessions` | register (upsert by `session_id`): `{session_id, agent?, cwd?, transcript_path?, model?, source?}` → 201 |
| `PUT /api/runs/:id/sessions/:session_id` | `{ended: true, reason?, model?}` marks it ended |
| `GET /api/runs/:id/sessions/:session_id/transcript` | the raw JSONL transcript (`text/plain`; only files under the home directory are served) |

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
  "extra_args": ["--full-auto"], "schedule": "0 2 * * 1-5", "timeout_sec": 3600 }'

# Tail a running log
curl -H "authorization: Bearer $TOKEN" 'localhost:7770/api/runs/12/log?offset=0'

# Stop a Claude session you started in a terminal
curl -H "authorization: Bearer $TOKEN" -X DELETE localhost:7770/api/processes/41617
```

## Notes

- Processes launched by the console keep running if the console itself restarts; on startup it re-attaches to those that are still alive (marked *orphan*; log capture is not possible for them) and marks vanished ones `lost`.
- Agents are launched with the console's environment plus the type's and workflow's `env`, and `AGENT_CONSOLE_RUN_ID` set to the run id.
- Process discovery uses `ps` on Linux/macOS and `Get-CimInstance Win32_Process` on Windows; working directories come from `/proc` (Linux) or `lsof` (macOS).

## License

MIT. See [LICENSE](LICENSE).
