#!/usr/bin/env bash
# Step one of 2.9: copy the live server source off the box into server/ of this repo, WITHOUT secrets.
# Run from a machine whose SSH key is authorized on the box (the ~/.ssh/hetzner-runner key).
# Read-only on the box. Usage: ops/pull-server-source.sh [ssh-key]
set -euo pipefail
KEY="${1:-$HOME/.ssh/hetzner-runner}"
BOX=root@<SERVER_IP>
cd "$(dirname "$0")/.."
ssh -i "$KEY" "$BOX" 'tar -C /opt/claude-memory-mcp \
  --exclude=app.env --exclude="*.env" --exclude=".env*" --exclude=node_modules --exclude=backups \
  --exclude="*.pem" --exclude="*.key" --exclude="*.sqlite*" -czf - .' > /tmp/claude-memory-mcp-src.tgz
rm -rf server.new && mkdir server.new && tar -C server.new -xzf /tmp/claude-memory-mcp-src.tgz
# Refuse to continue if anything secret-looking slipped through.
if grep -rIlE 'postgres(ql)?://[^ "]*:[^ "@]+@|sk_live_|npg_[A-Za-z0-9]{8,}|AUTH_PASSPHRASE\s*=\s*\S' server.new; then
  echo "SECRET-LOOKING CONTENT FOUND above. Not copying. Clean it by hand." >&2; exit 1
fi
rm -rf server.src && mv server.new server.src
echo "Server source in server.src/. Review, then: git add server.src && git commit -m 'Server source v1.1.0 from box'"
