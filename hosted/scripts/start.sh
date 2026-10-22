#!/usr/bin/env bash
# Starts the hosted server with .env taking precedence over the inherited environment (an agent started by a
# lofiwave console inherits that console's PORT and HOST, which would otherwise win over .env).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec bun run src/server.ts
