#!/usr/bin/env bash
# Turns an Ubuntu VM (tested on 24.04) into a box people build apps on with agents: Docker, Postgres, Node, Bun,
# Python (uv), ffmpeg, gh, and a ~/.claude/CLAUDE.md telling the agents how this box works. Run it before
# scripts/setup-server-ubuntu.sh (with APPS=1, so apps get public URLs), from a clone owned by the agents' user:
#
#   sudo DOMAIN=203-0-113-7.sslip.io ANTHROPIC_API_KEY=sk-ant-... AGENT_SUDO=1 scripts/setup-dev-box.sh
#
# DOMAIN: the box's domain (apps are at https://<port>.$DOMAIN). ANTHROPIC_API_KEY (optional): every agent uses it,
# with claude's first-run prompts pre-accepted. AGENT_SUDO=1: the agents' user gets passwordless sudo, so an agent
# can apt install what a project needs (only for boxes whose people trust each other). Agents run in
# bypassPermissions mode. Safe to run again; KEY_ONLY=1 just (re)sets the API key.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="$(stat -c %U "$ROOT")"
[ "$RUN_AS" != root ] || { echo "the clone at $ROOT is owned by root; clone it as the user the agents should run as" >&2; exit 1; }
HOME_DIR="$(getent passwd "$RUN_AS" | cut -d: -f6)"
as_user() { sudo -u "$RUN_AS" -H bash -lc "$1"; }
ENV="$ROOT/.env"
touch "$ENV"; chown "$RUN_AS": "$ENV"; chmod 600 "$ENV"
setkv() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }

set_key() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] || return 0
  echo "== anthropic key (…${ANTHROPIC_API_KEY: -6})"
  setkv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  # claude asks once whether to use a key it finds in the env; approve this one (it remembers the last 20 chars).
  as_user "mkdir -p ~/.claude"
  K="$ANTHROPIC_API_KEY" python3 - "$HOME_DIR/.claude.json" <<'PY'
import json, os, sys
p = sys.argv[1]
try: j = json.load(open(p))
except Exception: j = {}
j["hasCompletedOnboarding"] = True
j["bypassPermissionsModeAccepted"] = True
r = j.setdefault("customApiKeyResponses", {"approved": [], "rejected": []})
r.setdefault("approved", [])
k = os.environ["K"][-20:]
if k not in r["approved"]: r["approved"].append(k)
json.dump(j, open(p, "w"), indent=2)
PY
  chown "$RUN_AS": "$HOME_DIR/.claude.json"
}
if [ "${KEY_ONLY:-}" = 1 ]; then set_key; exit 0; fi
: "${DOMAIN:?set DOMAIN (e.g. 203-0-113-7.sslip.io)}"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq unzip ripgrep build-essential python3-venv python3-pip \
  ffmpeg sqlite3 postgresql-client gh docker.io docker-compose-v2 >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null
usermod -aG docker "$RUN_AS"
as_user 'command -v uv >/dev/null || [ -x ~/.local/bin/uv ] || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null'
as_user 'command -v bun >/dev/null || [ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash >/dev/null'
# ~/.bashrc stops early for non-interactive shells, so put the user's tool dirs on PATH in ~/.profile too.
grep -q '.bun/bin' "$HOME_DIR/.profile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME_DIR/.profile"

if [ "${AGENT_SUDO:-}" = 1 ]; then
  echo "== passwordless sudo for $RUN_AS"
  echo "$RUN_AS ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$RUN_AS"; chmod 440 "/etc/sudoers.d/90-$RUN_AS"
fi

echo "== postgres (docker, 127.0.0.1:5432, and 172.17.0.1:5432 for containers)"
systemctl enable --now docker >/dev/null
if ! docker inspect postgres >/dev/null 2>&1; then
  PGPASS="$(openssl rand -hex 16)"
  docker run -d --name postgres --restart unless-stopped -p 127.0.0.1:5432:5432 -p 172.17.0.1:5432:5432 \
    -e POSTGRES_USER=app -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=app -v pgdata:/var/lib/postgresql/data postgres:16 >/dev/null
  setkv DATABASE_URL "postgres://app:$PGPASS@127.0.0.1:5432/app"
fi

echo "== agent settings"
setkv CLAUDE_PERMISSION_MODE bypassPermissions
setkv COREPACK_ENABLE_DOWNLOAD_PROMPT 0
setkv BOX_DOMAIN "$DOMAIN"
set_key
as_user "mkdir -p ~/.claude ~/apps"
if [ ! -f "$HOME_DIR/.claude/CLAUDE.md" ]; then
  sed "s/{{DOMAIN}}/$DOMAIN/g" "$ROOT/scripts/dev-box-CLAUDE.md" > "$HOME_DIR/.claude/CLAUDE.md"
  chown "$RUN_AS": "$HOME_DIR/.claude/CLAUDE.md"
fi
echo "Dev box ready. Next: sudo DOMAIN=$DOMAIN APPS=1 PASSWORD=… scripts/setup-server-ubuntu.sh"
