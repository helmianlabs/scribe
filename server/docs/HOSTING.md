# Hosting Helmian Scribe — SaaS mode

How the hosted multi-tenant service runs on a real host: the deployment unit,
the environment it needs, and the upgrade/rollback procedures. Database
provisioning itself (roles, migration chain, verification) is
[PROVISIONING.md](PROVISIONING.md); the customer-facing setup guide is
[GETTING-STARTED.md](GETTING-STARTED.md).

## The shape

```
AI clients (Claude.ai, Gemini, Mistral, Grok…)
        │  https
        ▼
connect.helmian.cloud ──► reverse proxy (Caddy) — TLS terminates here
        │  http, loopback only
        ▼
helmian-scribe-saas container ── 127.0.0.1:8099 ──► app :8080
        │  DATABASE_URL (role: memory_app — RLS binds this role)
        ▼
Postgres 16 (Neon hosted, or the compose database on the same host)
```

- **One container is the deployment unit** (`server.src/app/Dockerfile.saas`,
  driven by `docker-compose.saas.yml` at the repo root). It carries the built
  app, the provisioning script, and the migration files — nothing else is
  needed on the host besides Docker and the proxy.
- **The hostname is `connect.helmian.cloud`** — reserved for this service in
  the production design. Client-side checkers validate MCP hostnames, and the
  OAuth issuer must sit at the host root (RFC 9728/8414 metadata), so the MCP
  endpoint does not move to a path on the marketing domain.
- **Our own stack runs Caddy on the host**, proxying `connect.helmian.cloud`
  to `127.0.0.1:8099`. The compose file binds the app to loopback for exactly
  this. A fresh host without a proxy can use the bundled one instead:
  `docker compose -f docker-compose.saas.yml --profile proxy up -d`
  (config: `ops/Caddyfile.saas` — same block, proxying to the app service).
- **Held MCP calls can stay open for minutes** (governed actions wait for a
  human approval). The proxy must not impose a short request/read timeout on
  this host; Caddy's defaults are fine.

## The image and its entrypoint

Build context is the **repo root** (the migrations live there):

```sh
docker build -f server.src/app/Dockerfile.saas -t helmian-scribe-saas .
```

The entrypoint (`server.src/app/docker-entrypoint.sh`) runs before the server,
in SaaS mode only:

| `PROVISION_DATABASE_URL` | `PROVISION_ON_BOOT` | Entrypoint behavior |
|---|---|---|
| set | `apply` | Provision (idempotent), then boot |
| set | anything else (default) | `--check-only`: verify; drift/unprovisioned = container stops |
| unset | — | Skip with a loud warning; the server's own validation still runs |

Compose sets `PROVISION_ON_BOOT=apply` so a first `up` on a fresh host
provisions its own database; leaving it set is safe (re-runs skip what is
applied and re-verify), or set it to `check-only` to make drift a pure
hard stop.

## Boot validation — no silent degradation

After the entrypoint, the server validates itself before listening
(`src/saas/validate.ts`). **Production posture** = `NODE_ENV=production`
(the image sets it) or `DEPLOY_ENV=production`. In production posture the
server **refuses to boot** when:

- `PUBLIC_URL` is unset (it would silently default to `http://localhost:8080`),
  points at a loopback host, or is not `https://`;
- the mailer resolves to `dev` (no `RESEND_API_KEY` + `MAIL_FROM`) — magic-link
  sign-in email would never be sent;
- Stripe is **half**-configured (a secret key without webhook secret or price
  ids), or a live key is presented without `STRIPE_ALLOW_LIVE=yes-i-mean-live`;
- the database is unprovisioned or **drifted** (the `schema_migrations` ledger
  is missing/unreadable, a migration is unrecorded, or a recorded hash differs
  from the migration file shipped in the image);
- `DATABASE_URL` connects as a SUPERUSER/BYPASSRLS role — row-level security
  would not bind it and tenant isolation would be decorative;
- the seeded `self` tenant is missing, or any data-plane table lacks
  ENABLE+FORCE RLS or its `tenant_isolation` policy.

In **development posture** the same findings are loud log warnings instead of
refusals (localhost `PUBLIC_URL` and the dev mailer stay usable locally — the
dev mailer prints a banner; it is never silent). Stripe fully **off** (no
secret key) is allowed in any posture: billing runs in mock mode and the boot
log says so.

One upgrade note: databases provisioned before this release lack the server's
`SELECT` grant on `schema_migrations`. The boot error says so; one apply-mode
provisioning run adds it.

## Environment

The full annotated list is `server.src/app/.env.example`. The hosting-critical
ones:

| Variable | Meaning |
|---|---|
| `SCRIBE_MODE=saas` | Selects the hosted server (`MEMORY_MODE` also works) |
| `NODE_ENV` / `DEPLOY_ENV` | `production` in either turns on production boot validation |
| `PUBLIC_URL` | Exact public https origin, e.g. `https://connect.helmian.cloud` — issuer, resource URLs, cookie flags, Stripe redirects all derive from it |
| `DATABASE_URL` | Connection **as `memory_app`** (never the owner) |
| `DATABASE_SSL` | On by default; `disable` only for a TLS-less local Postgres |
| `PROVISION_DATABASE_URL` | Owner connection, used only by the entrypoint/provisioning |
| `MEMORY_APP_PASSWORD` | Must match the password inside `DATABASE_URL` (used when provisioning creates the role) |
| `PROVISION_ON_BOOT` | `apply` or `check-only` (default) — see the entrypoint table |
| `RESEND_API_KEY`, `MAIL_FROM` | Real sign-in email; both required in production |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | Billing; all-or-nothing. Test keys until the separate live-billing decision |
| `MIGRATIONS_DIR` | Set by the image (`/migrations`); override only outside the image |

## First boot (fresh host)

```sh
cp server.src/app/.env.example .env   # fill in real values; never commit it
docker compose -f docker-compose.saas.yml up -d --build
curl http://127.0.0.1:8099/healthz    # → ok
docker compose -f docker-compose.saas.yml logs app   # expect "startup validation: OK (posture: production)"
```

For a local smoke run instead (no Resend, no domain): set `NODE_ENV=` (empty),
`PUBLIC_URL=http://localhost:8099`, and keep the dev mailer — boot validation
warns loudly and lets it run.

## Upgrade procedure

1. Build the new image (`up -d --build`, or build + tag on the host).
2. Optional pre-flight: from the new tree, run the provisioning script
   against the production database with the owner URL —
   `node scripts/provision-saas-db.mjs --check-only`. Any drift it reports
   must be reconciled **before** the swap.
3. `docker compose -f docker-compose.saas.yml up -d` — the entrypoint
   re-verifies (or applies, per the switch) and the server re-validates
   before it accepts traffic.
4. Smoke: `curl http://127.0.0.1:8099/healthz`, one magic-link sign-in, one
   authenticated MCP `tools/list`.

## Rollback

- **Code:** redeploy the previous image tag. Schema changes are additive and
  every migration is idempotent, so an older image boots against a newer
  schema; the `schema_migrations` ledger only ever gains rows.
- **Never edit an applied migration file** — that is exactly the drift the
  boot check refuses. A bad migration is fixed by a new migration, or by
  reconciling the ledger by hand as a deliberate operator act.
- **Database:** the compose database lives in the `scribe-db` volume; back it
  up before upgrades (`pg_dump` as the owner). Hosted Postgres (Neon) has its
  own branching/backup story — use it.

## Still gated elsewhere

This unit is hostable today, but the production flip itself is a separate,
explicit decision (see the hosting report): SaaS discovery strictness for the
strictest client checkers, the Stripe proof against a real test account, and
the promotion of this branch line toward `main` all land as their own steps.
