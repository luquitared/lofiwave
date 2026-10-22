# Sandboxed runs on E2B

lofiwave can run an agent somewhere other than this machine through a *run target* (`src/targets.ts`). The one kind
is `e2b`: each run gets its own E2B sandbox (`src/e2b.ts`), a Firecracker microVM with a live terminal you open
and type into from *Sessions*, files in (`input_dir`) and out (`out/`), and the claude transcript back at the end so
**Transcript** and **Resume here** work locally.

## Why not Cloud Run

A `cloud-run` kind (a Google Cloud Run Job per run, driven with `gcloud`) was built in PR #12 and dropped before it
landed. It could only run headless: no terminal, nobody to answer a prompt, no files back unless the agent pushed
them. That is the opposite of what lofiwave is for, and keeping both kinds meant every feature needed a "what about
Cloud Run" answer. What it offered that E2B doesn't (code and data never leaving your own GCP project and IAM, and
24h jobs on any plan) is parked in `ideas-fridge.md`.

## Limits and cost

- Sandbox lifetime: 1h on E2B's Hobby plan, 24h on Pro, renewed every minute while the run is active.
  20 concurrent sandboxes on Hobby, 100 on Pro. Startup takes a few seconds (plus installing tmux on the stock template).
- About $0.05 per vCPU-hour and $0.016 per GiB-hour, so the stock template's size (2 vCPU / 4 GiB) is about
  $0.17/h while running. Hobby: $100 one-time credit. Pro: $150/month plus usage.
- It runs in E2B's cloud, so code and data leave your machine. Claude's credentials go in from this machine's env;
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) makes it use a Claude subscription instead of API billing.

## How the E2B target works

- **No SDK.** The control plane is REST (`POST /v2/sandboxes`, `/connect`, `/pause`, `/timeout`, `DELETE`, with
  `X-API-Key`). The sandbox's `envd` daemon speaks Connect-RPC over HTTP with the JSON codec: unary calls for input,
  resize and signals, and server-streaming `Process.Start` / `Process.Connect` with enveloped frames (flag byte +
  big-endian length + JSON) for output. Client streaming would need HTTP/2, so input goes through unary
  `SendInput` calls, batched and in order. `src/connect.ts` implements the framing. Files go through envd's
  `/files` endpoint.
- **tmux in the sandbox.** An interactive agent runs in a tmux session there (installed with apt when the template
  lacks it), and the PTY lofiwave follows is a tmux client. After the sandbox is paused and resumed, envd's stream
  of a process started before the pause sends nothing more (input still reaches it), so following the agent's own
  PTY would leave its terminal blank; a fresh client after a resume, a console restart or a dropped stream avoids that.
- **Terminal bridge.** `E2BTerm` holds the PTY's output stream. It fans output out to every browser terminal,
  keeps the last 512 KB for a new viewer, and feeds a small headless terminal (`src/vtscreen.ts`) that tracks the
  screen as text for `/screen`, `/history` (plain text, no colours) and the run log. When a viewer opens the
  terminal, the PTY is resized, so the TUI repaints for it.
- **First-run prompts.** Before starting claude it writes `~/.claude.json` (onboarding done, the workdir trusted, the
  API key's suffix approved, bypass-permissions accepted) and `skipDangerousModePermissionPrompt` in
  `~/.claude/settings.json`. The TUI then comes up ready to work.

## Not done yet

- **Resume here** continues the conversation locally, not in a new sandbox.
- `/history` on an E2B run is plain text, without colours.
- The 512 KB replay plus the forced repaint is a good-enough picture for a new viewer. It isn't the exact
  scrollback a tmux attach would show.
