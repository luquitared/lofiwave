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

A **workflow** is a saved agent launch: an agent type (\`claude\` or \`codex\`), a folder, a prompt, and optionally a cron \`schedule\`. Each time it fires it creates a **run**: a live, interactive session the person can watch and type into from the console. A claude run closes itself once the agent has finished and stayed idle (\`IDLE_STOP_SEC\`, default 120s, while nobody has its terminal open).

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
      targets: [`GET|POST ${api}/targets {name, kind: cloud-run|e2b, config}`, `GET|PUT|DELETE ${api}/targets/:name`, `POST ${api}/targets/:name/check`, `POST ${api}/processes {target, input_dir?}`],
      runs: [`GET ${api}/runs?workflow_id=&status=&type=&limit=&offset=`, `GET|DELETE ${api}/runs/:id`, `GET ${api}/runs/:id/log?offset=|raw=1`, `POST ${api}/runs/:id/kill?force=1`, `POST ${api}/runs/:id/restart`],
      interactive: [`POST ${api}/processes {interactive: true}`, `GET ${api}/runs/:id/screen?lines=200`, `GET ${api}/runs/:id/history?lines=5000`, `POST ${api}/runs/:id/keys {text, keys, enter}`],
      sessions: [`GET|POST ${api}/runs/:id/sessions`, `PUT ${api}/runs/:id/sessions/:session_id`, `POST ${api}/runs/:id/sessions/:session_id/resume`, `POST ${api}/sessions/resume {session_id, agent?, cwd?}`, `GET ${api}/sessions/:session_id?agent=`, `GET ${api}/runs/:id/sessions/:session_id/transcript`, `GET ${api}/runs/:id/sessions/:session_id/messages`],
      chat: [`GET ${api}/runs/:id/chat (WebSocket)`, `GET ${api}/runs/:id/chat?before=`, `GET ${api}/runs/:id/chat/blob?ref=&agent=`, `GET ${api}/runs/:id/chat/subagent/:agent_id`, `GET ${api}/runs/:id/chat/file?path=&raw=`, `POST ${api}/runs/:id/chat/paths {paths}`, `GET ${api}/sessions/:session_id/chat… (same, by session id)`, `POST ${api}/runs/:id/chat/send {text, files?, draft?}`, `POST ${api}/runs/:id/chat/interrupt`, `POST ${api}/runs/:id/uploads?name= (raw body)`, `GET ${api}/runs/:id/chat/commands`, `GET ${api}/runs/:id/chat/screen?lines=`, `GET ${api}/runs/:id/chat/requests`, `POST ${api}/runs/:id/chat/requests/:request_id {decision, suggestion?, answers?, mode?, message?}`, `POST ${api}/hooks/permission (Claude's PermissionRequest hook)`, `GET ${api}/runs/:id/chat/changes?prompt=`, `GET ${api}/runs/:id/chat/changes/file?prompt=&path=`, `POST ${api}/hooks/message | turn | statusline (Claude's MessageDisplay, UserPromptSubmit/Stop hooks and statusline)`],
    },
  };
}
