#!/usr/bin/env bash
# Installs OpenSSH server and restricts it to connections arriving over Tailscale.
# Two independent layers enforce this:
#   1. ufw: port 22 is allowed only on the tailscale0 interface and denied everywhere else.
#      (Other ports are left exactly as they are today; ufw's default policy is set to
#       "allow incoming" so nothing else on the LAN changes. See STRICT below.)
#   2. sshd: AllowUsers limits logins to this user coming from Tailscale's address ranges.
# Needs sudo. Re-runnable. Undo: sudo ufw delete allow in on tailscale0 to any port 22 proto tcp;
#   sudo ufw delete deny in to any port 22 proto tcp; sudo rm /etc/ssh/sshd_config.d/10-tailscale-only.conf; sudo systemctl restart ssh
set -euo pipefail

USER_NAME="${SUDO_USER:-$USER}"
TS4="100.64.0.0/10"            # Tailscale CGNAT range (all tailnet IPv4 addresses)
TS6="fd7a:115c:a1e0::/48"      # Tailscale IPv6 range
STRICT="${STRICT:-0}"          # STRICT=1 also sets ufw default deny incoming (only tailscale + loopback reach this box)

command -v tailscale >/dev/null || { echo "tailscale is not installed; run scripts/install-tailscale-linux.sh first" >&2; exit 1; }
TS_IP="$(tailscale ip -4 | head -1)"
[ -n "$TS_IP" ] || { echo "tailscale is not up (no IPv4). Run: sudo tailscale up" >&2; exit 1; }

echo "==> installing openssh-server + ufw"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server ufw >/dev/null

echo "==> sshd: tailscale-only login policy for $USER_NAME"
sudo mkdir -p /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/10-tailscale-only.conf >/dev/null <<CONF
# Managed by agent-console/scripts/setup-ssh-tailscale-only.sh
# Only $USER_NAME may log in, and only from Tailscale addresses (or the machine itself).
AllowUsers $USER_NAME@$TS4 $USER_NAME@$TS6 $USER_NAME@127.0.0.1 $USER_NAME@::1
PermitRootLogin no
X11Forwarding no
MaxAuthTries 4
# Password login stays enabled because only the tailnet can reach this port.
# After copying a key here (ssh-copy-id $USER_NAME@$TS_IP from another device), harden with:
#   PasswordAuthentication no
CONF
sudo mkdir -p -m 0755 /run/sshd   # sshd -t needs this even before the service has ever run
sudo sshd -t   # validate config before touching the service

echo "==> ufw: port 22 only via tailscale0"
if [ "$STRICT" = "1" ]; then
  sudo ufw default deny incoming
  sudo ufw allow in on lo
  sudo ufw allow in on tailscale0
else
  sudo ufw default allow incoming   # keep today's behaviour for every other port
fi
sudo ufw default allow outgoing
# Order matters: the allow rule must come before the deny rule.
sudo ufw insert 1 allow in on tailscale0 to any port 22 proto tcp comment 'ssh via tailscale'
sudo ufw deny in to any port 22 proto tcp comment 'ssh blocked off-tailnet'
sudo ufw --force enable

echo "==> starting sshd"
sudo systemctl enable --now ssh
sudo systemctl restart ssh

echo
sudo ufw status numbered | sed -n '1,12p'
echo
echo "SSH is up and reachable only over Tailscale:"
echo "  ssh $USER_NAME@$TS_IP"
echo "  ssh $USER_NAME@$(tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo "$TS_IP")"
echo "Copy your key from another device:  ssh-copy-id $USER_NAME@$TS_IP"
echo "Then disable passwords: sudo sed -i 's/^#   PasswordAuthentication no/PasswordAuthentication no/' /etc/ssh/sshd_config.d/10-tailscale-only.conf && sudo systemctl restart ssh"
