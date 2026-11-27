# Provisioning a fresh SaaS database — from empty Postgres to a booted server

The hosted product (Helmian Scribe, `SCRIBE_MODE=saas`) runs against its OWN
database — never Sam's self-host `claude_memory` archive. This is the one
documented path from an **empty** PostgreSQL database to a booted SaaS server
that answers health and MCP checks. It replaces the old out-of-band steps
(create `memory_app` by hand, run migrations in the right order by memory).

## What you need

- PostgreSQL **15 or newer** (migration 005 rebuilds views with
  `security_invoker`, a PG15 feature). A managed instance (e.g. Neon) or a
  local server both work — the provisioning is identical.
- An **owner-level** connection string for the new, empty database
  (`PROVISION_DATABASE_URL`). Hosting the instance is a separate decision;
  this runbook only provisions whichever empty database you point it at.
- Node.js 20+ and this repo.

## Step 1 — Create the empty database

On a local server:

```sql
CREATE DATABASE scribe;
```

On a managed host: create the project/database in its console and copy the
owner connection string. Nothing else — no tables, no roles. The next step
creates everything, including the roles:

| Role | Login | Why |
|---|---|---|
| `memory_rw` | no | self-host write role; migrations 001/004/006 grant to it |
| `memory_ro_hz` | no | self-host read role; same |
| `memory_app` | **yes** | the SaaS server's role: `NOSUPERUSER NOBYPASSRLS`, so the row-level security from 005/006 actually binds it |

## Step 2 — Run the provisioning script

From `server.src/app/`:

```bash
PROVISION_DATABASE_URL='postgres://<owner>:<password>@<host>:5432/scribe' \
MEMORY_APP_PASSWORD='<a strong password — this becomes the server DB password>' \
node scripts/provision-saas-db.mjs
```

The script:

1. Refuses to run as `memory_app`, on PostgreSQL < 15, or against a
   pre-existing `memory_app` that is a superuser / BYPASSRLS (RLS would be
   decorative — it fails loudly instead of "fixing" it silently).
2. Creates any missing roles (an existing `memory_app` keeps its password;
   `MEMORY_APP_PASSWORD` is only used when the role is created).
3. Applies the migration chain in order, recording each file's SHA-256 in a
   `schema_migrations` ledger table:
   `000_base` → `001_librarian` → `003_search_index` → `004_flags` →
   `005_saas` → `006_courier` → `007_stripe_events_status` →
   `009_plans_personal` → `010_paddle_seats` → `011_recall_quality` →
   `012_memory_embeddings`.
   A ledger entry whose hash no longer matches the file on disk is **drift**:
   the script stops. Re-running is safe — applied migrations are skipped and
   every migration is idempotent.
4. Verifies the result and exits non-zero listing every problem: all 29
   tables and 3 views present, RLS enabled + forced with a `tenant_isolation`
   policy on the 16 data-plane tables, `memory_app` grants, the seeded
   `self` tenant, the `pg_trgm` search index and the `messages_text_fts`
   full-text index.

`002_fix_ro_role.sql` is **not** in the chain: it is a one-off security fix
for Sam's live database (it references Neon-specific roles) and stays his
separate call.

Re-verify any time, changing nothing:

```bash
PROVISION_DATABASE_URL='…' node scripts/provision-saas-db.mjs --check-only
```

## Step 3 — Configure and build the server

```bash
cd server.src/app
cp .env.example .env   # then fill it in — at minimum DATABASE_URL + PUBLIC_URL
npm ci
npm run build
```

Two settings bite silently if wrong (both inherited traps, now documented in
`.env.example`): `DATABASE_URL` must be the **`memory_app`** connection
(provisioning's owner URL must never be used by the server), and `PUBLIC_URL`
must be the exact public https origin — the OAuth issuer, per-tenant MCP
resource URLs, cookie flags and Stripe redirects all derive from it, and it
defaults to `http://localhost:8080` with no startup error.

For a local/plain Postgres without TLS also set `DATABASE_SSL=disable`
(the default is SSL on, which hosted Postgres such as Neon expects).

## Step 4 — Boot and check

```bash
set -a; . ./.env; set +a
node dist/index.js
# helmian-scribe (saas) listening on :8080
```

Checks (replace the origin with your `PUBLIC_URL`):

```bash
curl https://scribe.example.com/healthz
# ok

curl https://scribe.example.com/
# {"name":"helmian-scribe","product":"Helmian Scribe","mode":"saas","status":"ok",…}

curl https://scribe.example.com/.well-known/oauth-protected-resource/t/self/mcp
# OAuth protected-resource metadata JSON for the seeded self tenant

curl -X POST https://scribe.example.com/t/self/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# 401 — expected: the MCP endpoint is live and refuses unauthenticated calls.
# A real tools/list + tools/call happens after sign-up (magic link), account
# consent (DCR + PKCE), per docs/SAAS.md; the test suite in
# server.src/app/test/ performs that whole dance against a throwaway database.
```

## Notes

- **Existing databases**: running the chain against a database that already
  has the base tables (e.g. an imported archive) is safe — every step is
  `IF NOT EXISTS`-style idempotent, existing rows become tenant `self` in 005,
  and the ledger starts recording from the first provisioning run.
- **Rollback**: each migration has a `.down.sql` sibling (004/005/006;
  001 as well). 000's rollback is dropping the three base tables — only on a
  database that has not entered service.
- **Not covered here** (separate bites): hosting the server itself
  (process/container/reverse-proxy/TLS), pointing a domain at it, Stripe
  account setup (`docs/SAAS.md` § billing), and a verified Resend sending
  domain for production sign-in email.
