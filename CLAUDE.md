# lofiwave

A small web console for the coding agents running on a machine (Claude Code, Codex, any command): see
them, start and stop them, drive the real TUI from the browser, schedule workflows. `README.md` explains how
it works and documents the API; `issues.md` is open work; `ideas-fridge.md` is parked ideas.

- **Server**: Bun + SQLite, no other dependencies (`src/`). `src/server.ts` is the HTTP/WebSocket entry,
  `src/runner.ts` starts runs (interactive ones in tmux `ac-<run>`), `src/tty.ts` is the browser terminal,
  `src/agents.ts` finds Claude transcripts and Codex rollouts.
- **UI**: vanilla JS with no build step (`public/app.js`, `public/style.css`); third-party code is vendored
  in `public/vendor/`.
- **Designs** for larger work are in `docs/`.

## Working here

- The repo is public. Hostnames, IPs, cloud project ids, teammates' details and anything else about where
  lofiwave runs stay out of it, `issues.md` included.
- Those go in `ops/`: the private repo `luquitared/lofiwave-ops`, cloned at `./ops` and imported below
  (ops facts in its docs, ops issues in `ops/issues.md`). If `ops/` isn't cloned, ask instead of
  writing them here.
- `main` takes changes only through a pull request.
- Never `git commit -a`: other sessions leave unfinished work in the tree. Stage the files you changed.
- `AGENT_CONSOLE_*` env vars, the `agent-console` service names and `data/agent-console.sqlite` keep the
  old name on purpose, so existing installs keep working. Don't rename them.
- New issues go in `issues.md`. When something in `ideas-fridge.md` becomes next, move it there.

@ops/CLAUDE.md
