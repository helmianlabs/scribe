#!/bin/bash
# Swap production claude-memory-mcp to the write build, with auto-rollback.
set -u
cd /opt/claude-memory-mcp
docker rm -f claude-memory-mcp >/dev/null 2>&1
docker run -d --name claude-memory-mcp --restart unless-stopped \
  --env-file /opt/claude-memory-mcp/app.env \
  -p 127.0.0.1:8080:8080 claude-memory-mcp:write-candidate >/dev/null
for i in $(seq 1 15); do
  sleep 1
  if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then
    echo "new build healthy on :8080"
    exit 0
  fi
done
echo "NEW BUILD UNHEALTHY — rolling back to prewrite image"
docker logs --tail 20 claude-memory-mcp
docker rm -f claude-memory-mcp >/dev/null 2>&1
docker run -d --name claude-memory-mcp --restart unless-stopped \
  --env-file /opt/claude-memory-mcp/app.env \
  -p 127.0.0.1:8080:8080 claude-memory-mcp:prewrite-20261021 >/dev/null
sleep 3
curl -sf http://localhost:8080/healthz && echo "rollback healthy"
