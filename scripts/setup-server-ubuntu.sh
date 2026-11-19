#!/usr/bin/env bash
# Sets up lofiwave as a shared team server on a fresh Ubuntu VM (tested on 24.04), behind HTTPS.
#
#   sudo DOMAIN=console.example.com PASSWORD='team password' scripts/setup-server-ubuntu.sh
#
# Run it from a clone owned by the user the agents should run as (not root). It installs tmux, Caddy, Bun and
# Claude Code for that user, writes .env (HOST=127.0.0.1, PASSWORD, OPEN_TERMINAL=none), installs a system service
# (agent-console.service, running as that user) and puts Caddy in front with an automatic Let's Encrypt certificate.
# No domain? DOMAIN=<ip with dashes>.sslip.io works (e.g. 203-0-113-7.sslip.io). Safe to run again.
# APPS=1 also gives apps built on the box a public URL by port (https://3000.$DOMAIN); the domain's subdomains must
# point here (sslip.io's do). For a full dev box (Docker, Postgres, Node, …) run scripts/setup-dev-box.sh first.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
: "${DOMAIN:?set DOMAIN (e.g. 203-0-113-7.sslip.io)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="$(stat -c %U "$ROOT")"
[ "$RUN_AS" != root ] || { echo "the clone at $ROOT is owned by root; clone it as the user the agents should run as" >&2; exit 1; }
HOME_DIR="$(getent passwd "$RUN_AS" | cut -d: -f6)"
as_user() { sudo -u "$RUN_AS" -H bash -lc "$1"; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux git curl unzip jq ripgrep build-essential python3-venv python3-pip caddy >/dev/null

echo "== bun + claude code for $RUN_AS"
as_user 'command -v bun >/dev/null || [ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash >/dev/null'
as_user '[ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash >/dev/null'
grep -q '.local/bin' "$HOME_DIR/.bashrc" || echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME_DIR/.bashrc"

echo "== .env"
ENV="$ROOT/.env"
touch "$ENV"; chown "$RUN_AS": "$ENV"; chmod 600 "$ENV"
setkv() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
setkv HOST 127.0.0.1
setkv OPEN_TERMINAL none
grep -q '^PORT=' "$ENV" || setkv PORT 7770
if [ -n "${PASSWORD:-}" ]; then setkv PASSWORD "$PASSWORD"; fi
grep -q '^PASSWORD=.' "$ENV" || echo "!! no PASSWORD in .env: people will need the API token to get in"
PORT="$(grep '^PORT=' "$ENV" | cut -d= -f2)"

echo "== session hook (links runs to their claude transcripts)"
SETTINGS="$HOME_DIR/.claude/settings.json"
as_user "mkdir -p ~/.claude && [ -f ~/.claude/settings.json ] || echo '{}' > ~/.claude/settings.json"
HOOK="$ROOT/scripts/claude-session-hook.sh"
jq --arg c "$HOOK" '.hooks.SessionStart //= [] | .hooks.SessionEnd //= []
  | if any(.hooks.SessionStart[].hooks[]?; .command == $c) then . else .hooks.SessionStart += [{"hooks":[{"type":"command","command":$c,"timeout":5}]}] end
  | if any(.hooks.SessionEnd[].hooks[]?; .command == $c) then . else .hooks.SessionEnd += [{"hooks":[{"type":"command","command":$c,"timeout":5}]}] end' \
  "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS" && chown "$RUN_AS": "$SETTINGS"

echo "== service"
chmod +x "$ROOT/scripts/start.sh" "$HOOK"
cat > /etc/systemd/system/agent-console.service <<EOF
[Unit]
Description=lofiwave
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
ExecStart=$ROOT/scripts/start.sh
Restart=on-failure
# Stopping the console leaves the agents (and their tmux sessions) running.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
loginctl enable-linger "$RUN_AS"   # keeps the user's tmux server alive between logins
systemctl daemon-reload
systemctl enable agent-console >/dev/null
systemctl restart agent-console

echo "== caddy (https://$DOMAIN)"
if [ "${APPS:-}" = 1 ]; then
  # Apps people build here get a public URL by port: https://3000.$DOMAIN → 127.0.0.1:3000 (ports 1000-65535).
  # Certificates are fetched on demand, the first time a name is visited; `ask` only allows <port>.$DOMAIN.
  ESC="$(printf '%s' "$DOMAIN" | sed 's/[.]/\\./g')"
  RE="^([0-9]{4,5})\\.${ESC}\$"
  cat > /etc/caddy/Caddyfile <<EOF
{
	on_demand_tls {
		ask http://127.0.0.1:5555/
	}
}
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
https:// {
	tls {
		on_demand
	}
	@app header_regexp app Host \`$RE\`
	handle @app {
		reverse_proxy 127.0.0.1:{re.app.1}
	}
	handle {
		respond "Nothing here" 404
	}
}
http://127.0.0.1:5555 {
	bind 127.0.0.1
	@ok vars_regexp {query.domain} \`$RE\`
	respond @ok 200
	respond 403
}
EOF
else
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
fi
systemctl reload caddy || systemctl restart caddy

sleep 2
systemctl --no-pager --lines 5 status agent-console | head -8
echo
echo "Open:    https://$DOMAIN"
if [ "${APPS:-}" = 1 ]; then echo "Apps:    https://<port>.$DOMAIN"; fi
echo "Logs:    journalctl -u agent-console -f"
echo "Claude:  sudo -iu $RUN_AS claude   (log in once, so agents can run)"
