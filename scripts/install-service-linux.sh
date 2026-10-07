#!/usr/bin/env bash
# Installs agent-console as a *user* systemd service that starts at boot (no sudo needed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.config/systemd/user"
cp "$HERE/agent-console.service" "$HOME/.config/systemd/user/agent-console.service"
chmod +x "$HERE/start.sh"
systemctl --user daemon-reload
systemctl --user enable --now agent-console.service
# Lingering makes user services start at boot without anyone logging in.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  loginctl enable-linger "$USER" || echo "!! could not enable linger; run: sudo loginctl enable-linger $USER"
fi
sleep 1
systemctl --user --no-pager status agent-console.service | head -5
echo
echo "Logs:   journalctl --user -u agent-console -f"
echo "Stop:   systemctl --user stop agent-console"
echo "Remove: systemctl --user disable --now agent-console"
ROOT="$(cd "$HERE/.." && pwd)"
if [ -f "$ROOT/data/auth-token" ]; then
  PORT_="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || true)"
  echo "Open:   http://127.0.0.1:${PORT_:-7770}/#token=$(cat "$ROOT/data/auth-token")"
fi
