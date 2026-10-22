#!/usr/bin/env bash
# Copy the Librarian engine into the server source (rewrites .ts imports to .js for the server's tsc).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p server.src/app/src/librarian
for f in src/librarian/*.ts; do sed -E "s/from '(\.\/[a-zA-Z]+)\.ts'/from '\1.js'/g" "$f" > "server.src/app/src/librarian/$(basename "$f")"; done
echo synced
