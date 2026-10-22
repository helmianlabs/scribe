#!/usr/bin/env bash
# ONE-COMMAND, REVERSIBLE deploy of the Librarian onto the live claude-memory-mcp container.
# DO NOT RUN WITHOUT SAM'S GO-AHEAD. Runs ON the box as root:  bash deploy-librarian.sh
# Precondition: migrations/001_librarian.sql already applied as neondb_owner (Neon SQL editor),
#               and the server's save_memory handler patched to call fileMessage() (docs/SERVER_PATCH.md).
# Mirrors spec 2.5: backup dir + rollback image tag + health check + automatic rollback.
set -euo pipefail
umask 077   # backup files hold the container env (secrets): root-only
APP=/opt/claude-memory-mcp
NAME=claude-memory-mcp
STAMP=$(date +%Y%m%d-%H%M)
BACKUP=/opt/backups/claude-memory-mcp-$STAMP-prelibrarian
ROLLBACK_TAG=claude-memory-mcp:prelibrarian-$STAMP
NEW_TAG=claude-memory-mcp:librarian-$STAMP
HEALTH_URL=${HEALTH_URL:-https://<SERVER_HOST>/.well-known/oauth-protected-resource/mcp}

echo "1/6 backup $APP -> $BACKUP"
mkdir -p "$BACKUP" && cp -a "$APP"/. "$BACKUP"/

CUR_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$NAME")
echo "2/6 tag running image $CUR_IMAGE as $ROLLBACK_TAG"
docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" "$ROLLBACK_TAG"
docker inspect "$NAME" > "$BACKUP/container-inspect.json"

echo "3/6 build $NEW_TAG from $APP"
docker build -t "$NEW_TAG" "$APP"

echo "4/6 swap container (same env-file, ports, network, restart policy as before)"
RUN_ARGS=$(python3 - "$BACKUP/container-inspect.json" <<'PY'
import json,sys,shlex
c=json.load(open(sys.argv[1]))[0]; h=c['HostConfig']; a=[]
for p,b in (h.get('PortBindings') or {}).items():
    for x in b or []: ip=x.get('HostIp'); a+=['-p', (f"{ip}:" if ip else '')+f"{x['HostPort']}:{p}"]
if h.get('NetworkMode') not in (None,'default','bridge'): a+=['--network',h['NetworkMode']]
r=h.get('RestartPolicy',{}).get('Name'); a+=['--restart', r or 'unless-stopped']
for e in c['Config'].get('Env') or []: a+=['-e',e]
for m in h.get('Binds') or []: a+=['-v',m]
print(' '.join(shlex.quote(x) for x in a))
PY
)
echo "$RUN_ARGS" > "$BACKUP/run-args.txt"; chmod 600 "$BACKUP/run-args.txt" "$BACKUP/container-inspect.json"
docker rm -f "$NAME" >/dev/null
eval docker run -d --name "$NAME" $RUN_ARGS "$NEW_TAG" >/dev/null

rollback() {
  echo "ROLLBACK -> $ROLLBACK_TAG"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  eval docker run -d --name "$NAME" $RUN_ARGS "$ROLLBACK_TAG" >/dev/null
  exit 1
}

echo "5/6 health check"
ok=0
for i in $(seq 1 20); do
  sleep 3
  if curl -fsS -m 5 "$HEALTH_URL" | grep -q '"memory.write"'; then ok=1; break; fi
done
[ "$ok" = 1 ] || rollback
# the door must still refuse anonymous calls
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' https://<SERVER_HOST>/mcp)
[ "$code" = 401 ] || rollback

echo "6/6 live: $NEW_TAG   rollback any time:  bash $APP/rollback-librarian.sh $ROLLBACK_TAG"
cat > "$APP/rollback-librarian.sh" <<RB
#!/usr/bin/env bash
set -euo pipefail
docker rm -f $NAME
eval docker run -d --name $NAME \$(cat $BACKUP/run-args.txt) \${1:-$ROLLBACK_TAG}
RB
chmod 700 "$APP/rollback-librarian.sh"
echo "Note: each connected AI may ask Sam to approve access again after the restart (one click + passphrase)."
