# lofiwave hosted

lofiwave as a service: people sign in with Google and get **their own machine**, an [E2B](https://e2b.dev) sandbox
running stock single-user lofiwave, which they use at your address as if it were on their desk. Claude Code and
Codex run there, in tmux, with the real terminal in the browser.

This folder is the control plane, a separate app from lofiwave itself: Bun + SQLite, one dependency (the `e2b`
SDK). lofiwave runs unchanged inside each machine.

## How it works

```
browser ──cookie──▶ hosted server (this) ──traffic token + AUTH_TOKEN──▶ 7770-<sandbox>.e2b.app ──▶ lofiwave
                     /_lw/*  sign-in, machine                              (the user's E2B sandbox)
                     /*      proxied, HTTP and WebSocket
```

- **One sandbox per user**, from the `lofiwave` template (`template/build.ts`: E2B's `claude` template + tmux,
  Bun and a lofiwave checkout). A new machine is ready in about 5 s. lofiwave is started in it with its own
  random `AUTH_TOKEN`.
- **It sleeps when unused.** Machines are created with `onTimeout: "pause"` and `autoResume: true`. E2B pauses a
  machine `IDLE_SEC` after it was last used (memory and disk kept), and the next request to it resumes it:
  measured at 170–250 ms, and about 450 ms after 6 minutes asleep. tmux sessions and running agents come back
  as they were; an open browser terminal reconnects by itself.
- **Nobody reaches a machine but this server.** Machines are created with `allowPublicTraffic: false`: their URLs
  answer only requests carrying the machine's traffic token (403 otherwise), and a request without one does not
  wake a paused machine. The token and lofiwave's `AUTH_TOKEN` live only in this server's database; the proxy
  adds both, so lofiwave's UI never asks for a token. Browsers can't put headers on a WebSocket, which is why
  the terminal goes through the proxy too.
- **Staying awake while used.** E2B doesn't extend a machine's timeout on activity, so this server does: on every
  proxied request and keystroke (at most every 30 s), and from a keeper that asks each running machine's
  lofiwave whether an agent is working (`/api/console`) and extends it if so, with nobody watching.
- **Claude credentials are the user's.** Nothing is injected: the first `claude` session on a new machine shows
  Claude Code's own login, and the user signs in with their own subscription or Console account. It stays signed
  in on that machine.

## Run it

```bash
cd hosted
bun install
cp .env.example .env            # then fill it in
bun run build-template          # once, and after lofiwave changes you want new machines to get
bun start                       # scripts/start.sh: .env wins over the inherited environment
```

`scripts/start.sh` loads `.env` over the environment on purpose: an agent started from a lofiwave console inherits
that console's `PORT` and `HOST`, and would otherwise start this server on the console's own port.

For local testing without Google, `DEV_LOGIN=1` (only with `HOST=127.0.0.1`) adds an email-only sign-in, and
`test/e2e.ts` drives the whole flow against a running server with a real E2B key: sign-in, machine creation,
lofiwave through the proxy, an interactive run's terminal over the proxied WebSocket, cross-origin refusals, and
waking a paused machine by an API call and by a terminal.

```bash
BASE=http://127.0.0.1:7781 E2B_API_KEY=… bun run test/e2e.ts    # creates a machine and kills it afterwards
```

### Google sign-in

In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type *Web application*
with the redirect URI `<PUBLIC_URL>/_lw/auth/callback`, and put its id and secret in `.env`. Scopes are
`openid email profile`; only verified emails are accepted.

### Serving it

Put it behind HTTPS (e.g. Caddy: `reverse_proxy 127.0.0.1:7780`) and set `PUBLIC_URL` to that address. The
cookie is `Secure` when `PUBLIC_URL` is https. Request bodies and WebSockets stream through; nothing is buffered.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `E2B_API_KEY` | *(required)* | E2B key machines are created and billed under |
| `PUBLIC_URL` | `http://localhost:$PORT` | The address people open; Google redirects back to it |
| `PORT` / `HOST` | `7780` / `127.0.0.1` | Listen address |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Google OAuth client (see above) |
| `ALLOW_EMAILS` | *(anyone)* | Who may sign up: emails and `@domain` entries, comma-separated. Existing users can always sign in. |
| `MAX_USERS` | `50` | No new sign-ups past this many users |
| `TEMPLATE` | `lofiwave` | E2B template new machines start from |
| `IDLE_SEC` | `600` | How long an unused machine with no working agent stays awake |
| `KEEPER_INTERVAL_MS` | `60000` | How often running machines are asked whether an agent is working |
| `CLAUDE_PERMISSION_MODE` | *(unset)* | Passed to each machine's lofiwave (e.g. `bypassPermissions`: it's the user's own sandbox) |
| `SESSION_SECRET` | *(generated)* | Signs the login cookie; generated into `data/session-secret` when unset |
| `DATA_DIR` | `./data` | SQLite database |
| `DEV_LOGIN` | | `1`: email-only sign-in, for local testing (refused unless `HOST` is loopback) |

## Routes

Ours are under `/_lw/`; every other path is the user's lofiwave.

| | |
|---|---|
| `GET /_lw/login`, `/_lw/logout` | sign-in page; sign out |
| `GET /_lw/auth/google`, `/_lw/auth/callback` | Google OAuth |
| `GET /_lw/machine` | `{state: none \| creating \| error \| running \| paused \| missing, error}` (doesn't wake it) |
| `POST /_lw/machine` | create the machine if there isn't one |
| `POST /_lw/machine/reset` | throw away a machine that failed to start, and try again |
| `GET /_lw/me` | `{email, name, machine, sandbox_id}` |

## Not done yet

See issue #8 in `issues.md`. In short: cron workflows only fire while a machine is awake; API keys made in a
machine's lofiwave can't be used from outside yet (every request needs the browser cookie); no billing or usage
caps beyond `MAX_USERS`; one machine per user; existing machines don't get lofiwave updates.
