#!/usr/bin/env bash
# Installs Tailscale and brings it up so the console is reachable from your other devices.
# Needs sudo. After this, the console is at http://<this-machine-tailnet-name>:7770
set -euo pipefail
PORT="${PORT:-7770}"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable --now tailscaled
sudo tailscale up            # prints a login URL the first time
tailscale ip -4
# Optional: HTTPS on the tailnet via MagicDNS (https://<host>.<tailnet>.ts.net) instead of plain http://host:PORT
# sudo tailscale serve --bg "$PORT"
