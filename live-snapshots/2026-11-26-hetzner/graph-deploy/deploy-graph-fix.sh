#!/usr/bin/env bash
# deploy-graph-fix.sh — production deploy of the graph v2 extraction fix (migration 008 +
# extract.ts/graph.ts/librarian-tools.ts) to BOTH memory servers. Runs ON the Hetzner box as root.
# PREP STATUS: written and syntax-checked in the graph-fix prep bite; NOT yet run.
#
# HARD GATE: this deploy must not fire while the context auto-save study's full test is
# still running against the Scribe-side test store (a restart / filing change mid-test
# contaminates its comparison). The firing bite confirms RESULTS.md exists in
# ~/workspace/helmian-room-build/autosave-test/ and the verdict has been delivered, then
# runs:  AUTOSAVE_TEST_DONE=1 bash deploy-graph-fix.sh fire
#
# Order: stage -> migration check -> migration 008 on both DBs -> Helmian leg
# (deploy-librarian.sh, candidate + auto-rollback) -> Scribe leg (same discipline,
# hand pattern made explicit — no deploy script existed for it) -> proof on both sides.
set -euo pipefail
umask 077

if [ "${1:-}" != "fire" ] || [ "${AUTOSAVE_TEST_DONE:-}" != "1" ]; then
  echo "REFUSING TO RUN: the auto-save study gate is not confirmed."
  echo "Only run, from the firing bite, as: AUTOSAVE_TEST_DONE=1 bash deploy-graph-fix.sh fire"
  exit 2
fi

GF=/opt/graph-fix-deploy                 # this prep folder, copied to the box by the firing bite
ROOT=/opt/claude-memory-mcp
SB=/opt/scribe-build/graph-src           # Scribe memory build tree (its deploy was manual)
OWNER_ENV=/root/neon-migration.env       # owner connection strings live here (values never printed)
STAMP=$(date -u +%Y%m%d-%H%M%S)
STAGE=/opt/graph-fix-stage-$STAMP
HIMG=$(docker inspect -f '{{.Config.Image}}' claude-memory-mcp)
SIMG=$(docker inspect -f '{{.Config.Image}}' claude-memory-mcp-scribe)

say() { echo; echo "== $* =="; }
wait_healthy() { for i in $(seq 1 30); do sleep 1; curl -sf "http://localhost:$1/healthz" >/dev/null 2>&1 && return 0; done; return 1; }
# Migration helper: one-off container from a CURRENT image (bundles node + pg), owner env mounted ro.
# FIX 2026-11-23: the owner env mounts at /owner.env, NOT /gf/owner.env — the first firing
# died at step 2/6 because Docker on this box cannot create a mount point inside the
# read-only /gf mount ("read-only file system"). Nothing was applied by that run.
mig() { # $1 image, $2 owner var, $3 sql|-, $4 check|apply, $5 dbOverride(optional)
  docker run --rm --user 0 --entrypoint node -v "$GF:/gf:ro" -v "$OWNER_ENV:/owner.env:ro" "$1" \
    /gf/migrate-008.mjs /owner.env "$2" "$3" "$4" $5
}

say "0/6 sanity: prep files present, both servers up (helmian=$HIMG scribe=$SIMG)"
for f in extract.ts graph.ts librarian-tools.ts 008_graph_value_kind.sql migrate-008.mjs proof-graphfix.mjs; do
  [ -f "$GF/$f" ] || { echo "MISSING $GF/$f"; exit 1; }
done

say "1/6 stage source trees at $STAGE (production trees untouched)"
mkdir -p "$STAGE/helmian" "$STAGE/scribe"
cp -a "$ROOT/app/." "$STAGE/helmian/"
cp -a "$SB/." "$STAGE/scribe/"
for d in helmian scribe; do
  cp "$GF/extract.ts"        "$STAGE/$d/src/librarian/extract.ts"
  cp "$GF/graph.ts"          "$STAGE/$d/src/librarian/graph.ts"
  cp "$GF/librarian-tools.ts" "$STAGE/$d/src/librarian-tools.ts"
done
cp "$GF/008_graph_value_kind.sql" "$ROOT/migrations/008_graph_value_kind.sql"

say "2/6 migration CHECK on both databases (read-only; aborts if the constraint name differs)"
mig "$HIMG" LAUNCH_DAIRYFORGE_URL - check ""
mig "$SIMG" FREE_DAIRYFORGE_URL - check "claude_memory"

say "3/6 migration 008 APPLY on both databases, as owner, BEFORE any new code goes live"
mig "$HIMG" LAUNCH_DAIRYFORGE_URL /gf/008_graph_value_kind.sql apply ""
mig "$SIMG" FREE_DAIRYFORGE_URL /gf/008_graph_value_kind.sql apply "claude_memory"

say "4/6 Helmian memory leg: deploy-librarian.sh (backup, candidate on :18081, swap, verify, auto-rollback)"
LABEL=graphv2 bash "$ROOT/deploy-librarian.sh" "$STAGE/helmian"

say "5/6 Scribe memory leg: same discipline, explicit (no deploy script existed for this container)"
SBACKUP=/opt/backups/scribe-memory-$STAMP-pregraphv2
SROLL=scribe:pregraphv2-$STAMP
SNEW=scribe:graphv2-$STAMP
mkdir -p "$SBACKUP" && cp -a "$SB" "$SBACKUP/graph-src"
docker tag "$SIMG" "$SROLL"
rsync -a --delete --exclude node_modules --exclude dist --exclude '.env*' "$STAGE/scribe/" "$SB/"
if ! docker build -q -t "$SNEW" "$SB" >/dev/null; then
  echo "SCRIBE BUILD FAILED - restoring build tree, production untouched"
  rsync -a --delete "$SBACKUP/graph-src/" "$SB/"; exit 1
fi
docker rm -f claude-memory-mcp-scribe-candidate >/dev/null 2>&1 || true
docker run -d --name claude-memory-mcp-scribe-candidate --env-file "$ROOT/app-scribe.env" \
  -e OAUTH_STATE_FILE=/tmp/oauth-state.json -p 127.0.0.1:18082:8080 "$SNEW" >/dev/null
if ! wait_healthy 18082 || [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' http://localhost:18082/mcp)" != "401" ]; then
  docker logs --tail 30 claude-memory-mcp-scribe-candidate || true
  docker rm -f claude-memory-mcp-scribe-candidate >/dev/null
  echo "SCRIBE CANDIDATE FAILED - restoring build tree, production untouched"
  rsync -a --delete "$SBACKUP/graph-src/" "$SB/"; exit 1
fi
docker rm -f claude-memory-mcp-scribe-candidate >/dev/null
scribe_run() { docker run -d --name claude-memory-mcp-scribe --restart unless-stopped --env-file "$ROOT/app-scribe.env" -p 127.0.0.1:8081:8080 -v "$ROOT/data-scribe:/data" "$1" >/dev/null; }
scribe_rollback() {
  echo "SCRIBE ROLLBACK -> $SROLL"
  docker logs --tail 30 claude-memory-mcp-scribe || true
  docker rm -f claude-memory-mcp-scribe >/dev/null 2>&1 || true
  scribe_run "$SROLL"
  rsync -a --delete "$SBACKUP/graph-src/" "$SB/"
  wait_healthy 8081 && echo "scribe rollback healthy"
  exit 1
}
docker rm -f claude-memory-mcp-scribe >/dev/null
scribe_run "$SNEW"
wait_healthy 8081 || scribe_rollback
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' http://localhost:8081/mcp)" = "401" ] || scribe_rollback
cat > "$ROOT/rollback-scribe-graphv2.sh" <<RB
#!/usr/bin/env bash
# Roll the Scribe memory server back to the image that ran before the graphv2 deploy of $STAMP.
set -euo pipefail
docker rm -f claude-memory-mcp-scribe
docker run -d --name claude-memory-mcp-scribe --restart unless-stopped --env-file $ROOT/app-scribe.env -p 127.0.0.1:8081:8080 -v $ROOT/data-scribe:/data $SROLL
rsync -a --delete $SBACKUP/graph-src/ $SB/
RB
chmod 700 "$ROOT/rollback-scribe-graphv2.sh"
echo "scribe LIVE: $SNEW   rollback: bash $ROOT/rollback-scribe-graphv2.sh   backup: $SBACKUP"

say "6/6 proof on both sides (plant a novel value per side; graph_neighbors must answer it)"
node "$GF/proof-graphfix.mjs" http://localhost:8080 "$ROOT/app.env" helmian 7319
node "$GF/proof-graphfix.mjs" http://localhost:8081 "$ROOT/app-scribe.env" scribe 7321

say "DONE"
echo "Helmian rollback: bash $ROOT/rollback-graphv2.sh (written by deploy-librarian.sh)"
echo "Scribe rollback:  bash $ROOT/rollback-scribe-graphv2.sh"
echo "Schema: migration 008 stays in place on rollback (the widened CHECK is harmless to the"
echo "old code). Reverse it only if a check shows zero 'value' entities — see DEPLOY.md."
