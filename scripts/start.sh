#!/usr/bin/env bash
# Launches agent-console with the user's tool paths (bun, claude, codex, node) on PATH.
# Used by the systemd/launchd service, but you can also run it by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
# Optional overrides live in .env (KEY=VALUE per line): PORT, HOST, AUTH_TOKEN, DATA_DIR ...
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec bun run src/server.ts
