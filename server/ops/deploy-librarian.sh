#!/usr/bin/env bash
# One-command, reversible deploy of the Librarian build of claude-memory-mcp. Runs ON the box as root.
#   bash deploy-librarian.sh <path-to-new-app-dir>
# Steps: backup app dir -> tag running image for rollback -> build new image -> start a CANDIDATE on
# 127.0.0.1:18081 and verify it -> swap production (same flags as deploy-write.sh) -> verify live ->
# automatic rollback (old image + old app dir) on any failure.
set -euo pipefail
umask 077
NEW_SRC=${1:?usage: deploy-librarian.sh <new app dir>}
ROOT=/opt/claude-memory-mcp
APP=$ROOT/app
NAME=claude-memory-mcp
STAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP=/opt/backups/claude-memory-mcp-$STAMP-prelibrarian
ROLLBACK_TAG=claude-memory-mcp:prelibrarian-$STAMP
NEW_TAG=claude-memory-mcp:librarian-$STAMP
VERIFY=$ROOT/verify-librarian.mjs
# OAuth clients/tokens persist in $ROOT/data/oauth-state.json (mounted at /data) so restarts keep connections.
mkdir -p "$ROOT/data" && chmod 700 "$ROOT/data"
run_prod() { docker run -d --name "$NAME" --restart unless-stopped --env-file "$ROOT/app.env" -p 127.0.0.1:8080:8080 -v "$ROOT/data:/data" "$1" >/dev/null; }
wait_healthy() { for i in $(seq 1 30); do sleep 1; curl -sf "http://localhost:$1/healthz" >/dev/null 2>&1 && return 0; done; return 1; }

echo "1/7 backup $APP -> $BACKUP/app"
mkdir -p "$BACKUP" && cp -a "$APP" "$BACKUP/app"
echo "2/7 tag running image as $ROLLBACK_TAG"
docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" "$ROLLBACK_TAG"
echo "$ROLLBACK_TAG" > "$BACKUP/rollback-tag.txt"

echo "3/7 install new source + build $NEW_TAG"
rsync -a --delete --exclude node_modules --exclude dist --exclude '.env*' "$NEW_SRC"/ "$APP"/
if ! docker build -q -t "$NEW_TAG" "$APP" >/dev/null; then
  echo "BUILD FAILED - restoring app dir, production untouched"; rsync -a --delete "$BACKUP/app"/ "$APP"/; exit 1
fi

echo "4/7 candidate on 127.0.0.1:18081 + verify"
docker rm -f "$NAME-candidate" >/dev/null 2>&1 || true
docker run -d --name "$NAME-candidate" --env-file "$ROOT/app.env" -e OAUTH_STATE_FILE=/tmp/oauth-state.json -p 127.0.0.1:18081:8080 "$NEW_TAG" >/dev/null
if ! wait_healthy 18081 || ! node "$VERIFY" http://localhost:18081; then
  docker logs --tail 30 "$NAME-candidate" || true
  docker rm -f "$NAME-candidate" >/dev/null
  echo "CANDIDATE FAILED - restoring app dir, production untouched"; rsync -a --delete "$BACKUP/app"/ "$APP"/; exit 1
fi
docker rm -f "$NAME-candidate" >/dev/null

rollback() {
  echo "ROLLBACK -> $ROLLBACK_TAG"
  docker logs --tail 30 "$NAME" || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  run_prod "$ROLLBACK_TAG"
  rsync -a --delete "$BACKUP/app"/ "$APP"/
  wait_healthy 8080 && echo "rollback healthy"
  exit 1
}
echo "5/7 swap production to $NEW_TAG"
docker rm -f "$NAME" >/dev/null
run_prod "$NEW_TAG"
wait_healthy 8080 || rollback
echo "6/7 verify live (local port and public door)"
node "$VERIFY" http://localhost:8080 || rollback
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' https://<SERVER_HOST>/mcp)
[ "$code" = 401 ] || rollback
cat > "$ROOT/rollback-librarian.sh" <<RB
#!/usr/bin/env bash
# Roll production back to the image that ran before the Librarian deploy of $STAMP.
set -euo pipefail
docker rm -f $NAME
docker run -d --name $NAME --restart unless-stopped --env-file $ROOT/app.env -p 127.0.0.1:8080:8080 -v $ROOT/data:/data $ROLLBACK_TAG
rsync -a --delete $BACKUP/app/ $APP/
RB
chmod 700 "$ROOT/rollback-librarian.sh"
echo "7/7 LIVE: $NEW_TAG   rollback: bash $ROOT/rollback-librarian.sh   backup: $BACKUP"
