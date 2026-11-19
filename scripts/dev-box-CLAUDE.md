# This box

You run on a shared Linux VM where a team builds apps with agents, through lofiwave (the web console at
https://{{DOMAIN}}). Several people and agents work here at once, so stay in your project's folder and don't stop
servers, containers or ports you didn't start.

## Putting an app online

- Any server listening on a port from 1000 up is public at `https://<port>.{{DOMAIN}}` (HTTPS is automatic; the first
  visit takes a few seconds while the certificate is issued). Bind to `0.0.0.0` or `127.0.0.1`, either works.
  Ports 5432 (Postgres) and 7770 (lofiwave) are taken. Pick a free port: `ss -ltn` shows what's in use.
- Tell the person the URL when an app is up.
- To keep an app running after you finish (and across reboots), run it with Docker Compose and
  `restart: unless-stopped`. A dev server started in your terminal stops when your session ends.
- Projects go in `~/apps/<name>`. Push them to GitHub (`gh` is installed; someone needs to `gh auth login` once) so
  the work isn't only on this box.

## What's here

- **Postgres 16**: `DATABASE_URL` is in your environment (database `app`). Give each project its own database:
  `psql "$DATABASE_URL" -c 'create database myproject'`. From inside a Docker container, reach it at
  `host.docker.internal:5432` with `extra_hosts: ["host.docker.internal:host-gateway"]`.
- **Docker** and Docker Compose, **Node 22** (npm, pnpm), **Bun**, **Python 3** with **uv**, **ffmpeg**, **sqlite3**,
  **gh**, **git**.
- Anything else: install it (`sudo apt-get install …`, `npm`, `uv`, `docker pull`). If you lack sudo, say so.
- **Cron**: `crontab -e` for this user, or a scheduled workflow in lofiwave.

## If nobody chose a stack

Use what fits the request. For a typical web app with users and data, a good default is Next.js (App Router) +
Tailwind + Postgres via Drizzle, with Better Auth for sign-in (email and password stored in the app's own database,
no outside account needed). Keep secrets in the project's `.env`, never in git.
