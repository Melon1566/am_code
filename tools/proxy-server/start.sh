#!/bin/sh
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
proxy_node=${NODE_BIN:-node}
"$proxy_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 13)) { console.error("Node.js 24.13+ is required"); process.exit(1); }'
exec "$proxy_node" --max-old-space-size=64 server.ts
