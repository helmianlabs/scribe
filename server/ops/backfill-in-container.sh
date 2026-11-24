#!/usr/bin/env bash
# Run the backfill INSIDE the live container (uses its DATABASE_WRITE_URL = memory_rw; never printed).
# Only after migration 001 is applied. From a machine with this repo + SSH to the box:
#   ops/backfill-in-container.sh            # files everything not yet filed
#   ops/backfill-in-container.sh --dry      # counts + distribution only, writes nothing
set -euo pipefail
cd "$(dirname "$0")/.."
npx esbuild scripts/backfill.ts --bundle --platform=node --format=esm --external:pg --outfile=/tmp/backfill.mjs --log-level=error
KEY=${KEY:-$HOME/.ssh/helmian_hetzner}
scp -q -i "$KEY" /tmp/backfill.mjs root@<SERVER_IP>:/tmp/backfill.mjs
ssh -i "$KEY" root@<SERVER_IP> "docker cp /tmp/backfill.mjs claude-memory-mcp:/app/librarian-backfill.mjs && \
  docker exec claude-memory-mcp sh -c 'DATABASE_WRITE_URL=\"\$DATABASE_WRITE_URL\" node --no-warnings /app/librarian-backfill.mjs --preset D $*'; \
  docker exec claude-memory-mcp rm -f /app/librarian-backfill.mjs"
