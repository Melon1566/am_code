#!/bin/sh
# Install only this standalone tool, preserving configuration on later upgrades.
set -eu
if [ "$(uname -s)" != Linux ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer requires Linux with systemd." >&2
  exit 1
fi
if [ "$(id -u)" != 0 ]; then
  echo "Run with sudo: sudo ./install.sh [listen-address]" >&2
  exit 1
fi
if [ "$#" -gt 1 ]; then
  echo "Usage: sudo ./install.sh [listen-address]" >&2
  exit 1
fi
proxy_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
proxy_node=$(command -v node || true)
if [ -z "$proxy_node" ]; then
  echo "Install Node.js 24.13+ system-wide first; see README.md." >&2
  exit 1
fi
# ProtectHome prevents the service from using an nvm binary in a home directory.
case "$proxy_node" in
  /usr/*|/opt/*) ;;
  *) echo "Node must be installed under /usr or /opt (not a user's home)." >&2; exit 1 ;;
esac
case "$proxy_node" in
  *[!a-zA-Z0-9/_.-]*) echo "Unsupported Node executable path." >&2; exit 1 ;;
esac
"$proxy_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 13)) { console.error("Node.js 24.13+ is required"); process.exit(1); }'
proxy_bind=${1:-127.0.0.1}
"$proxy_node" -e 'if (!require("node:net").isIP(process.argv[1])) { console.error("Listen address must be an IPv4 or IPv6 address"); process.exit(1); }' "$proxy_bind"

install -d -m 755 /opt/t3-proxy-server
install -m 644 "$proxy_source/server.ts" "$proxy_source/package.json" /opt/t3-proxy-server/
install -m 755 "$proxy_source/start.sh" /opt/t3-proxy-server/start.sh
if [ ! -f /etc/t3-proxy-server.env ]; then
  install -m 600 "$proxy_source/proxy.env.example" /etc/t3-proxy-server.env
fi
# An explicit bind argument updates the saved address; upgrades without one preserve it.
if [ "$#" -eq 1 ]; then
  sed -i '/^T3_PROXY_HOST=/d' /etc/t3-proxy-server.env
  printf '\nT3_PROXY_HOST=%s\n' "$proxy_bind" >> /etc/t3-proxy-server.env
fi
sed -i '/^NODE_BIN=/d' /etc/t3-proxy-server.env
printf '\nNODE_BIN=%s\n' "$proxy_node" >> /etc/t3-proxy-server.env
install -m 644 "$proxy_source/t3-proxy-server.service" /etc/systemd/system/t3-proxy-server.service
systemctl daemon-reload
systemctl enable t3-proxy-server.service
systemctl restart t3-proxy-server.service
systemctl --no-pager --full status t3-proxy-server.service
printf '\nConfiguration: /etc/t3-proxy-server.env\nLogs: sudo journalctl -u t3-proxy-server -f\n'
