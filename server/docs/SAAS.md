# Helmian Scribe — hosted (SaaS) mode, phase 1

Helmian Scribe is one memory every AI you use (Claude, ChatGPT, Grok, Gemini, coding tools) can read and write. Inside it, the sorter is **the Librarian** and AI-to-AI messaging is **Helmian Courier** (the Courier).

Branch `saas`. One server binary, two modes, chosen by `SCRIBE_MODE` (the older `MEMORY_MODE` still works):

| Mode | What it is | Consent | Data |
|---|---|---|---|
| `single` (default) | Sam's self-host server, unchanged behavior | shared passphrase | one archive (`tenant_id` = `self` where it exists) |
| `saas` | hosted, many customers | the signed-in account (email magic link) | one tenant per account, isolated by row-level security |

Notebook names inside a memory keep the `Shared Memory — <category>` prefix on purpose: Sam's existing archive and the Librarian's notebook rules match on it. Renaming it would be a data migration, not a label change.

Nothing on this branch has been deployed or run against Sam's production database.

## What phase 1 contains

**Accounts and tenants** (`server.src/app/src/saas/accounts.ts`)
- Email magic-link sign-in (`/login` → `/auth/start` → email → `/auth/verify` → button → session cookie). Links are single use, expire in 15 min, are rate-limited per email and per IP, and are stored only as SHA-256 hashes. The verify step needs a button press so email link scanners can't burn the link.
- First sign-in creates the user, a personal tenant, an owner membership, and Librarian preset D.
- Session cookie: `HttpOnly; SameSite=Lax; Secure` (on https). State-changing API calls also require same-origin + `X-Requested-With`.
- Mail: `MAIL_PROVIDER=resend` (needs `RESEND_API_KEY` + `MAIL_FROM` on a verified domain) or `dev` (writes to `MAIL_OUTBOX_FILE`, sends nothing). Default is `dev` unless both Resend vars are set.

**Per-tenant MCP URL and OAuth** (`saas/oauth.ts`, `saas/app.ts`)
- Each tenant gets `PUBLIC_URL/t/<slug>/mcp` (10-char random slug) with its own protected-resource metadata at `/.well-known/oauth-protected-resource/t/<slug>/mcp`. The generic `/mcp` also works; the tenant then comes from the token.
- OAuth 2.1 + PKCE + DCR as before, but clients, pending consents, codes and tokens live in Postgres (hashed). Restarts lose nothing.
- Consent page: if not signed in it shows the email form and comes back; if signed in it shows "Signed in as …" and Approve/Deny. A connection request for `/t/<slug>/mcp` can only be approved by a member of that tenant. Codes and tokens are bound to tenant + user + resource; a token for tenant A gets 403 on tenant B's URL.
- Refresh tokens rotate; the old one dies.

**Tenant isolation, two walls**
1. Every query filters by `tenant_id` explicitly.
2. `005_saas.sql` turns on `FORCE ROW LEVEL SECURITY` on every data table, with policy `tenant_id = current_setting('app.tenant_id', true)`. The app runs each tenant's work in a transaction that sets that value. No value set ⇒ no rows. The app role `memory_app` is `NOSUPERUSER NOBYPASSRLS`. Views are `security_invoker`. Tested: the app role can't read or insert another tenant's rows even with a query that forgets the filter.

**Plans and limits** (`saas/plans.ts`, owner-approved 2026-11-26)

| | Free | Personal | Team |
|---|---|---|---|
| Price | $0 | $8/month or $80/year | $15 per seat per month |
| Memories | 1,000 | unlimited | unlimited |
| Storage (memory text) | 50 MB | 5 GB | 5 GB per account (placeholder) |
| Typed rules (`add_rule`) | 3 | unlimited | unlimited |
| MCP connectors, Librarian filing with why-trail, search/recall, export | yes | yes | yes |
| Learning from your moves | no | yes | yes |
| People / places / companies shelves | no | yes | yes |
| Knowledge graph | no | yes (entitlement flag; see note) | yes |
| ChatGPT / Claude history import | no | yes | yes |
| Daily backups | no | yes (entitlement flag; see note) | yes |
| API keys | 1 | 5 | 25 (placeholder) |
| Daily calls | 500 | 10,000 | 10,000 per seat |
| Members | 1 | 1 | one per seat |

Only the Team price was specified. Team's storage and API-key numbers are placeholders. Team's seat count comes from the subscription quantity (migration 010) and sets its member allowance and daily call cap; there is no invite flow yet, so seats are an allowance, not assigned people. The hosted server does not build the knowledge graph yet and the repo has no backup job, so "graph" and "daily backups" are entitlements recorded on the plan, not running features.

Limits are enforced in `saas/memory.ts` (memory count, stored bytes via the per-tenant `tenant_storage` counter from migration 009, typed rules, learning and shelves), `saas/apikeys.ts` and `saas/app.ts` (import). Hitting a limit returns a plain-language tool error (MCP) or HTTP 402 with `limit: memories|bytes|rules|api_keys|feature` (API); search, read and export keep working. Calls are also capped per tenant per UTC day, in the database (`usage_daily`, one guarded upsert, so the cap holds across restarts and replicas and a refused call is not counted): **Free 500, Personal 10,000, Team 10,000 per seat** (constants `CALLS_PER_DAY` in `saas/plans.ts`; these are chosen numbers, not part of the approved tiers). Every MCP tool call, flags-API call with an API key and history import counts; dashboard-session reads and export do not. At the cap, MCP gets a plain tool error and the API gets HTTP 429 with `Retry-After` and `limit: calls`. `PLAN_LIMITS_JSON` overrides `maxMemories`, `maxBytes` and `maxTypedRules` per plan per environment. The retired plan id `pro` reads as `personal`; migration 009 renames stored rows. The Stripe Price is the source of truth for money, `plans.ts` for limits.

**Export and delete**
- `GET /api/export` → one JSON file with every row of the tenant (memories, notebooks, filings, rules, flags, Courier messages, usage).
- `POST /api/delete-all {"confirm":"DELETE"}` (owner only) → deletes memories, filings, moves, custom rules, flags and Courier messages. Keeps the account, billing, chosen rulebook and usage meter. Add `"revoke_connections": true` to also revoke every OAuth token.

**Payment provider** (`PAYMENT_PROVIDER=stripe|paddle`, default stripe). Checkout, the billing portal and seat changes go through the selected provider; both webhook routes stay mounted and each answers 503 until its own secret is set. Paddle (`saas/paddle.ts`, sandbox by default, merchant of record) is described in [PADDLE-GO-LIVE.md](PADDLE-GO-LIVE.md), including the steps only the account owner can do. `POST /api/billing/seats {"seats":n}` changes a Team subscription's seat quantity; `POST /api/billing/checkout` takes `seats` for Team (1 to 100).

**Stripe (test mode only)** (`saas/billing.ts`)
- `POST /api/billing/checkout {"plan":"personal"|"team","interval":"month"|"year"}` (yearly is Personal only) → Checkout Session (subscription) with `tenant_id` in `client_reference_id` and metadata; creates the Stripe customer on first use.
- `POST /api/billing/portal` → Customer Portal link.
- `POST /webhooks/stripe` → raw body, verified with `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed`, `customer.subscription.created|updated|deleted`; idempotent by event id (`stripe_events`). Without a secret it answers 503 and changes nothing.
- Safety: a live key (`sk_live_`/`rk_live_`) is refused at startup, and live-mode events are refused, unless `STRIPE_ALLOW_LIVE=yes-i-mean-live`. With no key at all, checkout/portal return a clearly-labelled mock page.
- `scripts/stripe-create-products.mjs`: dry run by default; `--apply` with a test key creates/reuses the Personal (monthly and yearly) and Team (monthly) prices (by `lookup_key`) and prints the `STRIPE_PRICE_*` lines. Not run against any account.

**Flags** — see [FLAGS_API.md](FLAGS_API.md). **Helmian Courier** — see [COURIER.md](COURIER.md).

**Mailbox status (the doorbell feed)** — `GET /mailbox-status` returns `{ generated_at, mailboxes }` for the caller's tenant only. A mailbox is a Courier recipient agent; `count` is that agent's unread mail (direct mail plus broadcasts from other agents), and `newest` carries the newest waiting message's id, sender, time and actual Courier subject. Auth is a bearer credential whose tenant the server verifies — an MCP OAuth access token with `memory.read`, or a service API key created with the `mailbox.read` scope. There is no shared status token and no tenant parameter in SaaS mode.

**Dashboard** (`/dashboard`): MCP address, plan + usage, upgrade / manage billing, recent flags, alert settings, API keys, export, delete-all. Plain server-rendered page + one static script (CSP `script-src 'self'`).

## Migrations (new files only, none run on production)

| File | For | Notes |
|---|---|---|
| `004_flags.sql` | both modes | `flags` table; self-host roles get SELECT+INSERT only |
| `005_saas.sql` | **SaaS database only** | control tables, `tenant_id` on every data table (existing rows → `self`), RLS, rebuilt views, grants for `memory_app`. Do not apply to Sam's `claude_memory`: with FORCE RLS the self-host server would see an empty archive. |
| `006_courier.sql` | both modes | Helmian Courier tables; adds RLS when `tenants` exists |
| `007_stripe_events_status.sql` | **SaaS database only** | `stripe_events` apply tracking (`apply_status`/`apply_error`/`applied_at`/`attempts`) so a webhook whose apply fails stays retryable instead of being swallowed as a duplicate |
| `009_plans_personal.sql` | **SaaS database only** | plan id `pro` → `personal` (CHECK widened), `tenant_storage` byte counter with RLS (backfilled from existing messages), grants for `memory_app`. Down restores `pro` and drops the counter. (008 is the graph migration; it is not in the SaaS chain.) |
| `010_paddle_seats.sql` | **SaaS database only** | `tenants.seats`, `payment_provider`, `paddle_customer_id`, `paddle_subscription_id`, `paddle_event_at`; `paddle_events` webhook ledger (same apply tracking as `stripe_events`). Additive. |
| `011_recall_quality.sql` | **SaaS database only** | Recall quality: expression GIN full-text index `messages_text_fts` (ranked search), `memory_supersessions` (a correction replaces an older memory; nothing is edited or deleted, history kept), `memory_recalls` (read/confirm log used to strengthen recalled memories and let unused ones fade in ranking). Both tables tenant-scoped with FORCE RLS; `memory_app` gets SELECT/INSERT/DELETE. Additive. |
| `012_memory_embeddings.sql` | **SaaS database only** | `memory_embeddings`: passage vectors (REAL[], no extension needed) for meaning-based search. Filled and used only when the server runs with `SCRIBE_EMBEDDINGS=local`; otherwise empty and search is full-text/literal. FORCE RLS, `memory_app` SELECT/INSERT/DELETE. Additive. |

Each has a `.down.sql`; all are idempotent. Order for a fresh SaaS database: base tables → 001 → 004 → 005 → 006 → 007 → 009 → 010 → 011 → 012.

Moving Sam's archive into the hosted service later = export from `claude_memory`, import as tenant `self` (or a new tenant). Not built yet.

## Running it

```bash
cd server.src/app && npm install && npm test          # 36 tests: scanner, alerts, OAuth, RLS, billing, limits, Courier, migrations
# staging: throwaway Postgres + the app + a webhook receiver
docker compose -f staging/docker-compose.yml up -d --build
node staging/smoke.mjs                                # sign up → connect → save → search → flag + webhook → Courier → checkout → webhook → export → delete → RLS
docker compose -f staging/docker-compose.yml down -v
```
On machines without Docker bridge networking add `-f staging/docker-compose.hostnet.yml` and run the smoke with `HOSTNET=1`. To exercise real Stripe test checkout, export `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PRICE_PRO`, `STRIPE_TEST_PRICE_TEAM` before `up`.

### SaaS environment

| Var | Required | Meaning |
|---|---|---|
| `SCRIBE_MODE=saas` (or `MEMORY_MODE=saas`) | yes | selects this mode |
| `SCRIBE_EMBEDDINGS=local` | no | meaning-based search with a small local model (no paid key). Needs `@huggingface/transformers@4.3.2`, which is not a dependency: `npm install --no-save @huggingface/transformers@4.3.2`, or Docker `--build-arg WITH_EMBEDDINGS=1` and migration 012. The model downloads on first use (about 25 MB). Off by default. |
| `SCRIBE_EMBEDDINGS_MODE` | no | `fallback` (default: meaning-based results only when words find fewer than 3 memories) or `blend` (always fused with word ranking). |
| `SCRIBE_EMBED_MODEL` | no | local model id (default `Xenova/all-MiniLM-L6-v2`). |
| `DATABASE_URL` | yes | connection as `memory_app` (not the owner) |
| `PUBLIC_URL` | yes | https origin; issuer + resource URLs derive from it |
| `DATABASE_SSL=disable` | local only | default is SSL on |
| `RESEND_API_KEY`, `MAIL_FROM` | for real email | otherwise dev outbox |
| `PAYMENT_PROVIDER` | optional | `stripe` (default) or `paddle` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_PERSONAL_YEARLY`, `STRIPE_PRICE_TEAM` | for Stripe billing | test keys only |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PERSONAL`, `PADDLE_PRICE_PERSONAL_YEARLY`, `PADDLE_PRICE_TEAM` | for Paddle billing | sandbox only until the live decision |
| `ALERT_WEBHOOK_SECRET` | for alert webhooks | HMAC signing secret |
| `OPENAI_API_KEY` | optional | turns on moderation (redacted text only) |
| `PLAN_LIMITS_JSON`, `SESSION_TTL_DAYS`, `MAGIC_LINK_TTL_MIN`, `FLAGS_SAFE_INSTALL_HOSTS` | optional | tuning |

## What remains (not in phase 1)

- **Needs Sam:** a domain for Helmian Scribe; a verified Resend sending domain (`MAIL_FROM`); a Stripe **test** secret key and webhook secret (then run the products script); final prices; a new Neon project/branch for the hosted database (provisioning and the `memory_app` password are mechanized — docs/PROVISIONING.md; the deployment unit and boot validation are docs/HOSTING.md); whether/when to move his archive in.
- **Guard extension wiring** (owned by the Guard bot): extension → `POST /api/flags` with a tenant API key, poll `GET /api/flags` or receive the alert webhook. The contract is in FLAGS_API.md.
- **Executive Guard signed approvals** (owned by the Guard bot): not built here.
- Team invites (members beyond the owner), tenant switcher UI, account deletion (vs. delete-all), importers (Claude/ChatGPT/Grok history), Librarian preset picker in the dashboard (API exists: `POST /api/librarian/preset`), per-tenant backups, Postgres full-text search for large tenants, rate limiting shared across replicas (current limiter is per process), alert delivery outside the request transaction + retries, admin console, Stripe Tax decision (Paddle is the chosen merchant of record for Scribe Memory; terms, privacy, refunds and pricing pages are at /terms, /privacy, /refunds and /pricing).
