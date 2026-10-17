# Sandboxed runs: Cloud Run vs E2B

lofiwave can run an agent somewhere other than this machine through a *run target* (`src/targets.ts`). Two kinds
exist: `cloud-run`, which runs a Google Cloud Run Job, and `e2b`, which gives each run its own E2B sandbox (`src/e2b.ts`).
Both bring the claude transcript back so **Transcript** and **Resume here** work locally. Here is how to choose.

| | Cloud Run (`cloud-run`) | E2B (`e2b`) |
|---|---|---|
| Isolation | A gen2 container (gVisor sandbox) per execution, in your GCP project, with its own service account | A Firecracker microVM per run, on E2B's infrastructure |
| Live terminal (TUI) | No. Headless only: output is copied from Cloud Logging every few seconds | **Yes.** The agent runs in a PTY. The browser terminal, `/screen` and `/keys` all work, and several viewers can share it as with tmux |
| Steering a run | Not possible. Nobody can answer permission prompts, so set a permission mode | Type into it, answer prompts, interrupt it, send it more work |
| Files in | Only through a `repo` cloned at start | `repo` clone, plus `input_dir` uploaded to `<workdir>/in/` |
| Files out | Lost unless the agent pushes them; only the transcript comes back (through the logs) | The transcript and `<workdir>/out/` are copied to `DATA_DIR/runs/<id>/out/`. With `on_exit: "pause"` the whole sandbox is kept to inspect later |
| Idle | Not applicable (the run ends when the agent exits) | `idle_sec` pauses the sandbox (memory and disk kept; opening the terminal resumes it) or ends the run |
| Console restart | Follows the execution again | Reconnects to the sandbox and to the agent's PTY by tag (resuming the sandbox if it paused) |
| Credentials | Secret Manager secrets, read by the job's service account. Nothing leaves this machine | `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (or what `env_from` names) are sent from this machine's env into the sandbox at creation. lofiwave's own token never goes in |
| Setup | `gcloud` logged in on this machine, an image with the agent (`docker/claude/Dockerfile`), and a region | `E2B_API_KEY` in lofiwave's environment. The stock `claude` template works as is |
| Image / size | Any image. CPU and memory set per target | An E2B template (build your own from `claude` for extra tools). CPU and memory come from the template (default 2 vCPU / 4 GiB) |
| Limits | Task timeout up to 24h. Startup is tens of seconds (job update + execution) | Sandbox lifetime 1h on Hobby, 24h on Pro (renewed while active, capped by plan). 20 concurrent sandboxes on Hobby, 100 on Pro. Startup takes a few seconds |
| Cost | Cloud Run Jobs vCPU/GiB-seconds while the task runs, plus Logging | About $0.05 per vCPU-hour and $0.016 per GiB-hour, so the default size is about $0.17/h while running. Hobby: $100 one-time credit. Pro: $150/month plus usage. E2B's pricing page doesn't say how paused sandboxes are billed |
| Where it runs | Your GCP project and region | E2B's cloud, so data leaves your cloud account |

**Pick E2B** when a person should be able to watch and steer each worker (a swarm with a human in the loop),
when results are files rather than pushed commits, or when you want per-run VMs without managing images.
**Pick Cloud Run** for unattended scheduled jobs that must stay inside your own GCP project and IAM, or that run
longer than E2B's plan limit.

## How the E2B target works

- **No SDK.** The control plane is REST (`POST /v2/sandboxes`, `/connect`, `/pause`, `/timeout`, `DELETE`, with
  `X-API-Key`). The sandbox's `envd` daemon speaks Connect-RPC over HTTP with the JSON codec: unary calls for input,
  resize and signals, and server-streaming `Process.Start` / `Process.Connect` with enveloped frames (flag byte +
  big-endian length + JSON) for output. Client streaming would need HTTP/2, so input goes through unary
  `SendInput` calls, batched and in order. `src/connect.ts` implements the framing. Files go through envd's
  `/files` endpoint.
- **Terminal bridge.** `E2BTerm` holds the PTY's output stream. It fans output out to every browser terminal,
  keeps the last 512 KB for a new viewer, and feeds a small headless terminal (`src/vtscreen.ts`) that tracks the
  screen as text for `/screen`, `/history` (plain text, no colours) and the run log. When a viewer opens the
  terminal, the PTY is resized, so the TUI repaints for it.
- **First-run prompts.** Before starting claude it writes `~/.claude.json` (onboarding done, the workdir trusted, the
  API key's suffix approved, bypass-permissions accepted) and `skipDangerousModePermissionPrompt` in
  `~/.claude/settings.json`. The TUI then comes up ready to work.

## Not done yet

- No settings form for e2b targets (use `POST/PUT /api/targets`).
- **Resume here** continues the conversation locally, not in a new sandbox.
- `/history` on an E2B run is plain text, without colours.
- The 512 KB replay plus the forced repaint is a good-enough picture for a new viewer. It isn't the exact
  scrollback a tmux attach would show.
