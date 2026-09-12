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
    ? `This console requires a token. Send it on every request as \`Authorization: Bearer <token>\` (or \`X-Auth-Token: <token>\`). Ask the person who gave you this URL for the token. \`GET ${api}/docs\` itself is public.`
    : `No authentication is currently required.`;
  const quickstart = `# Agent Console API

Base URL: \`${api}\`  ·  Web UI: ${base}  ·  This document: \`${api}/docs\` (markdown)  ·  Machine index: \`${api}\`

${auth}

All request and response bodies are JSON (\`content-type: application/json\`). Errors are \`{"error": "..."}\` with a 4xx/5xx status.

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

Kinds: \`"agent"\` types (built-in \`claude\` and \`codex\`) are shown on the *Agents* tab; \`"app"\` types on the *Apps* tab. Both use exactly the same endpoints.

`;
  return quickstart + readmeApiSection().replace(/localhost:7770/g, base.replace(/^https?:\/\//, ""));
}

export function apiIndex(base: string) {
  const api = `${base}/api`;
  return {
    name: "agent-console",
    docs: `${api}/docs`,
    ui: base,
    endpoints: {
      system: [`GET ${api}/health`, `GET ${api}/system`, `GET ${api}/paths?q=`],
      process_types: [`GET ${api}/process-types`, `POST ${api}/process-types`, `GET|PUT|DELETE ${api}/process-types/:name`],
      console: [`GET ${api}/console`],
      processes: [`GET ${api}/processes?type=&kind=`, `POST ${api}/processes`, `POST ${api}/processes/preview`, `DELETE ${api}/processes/:pid?force=1`],
      workflows: [`GET|POST ${api}/workflows`, `GET|PUT|DELETE ${api}/workflows/:id`, `POST ${api}/workflows/:id/run`],
      runs: [`GET ${api}/runs?workflow_id=&status=&type=&limit=&offset=`, `GET|DELETE ${api}/runs/:id`, `GET ${api}/runs/:id/log?offset=|raw=1`, `POST ${api}/runs/:id/kill?force=1`, `POST ${api}/runs/:id/restart`],
      interactive: [`POST ${api}/processes {interactive: true}`, `GET ${api}/runs/:id/screen?lines=200`, `POST ${api}/runs/:id/keys {text, keys, enter}`],
      sessions: [`GET|POST ${api}/runs/:id/sessions`, `PUT ${api}/runs/:id/sessions/:session_id`, `POST ${api}/runs/:id/sessions/:session_id/resume`, `POST ${api}/sessions/resume {agent, session_id, cwd?}`, `GET ${api}/runs/:id/sessions/:session_id/transcript`],
    },
  };
}
