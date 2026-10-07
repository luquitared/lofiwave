#!/usr/bin/env bash
# Installs agent-console as a launchd agent: starts at login, restarts if it dies.
# Logs go to data/server.log (owner-only, like the rest of data/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.agent-console.plist"
mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
chmod 700 "$ROOT/data"
sed "s|REPLACE_WITH_ABSOLUTE_PATH/agent-console|$ROOT|g" "$ROOT/scripts/com.agent-console.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/com.agent-console" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed $DEST"
sleep 2
if [ -f "$ROOT/data/auth-token" ]; then
  PORT_="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || true)"
  echo "open: http://127.0.0.1:${PORT_:-7770}/#token=$(cat "$ROOT/data/auth-token")"
else
  echo "log: $ROOT/data/server.log"
fi
