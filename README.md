# Agent Console

A small local web app + REST API for managing coding-agent processes on a machine:

- **See** running Claude Code and Codex processes (and any custom process type you define), including ones you started from a terminal.
- **Stop / force-kill / restart** them, or **start new ones** from a chosen folder with a prompt.
- **Schedule workflows** (cron) that launch an agent in a specific folder, and keep a **history of runs** with status, exit code, duration and full logs.
- Everything is stored in **SQLite** (`data/agent-console.sqlite`) with per-run log files in `data/logs/`.
- Runs on **Bun** (Linux primary; macOS/Windows best-effort), no other runtime dependencies.
- Designed to run as a boot-time service and be reached from other devices over **Tailscale**.

```
~/agent-console
├── src/            server.ts (HTTP + API), db.ts, runner.ts, scheduler.ts, cron.ts, procs.ts
├── public/         the single-page UI
├── scripts/        start.sh, systemd unit + installer, tailscale installer, macOS plist
├── data/           sqlite db + logs (created at first start, git-ignored)
└── README.md
```

## Quick start

```bash
cd ~/agent-console
bun run src/server.ts            # or: bun start   /   bun dev (auto-reload)
# → http://localhost:7770
```

Configuration is by environment variable (put them in `~/agent-console/.env` when using the service; `scripts/start.sh` loads it):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7770` | Listen port |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to make it local-only. |
| `AUTH_TOKEN` | *(empty)* | If set, every `/api/*` request must carry it (see Auth). The UI asks for it once and stores it in `localStorage`. |
| `DATA_DIR` | `./data` | Where the SQLite database and logs live |
| `SCHEDULER_INTERVAL_MS` | `15000` | How often scheduled workflows are checked |
| `OUTPUT_TAIL_BYTES` | `65536` | How much of the end of each log is copied into the run record (`output`) |

## Run at boot (Linux, systemd user service)

```bash
~/agent-console/scripts/install-service-linux.sh
```

This installs `~/.config/systemd/user/agent-console.service`, enables it, starts it, and turns on *lingering* so it starts at boot without anyone logging in. The unit runs `scripts/start.sh`, which puts `~/.bun/bin`, `~/.local/bin` (Claude Code) and nvm's `node` on `PATH` so the agents can be found.

```bash
systemctl --user status agent-console       # is it up?
journalctl --user -u agent-console -f       # server log
systemctl --user restart agent-console      # after editing code or .env
```

macOS: edit the path in `scripts/com.agent-console.plist`, copy it to `~/Library/LaunchAgents/` and `launchctl load -w` it.
Windows: create a Task Scheduler task "At log on" running `bun run C:\path\agent-console\src\server.ts`.

## Reaching it over Tailscale

The app binds `0.0.0.0`, so once Tailscale is up on this machine it is reachable from any device on your tailnet at `http://<machine-name>:7770` (MagicDNS) or `http://100.x.y.z:7770`.

```bash
~/agent-console/scripts/install-tailscale-linux.sh   # installs tailscale, `sudo tailscale up`, prints the IP
```

Optional: `sudo tailscale serve --bg 7770` publishes it as `https://<machine>.<tailnet>.ts.net` with a real certificate (tailnet-only). The header of the UI shows the tailscale name/IP when it is installed.

Because the console can kill processes and launch agents, set `AUTH_TOKEN` in `.env` if the machine is also on an untrusted LAN, or bind `HOST=127.0.0.1` and rely on `tailscale serve` (which proxies from the tailnet to localhost).

## SSH over Tailscale only

`scripts/setup-ssh-tailscale-only.sh` (needs sudo) installs OpenSSH server and restricts it to the tailnet in two layers: a ufw rule that only allows port 22 in on `tailscale0`, and an sshd `AllowUsers` rule limited to Tailscale address ranges. Other ports are untouched; run it with `STRICT=1` to also make ufw deny all other incoming traffic except loopback and Tailscale. It prints the `ssh user@100.x.y.z` command to use and how to switch to key-only auth.

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

Add your own, e.g. a nightly test runner:

```bash
curl -X POST localhost:7770/api/process-types -H 'content-type: application/json' -d '{
  "name": "pytest", "command": "pytest", "args": ["-q", "{cwd}"], "detect": "pytest"
}'
```

**Interactive runs** – `POST /api/processes` with `interactive: true` (or the *Interactive* checkbox in the Start dialog) starts the type inside a detached **tmux** session (`ac-<run id>`) that stays open until the program exits or you stop the run. This is how you start a normal `claude` or `codex` TUI from your phone: the built-in `claude` type's interactive template is `claude [prompt] --remote-control`, so the session shows up in the Claude app / claude.ai as soon as it is up (the console picks the `https://claude.ai/code/session_…` link off the screen and shows it on the run as `meta.remote_url`), and the `codex` type opens the Codex TUI. The prompt is optional. Requires `tmux` on PATH. While it runs, the run page shows the live terminal (`GET /api/runs/:id/screen`) and lets you type into it (`POST /api/runs/:id/keys`); on the machine itself `tmux attach -t ac-<id>` gives you the real terminal. When it ends, the screen and scrollback are saved as the run log. Each type has its own `interactive_args` template (Types tab); when it is empty the normal `args` are used.

**Process** – an OS process that either matches a type's `detect` regex or was started by the console. Console-started processes are *managed*: they have a run record, a log, and can be restarted. Children of a managed process are attributed to the same run (`child: true`).

**Run** – one execution of a type (ad-hoc, from a workflow, or a restart). Statuses: `running`, `success` (exit 0), `failed` (non-zero), `killed` (stopped via the console), `timeout`, `lost` (the console restarted and the process was gone), `error` (could not start). Killing a run kills its whole process tree.

**Workflow** – a saved launch: type + folder + prompt + extra args + env, optionally with a cron `schedule`, a `timeout_sec`, and `allow_overlap` (default off: a scheduled tick is skipped and recorded as an `error` run if the previous one is still running). Times use the server's local timezone.

Cron: 5 fields `min hour day-of-month month day-of-week`, with `*`, lists, ranges, steps and month/day names, plus `@hourly @daily @weekly @monthly @yearly`.

Useful extra args: Claude Code `--permission-mode acceptEdits`, `--dangerously-skip-permissions`, `--output-format json`, `--model ...`; Codex `--full-auto`, `--skip-git-repo-check`, `-m ...`.

## API

**Live docs:** `GET /api/docs` returns this section as markdown with the real base URL filled in, plus a step-by-step quickstart for registering an app. Give that URL (e.g. `http://lucas-xps-8930:7770/api/docs`) to a coding agent and it has everything it needs. `/docs` shows the same rendered in the browser (the **API** button in the UI header), and `GET /api` returns a JSON index of endpoints. Both are readable without the auth token.

Base URL `http://host:7770/api`. All bodies and responses are JSON. Errors are `{"error": "message"}` with a 4xx/5xx status. Timestamps are Unix milliseconds. Fields that take an argument list (`args`, `extra_args`) accept either a JSON array or a single shell-style string (`"--foo 'a b'"`).

### Auth

If `AUTH_TOKEN` is set, send it as one of: `Authorization: Bearer <token>`, `X-Auth-Token: <token>`, or `?token=<token>`. Static files never require it.

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
| `POST /api/process-types` | create: `{name, command, args?, interactive_args?, resume_args?, env?, detect?, description?, kind?: "agent"\|"app", default_cwd?}` → 201 |
| `PUT /api/process-types/:name` | update any subset of `command, args, interactive_args, resume_args, env, detect, description, kind, default_cwd` |
| `DELETE /api/process-types/:name` | delete (built-ins and types used by a workflow are refused) |

### Processes (live view)

| | |
|---|---|
| `GET /api/processes?type=&kind=` | running processes matching any type (filter by type name or kind): `{pid, ppid, user, cmd, cwd, elapsedSec, rssKb, cpu, type, managed, child, run_id, workflow_name, session}` – `session` is `{session_id, agent, title, name, status, model, web_url, resume_cmd, ...}` or null |
| `POST /api/processes` | start one: `{type, cwd?, prompt?, extra_args?, env?, timeout_sec?, interactive?}` → 201 with the run record. `cwd` falls back to the type's `default_cwd`. `interactive: true` starts it in a tmux session that stays open (see Concepts). |
| `POST /api/processes/preview` | same body; returns the `{command, args}` that would be executed, without running |
| `DELETE /api/processes/:pid?force=1` | SIGTERM (or SIGKILL with `force`) the process **tree**. Works on unmanaged processes too. If the pid belongs to a run, the run is marked `killed`. |

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
| `GET /api/runs/:id/screen?lines=200` | interactive runs: `{text, alive}` – the terminal's last `lines` lines (scrollback + screen) |
| `POST /api/runs/:id/keys` | interactive runs: type into the terminal: `{text?, keys?: ["Down", "Escape", "C-c", ...], enter?: true}` (`keys` are tmux key names, sent after `text`) |
| `DELETE /api/runs/:id` | delete record + log (must not be running) |

Run record fields: `id, workflow_id, workflow_name, type_name, cwd, command, args, prompt, env, trigger (manual|schedule|restart), status, pid, started_at, ended_at, exit_code, log_path, output, error, meta {timeout_sec, orphan, interactive, tmux}`. `GET /api/runs/:id` also includes `sessions` (below).

### Sessions (linking a run to its Claude Code transcript)

Every process the console starts gets `AGENT_CONSOLE_RUN_ID`, `AGENT_CONSOLE_URL` and `AGENT_CONSOLE_TOKEN` in its environment. `scripts/claude-session-hook.sh` is a Claude Code **SessionStart / SessionEnd hook** that, when those variables are present, reports the session back to the console; in any other Claude session it exits immediately. Install it once, globally, in `~/.claude/settings.json` (absolute path):

```json
{ "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/agent-console/scripts/claude-session-hook.sh", "timeout": 5 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/agent-console/scripts/claude-session-hook.sh", "timeout": 5 }] }]
} }
```

It works for `claude` started directly by the console *and* for claude processes started by a wrapper script the console launched (the environment is inherited). Codex needs no hook: the console reads the `session id:` that `codex exec` prints, or finds the rollout file a Codex TUI creates under `~/.codex/sessions`.

On top of the recorded id, the console reads what the agents themselves know: Claude Code's per-process registry (`~/.claude/sessions/<pid>.json`: the **name** it gave the session – what the Claude app shows – its idle/working **status** and its Remote Control bridge) and the transcript (auto **title**, `/rename` title, model). That is also how the Agents tab labels claude processes you started from a terminal. Each session in the UI shows title/name, id, model, and offers **Open on web** (the same session on claude.ai, when it has Remote Control), **Resume here** (reopens it in a tmux session on this machine using the type's `resume_args`; for claude that is `claude --resume <id> --remote-control`, so it appears in the Claude app too), **Copy resume** (the terminal command) and **Transcript**.

| | |
|---|---|
| `GET /api/runs/:id/sessions` | `[{session_id, agent, cwd, transcript_path, model, source, started_at, ended_at, end_reason, title, name, status, web_url, resume_cmd}]` |
| `POST /api/runs/:id/sessions/:session_id/resume` | reopen the session interactively (tmux) → 201 with the new run |
| `POST /api/sessions/resume` | same for a session the console did not start: `{agent: "claude"\|"codex", session_id, cwd?}` → 201. If the session is still open elsewhere, claude continues it as a copy under a new id. |
| `POST /api/runs/:id/sessions` | register (upsert by `session_id`): `{session_id, agent?, cwd?, transcript_path?, model?, source?}` → 201 |
| `PUT /api/runs/:id/sessions/:session_id` | `{ended: true, reason?, model?}` marks it ended |
| `GET /api/runs/:id/sessions/:session_id/transcript` | the raw JSONL transcript (`text/plain`; only files under the home directory are served) |

### Examples

```bash
# Start Claude Code headlessly in a repo, auto-accepting edits, with a 30 min cap
curl -X POST localhost:7770/api/processes -H 'content-type: application/json' -d '{
  "type": "claude", "cwd": "/home/lucas/robot/i2rt",
  "prompt": "Run the test suite and fix any failures.",
  "extra_args": "--permission-mode acceptEdits", "timeout_sec": 1800 }'

# Nightly Codex review at 02:00 on weekdays
curl -X POST localhost:7770/api/workflows -H 'content-type: application/json' -d '{
  "name": "nightly-review", "type": "codex", "cwd": "/home/lucas/robot/ent-scrub-tech",
  "prompt": "Review yesterday'"'"'s commits and write findings to REVIEW.md",
  "extra_args": ["--full-auto"], "schedule": "0 2 * * 1-5", "timeout_sec": 3600 }'

# Tail a running log
curl 'localhost:7770/api/runs/12/log?offset=0'

# Stop a Claude session you started in a terminal
curl -X DELETE localhost:7770/api/processes/41617
```

## Notes

- Processes launched by the console keep running if the console itself restarts; on startup it re-attaches to those that are still alive (marked *orphan*; log capture is not possible for them) and marks vanished ones `lost`.
- Agents are launched with the console's environment plus the type's and workflow's `env`, and `AGENT_CONSOLE_RUN_ID` set to the run id.
- Process discovery uses `ps` on Linux/macOS and `Get-CimInstance Win32_Process` on Windows; working directories come from `/proc` (Linux) or `lsof` (macOS).
