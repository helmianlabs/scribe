#!/bin/sh
# Helmian Scribe container entrypoint.
#
# In SaaS mode, before the server starts:
#   - PROVISION_DATABASE_URL set + PROVISION_ON_BOOT=apply  → provision the
#     database (idempotent: roles, migration chain, verification).
#   - PROVISION_DATABASE_URL set (default)                  → --check-only:
#     verify provisioning; a drifted or unprovisioned database stops the
#     container here, loudly, instead of the app booting against it.
#   - PROVISION_DATABASE_URL unset                          → skip with a loud
#     warning. The server's own boot validation (src/saas/validate.ts) still
#     runs and still refuses an unprovisioned/drifted database or an unsafe
#     configuration — this step is the owner-level half of the same check.
# Single mode: no provisioning concept exists; the server starts directly.
set -e

MODE=$(printf '%s' "${SCRIBE_MODE:-${MEMORY_MODE:-single}}" | tr '[:upper:]' '[:lower:]')
if [ "$MODE" = "saas" ]; then
  if [ -n "$PROVISION_DATABASE_URL" ]; then
    if [ "$PROVISION_ON_BOOT" = "apply" ]; then
      echo "[entrypoint] PROVISION_ON_BOOT=apply — provisioning database before boot…"
      node scripts/provision-saas-db.mjs
    else
      echo "[entrypoint] Verifying database provisioning (check-only)…"
      node scripts/provision-saas-db.mjs --check-only
    fi
  else
    echo "[entrypoint] WARNING: PROVISION_DATABASE_URL is not set — skipping the owner-level provisioning check." >&2
    echo "[entrypoint] The server will still run its own startup validation and refuse to boot on an unprovisioned/drifted database." >&2
  fi
fi
exec "$@"
