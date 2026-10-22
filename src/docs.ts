/**
 * Live API documentation. The endpoint tables come from README.md (single source of truth);
 * the quickstart is generated with the real base URL so an agent can follow it verbatim.
 */
import { join } from "node:path";
import { config } from "./config";

let readmeCache: { text: string; mtime: number } | null = null;
function readmeApiSection(): string {
  const path = join(config.root, "README.md");
  const f = Bun.file(path);
  const mtime = f.lastModified;
  if (!readmeCache || readmeCache.mtime !== mtime) {
    let text = "";
    try { text = require("node:fs").readFileSync(path, "utf8"); } catch { text = ""; }
    const start = text.indexOf("\n## API");
    const end = text.indexOf("\n## Notes");
    readmeCache = { text: start >= 0 ? text.slice(start + 1, end > start ? end : undefined) : "", mtime };
  }
  return readmeCache.text;
}

export function renderDocs(base: string, authRequired: boolean): string {
  const api = `${base}/api`;
  const auth = authRequired
    ? `Every request needs an API key: \`Authorization: Bearer <key>\` (or \`X-Auth-Token: <key>\`). The person who gave you this URL makes one on the console's *Connect* page. \`GET ${api}/docs\` itself is public.`
    : `No authentication is currently required.`;
  const quickstart = `# lofiwave API

Base URL: \`${api}\`  ·  Web UI: ${base}  ·  This document: \`${api}/docs\` (markdown)  ·  Machine index: \`${api}\`

${auth}

All request and response bodies are JSON (\`content-type: application/json\`). Errors are \`{"error": "..."}\` with a 4xx/5xx status.

## Quickstart: workflows (the usual job)

A **workflow** is a saved agent launch: an agent type (\`claude\` or \`codex\`), a folder, a prompt, and optionally a cron \`schedule\`. Each time it fires it creates a **run**: a live, interactive session the person can watch and type into from the console. A claude run closes itself once the agent has finished and stayed idle (\`IDLE_STOP_SEC\`, default 120s, while nobody is watching it).

\`\`\`bash
curl -X POST ${api}/workflows -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "name": "nightly-review",
  "type": "claude",
  "cwd": "/absolute/path/to/repo",
  "prompt": "Review yesterday'"'"'s commits and open issues for anything risky",
  "schedule": "0 2 * * *"
}'
\`\`\`

- Leave \`schedule\` out (or \`""\`) for a workflow that only runs on demand: \`POST ${api}/workflows/<id>/run\`.
- \`GET ${api}/workflows\` lists them with \`next_run_at\` / \`last_run_at\`; \`PUT ${api}/workflows/<id>\` changes any field (\`{"enabled": false}\` pauses it).
- \`GET ${api}/runs?workflow_id=<id>\` is its history; \`GET ${api}/runs/<run id>/screen\` shows the live terminal and \`POST ${api}/runs/<run id>/keys\` types into it.
- Claude asks before editing files or running commands; for a run nobody watches, add \`"extra_args": "--permission-mode acceptEdits"\`.

## Quickstart: a swarm (a controller starting workers and collecting their results)

Start each worker with \`POST ${api}/processes\`: the same \`"group"\` for all of them, \`"parent_run": <your AGENT_CONSOLE_RUN_ID>\` if you are a lofiwave run yourself, its inputs in \`"files"\` (\`{"BRIEF.md": "..."}\`), \`"mkdir_cwd": true\` for a fresh folder, and \`"queue": true\` so that a full machine queues it (status \`queued\`) instead of answering 429. Each run has \`LOFIWAVE_OUT_DIR\` (\`<cwd>/out\`) in its environment: tell workers to leave their results there.

- \`GET ${api}/runs?group=<g>\` (or \`GET ${api}/groups\` for counts by status) shows how the swarm is doing.
- \`GET ${api}/runs/<id>/results\` returns what a worker left in \`out/\`, small text files inlined.
- \`PUT ${api}/runs/<id>/files?path=<rel>\` puts a file (or, with \`&extract=1\`, a tar.gz) in a run's folder; \`GET\` the same URL reads a file, lists a folder, or with \`&archive=1\` downloads it as a tar.gz.

Details are under *Swarms* below.

## Quickstart: drive an agent (a worker you start, message and wait on)

\`\`\`bash
# start an interactive claude in a folder (the folder is trusted for it, so no trust dialog stops it)
curl -X POST ${api}/processes -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"type": "claude", "cwd": "/absolute/path/to/repo", "prompt": "Fix the failing test", "extra_args": "--permission-mode acceptEdits"}'
# → {"id": 12, "activity": "working", ...}

# wait (long-poll, up to 600 s) until its turn is over; no sleep loop needed
curl "${api}/runs/12/wait?until=idle&timeout=600" -H "authorization: Bearer $KEY"
# → the run with "activity": "idle" (or "waiting_input": a permission prompt; answer it with /keys), "reached": true

# send it a follow-up, checked: {"delivered": true, "queued": false, "sent_at": ...}. Fine while it works: it queues.
curl -X POST ${api}/runs/12/message -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"text": "Now run the whole suite"}'
# then wait for the turn that message started
curl "${api}/runs/12/wait?until=idle&timeout=600&after=<sent_at>" -H "authorization: Bearer $KEY"
\`\`\`

- Every run has \`activity\` (\`working\` | \`idle\` | \`waiting_input\` | \`done\`) and \`activity_since\`: no need to read the screen to tell.
- \`GET ${api}/runs/12/sessions/<session_id>/messages\` is the conversation so far; \`POST ${api}/runs/12/kill\` stops it.
- An idle interactive claude run nobody watches ends by itself after \`AGENT_IDLE_STOP_SEC\` (default 30 min; \`"stop_when_idle": false\` keeps it, \`"idle_stop_sec": N\` sets it), so finished workers free their memory. \`wait?until=done\` waits for the end.

## Quickstart: a swarm in one call (POST /swarms: workers, folders and status for you)

Start every worker in one call. Each gets its own folder \`<cwd_root>/<group>/<name>/\` with the shared \`BRIEF.md\` and its own \`TASK.md\`, and reports through files: \`STATUS.md\` (first line = its current state), \`out/\` (deliverables) and \`out/REPORT.md\` (written when finished). If you are an agent the console started, pass your own \`$AGENT_CONSOLE_RUN_ID\` as \`parent_run\`.

\`\`\`bash
curl -X POST ${api}/swarms -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "group": "tune-lr",
  "cwd_root": "/absolute/path/experiments",
  "brief": "Goal, data, budget, and how to score: put score: <number> on the first line of out/REPORT.md.",
  "workers": [
    {"name": "lr-1e3", "prompt": "Train with lr=1e-3 and report the held-out score."},
    {"name": "lr-3e4", "prompt": "Train with lr=3e-4 and report the held-out score."}
  ],
  "timeout_sec": 3600
}'
\`\`\`

- **How is it going?** \`GET ${api}/swarms/tune-lr\` answers in one call: \`summary\` ("2 workers: 1 working, 1 idle · 1/2 reports"), \`counts\`, and per worker \`activity\` (working / idle / waiting_input / done), \`status_line\` (its STATUS.md first line), \`report\` (true once out/REPORT.md exists), \`cost_line\`, \`elapsed_ms\` and \`links\`. Don't read the folders or the terminals to answer a status question; this has it.
- **Results**: \`GET ${api}/swarms/tune-lr/workers/<name>/report\` is that worker's REPORT.md.
- **Tell all of them something**: \`POST ${api}/swarms/tune-lr/message\` \`{"text": "..."}\` (add \`"workers": ["lr-1e3"]\` for some). **Stop them**: \`POST ${api}/swarms/tune-lr/stop\`.
- \`timeout_sec\` is a hard cap per worker: the console stops it then, whatever it is doing. Put spending limits in the brief; workers keep COST.md.
- The person can watch the same swarm at \`${base}/#swarms/tune-lr\`. Every endpoint, field and the full worker contract are under *Swarms* below.

## Quickstart: register an app so it can be monitored, started and stopped from the console

An **app** is a process type: a command with optional args, a default working directory, and a regex that recognizes already-running instances. Once registered it appears on the console's *Apps* tab.

1. **Register the app** (one time). Use \`{cwd}\` in args for the working directory; add \`{prompt}\` if the app takes a free-text input per run.

\`\`\`bash
curl -X POST ${api}/process-types -H 'content-type: application/json' -d '{
  "name": "my-app",
  "kind": "app",
  "description": "What this app does (shown in the UI)",
  "command": "bun",
  "args": ["run", "server.ts"],
  "default_cwd": "/absolute/path/to/my-app",
  "detect": "bun run server\\\\.ts",
  "env": {"PORT": "3000"},
  "url": "http://{host}:3000"
}'
\`\`\`

   \`name\` is the identifier used in every other call (letters, digits, \`_ . -\`). \`detect\` is optional; without it only instances started through the console are shown. \`command\` must be on the console's PATH or an absolute path. \`url\` is optional: if the app has a web UI, the Apps tab links to it (\`{host}\` becomes the host the console was opened on, so the link also works over Tailscale; the app must listen on more than 127.0.0.1 for that).

2. **Start it**: \`POST ${api}/processes\` with \`{"type": "my-app"}\` (add \`"cwd"\`, \`"prompt"\`, \`"extra_args"\`, \`"env"\`, \`"timeout_sec"\` to override). The response is a *run* record with \`id\` and \`pid\`.

3. **Check on it**: \`GET ${api}/processes?type=my-app\` lists running instances (\`pid\`, \`cpu\`, \`rssKb\`, \`elapsedSec\`, \`run_id\`). \`GET ${api}/runs/<id>\` shows status/exit code; \`GET ${api}/runs/<id>/log?offset=0\` returns its log (poll with the returned \`offset\` to tail).

4. **Stop / restart**: \`DELETE ${api}/processes/<pid>\` (add \`?force=1\` for SIGKILL) or \`POST ${api}/runs/<id>/kill\`; \`POST ${api}/runs/<id>/restart\` starts a fresh run with the same parameters.

5. **Schedule it** (optional): \`POST ${api}/workflows\` with \`{"name": "...", "type": "my-app", "schedule": "0 */6 * * *"}\` (5-field cron, server local time). \`cwd\` defaults to the type's \`default_cwd\`.

To change the definition later use \`PUT ${api}/process-types/my-app\` with only the fields to change; \`GET ${api}/process-types\` lists everything registered along with whether each command was found on PATH (\`available\`).

Kinds: \`"agent"\` types (built-in \`claude\` and \`codex\`) start interactive by default and show under *Sessions*; \`"app"\` types run headless and show under *Advanced → Apps*. Both use exactly the same endpoints.

`;
  return quickstart + readmeApiSection().replace(/localhost:7770/g, base.replace(/^https?:\/\//, ""));
}

export function apiIndex(base: string) {
  const api = `${base}/api`;
  return {
    name: "lofiwave",
    docs: `${api}/docs`,
    ui: base,
    endpoints: {
      system: [`GET ${api}/health`, `GET ${api}/system`, `GET ${api}/paths?q=`],
      process_types: [`GET ${api}/process-types`, `POST ${api}/process-types`, `GET|PUT|DELETE ${api}/process-types/:name`],
      console: [`GET ${api}/console`],
      processes: [`GET ${api}/processes?type=&kind=`, `POST ${api}/processes`, `POST ${api}/processes/preview`, `DELETE ${api}/processes/:pid?force=1`, `POST ${api}/processes/:pid/remote-control {replace?}`],
      keys: [`GET|POST ${api}/keys`, `DELETE ${api}/keys/:id`],
      workflows: [`GET|POST ${api}/workflows`, `GET|PUT|DELETE ${api}/workflows/:id`, `POST ${api}/workflows/:id/run {target?}`],
      swarms: [`POST ${api}/swarms {group, cwd_root, brief?, workers: [{name, prompt, files?, extra_args?, env?}], type?, extra_args?, env?, timeout_sec?, parent_run?}`, `GET ${api}/swarms`, `GET ${api}/swarms/:group`, `GET ${api}/swarms/:group/workers/:name/report`, `POST ${api}/swarms/:group/message {text, workers?}`, `POST ${api}/swarms/:group/stop {workers?, force?}`, `GET ${api}/groups`],
      targets: [`GET|POST ${api}/targets {name, kind: e2b, config}`, `GET|PUT|DELETE ${api}/targets/:name`, `POST ${api}/targets/:name/check`, `POST ${api}/processes {target, input_dir?}`],
      runs: [`GET ${api}/runs?workflow_id=&status=&type=&group=&parent_run=&limit=&offset=`, `GET|DELETE ${api}/runs/:id`, `GET ${api}/runs/:id/wait?until=idle|done&timeout=&after=`, `GET ${api}/runs/:id/log?offset=|raw=1`, `POST ${api}/runs/:id/kill?force=1`, `POST ${api}/runs/:id/restart`],
      jobs: [`POST ${api}/processes {group?, parent_run?, files?, mkdir_cwd?, queue?}`, `GET ${api}/groups`, `GET|PUT ${api}/runs/:id/files?path=&recursive=1|archive=1|extract=1`, `GET ${api}/runs/:id/results`, `GET ${api}/system (capacity)`],
      interactive: [`POST ${api}/processes {interactive: true, trust?, stop_when_idle?, idle_stop_sec?}`, `POST ${api}/runs/:id/message {text}`, `GET ${api}/runs/:id/screen?lines=200`, `GET ${api}/runs/:id/history?lines=5000`, `POST ${api}/runs/:id/keys {text, keys, enter}`],
      sessions: [`GET|POST ${api}/runs/:id/sessions`, `PUT ${api}/runs/:id/sessions/:session_id`, `POST ${api}/runs/:id/sessions/:session_id/resume`, `POST ${api}/sessions/resume {session_id, agent?, cwd?}`, `GET ${api}/sessions/:session_id?agent=`, `GET ${api}/runs/:id/sessions/:session_id/transcript`, `GET ${api}/runs/:id/sessions/:session_id/messages`],
      chat: [`GET ${api}/runs/:id/chat (WebSocket)`, `GET ${api}/runs/:id/chat?before=`, `GET ${api}/runs/:id/chat/blob?ref=&agent=`, `GET ${api}/runs/:id/chat/subagent/:agent_id`, `GET ${api}/runs/:id/chat/file?path=&raw=`, `POST ${api}/runs/:id/chat/paths {paths}`, `GET ${api}/sessions/:session_id/chat… (same, by session id)`, `POST ${api}/runs/:id/chat/send {text, files?, draft?}`, `POST ${api}/runs/:id/chat/interrupt`, `POST ${api}/runs/:id/uploads?name= (raw body)`, `GET ${api}/runs/:id/chat/commands`, `GET ${api}/runs/:id/chat/screen?lines=`, `GET ${api}/runs/:id/chat/requests`, `POST ${api}/runs/:id/chat/requests/:request_id {decision, suggestion?, answers?, mode?, message?}`, `POST ${api}/hooks/permission (Claude's PermissionRequest hook)`, `GET ${api}/runs/:id/chat/changes?prompt=`, `GET ${api}/runs/:id/chat/changes/file?prompt=&path=`, `POST ${api}/hooks/message | turn | statusline (Claude's MessageDisplay, UserPromptSubmit/Stop hooks and statusline)`],
    },
  };
}
