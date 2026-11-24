# Helmian Scribe (repo: shared-memory-mcp)

Helmian Scribe: one memory every AI you use (Claude, ChatGPT, Grok, Gemini, coding tools) can read and write. Inside it, the sorter is **the Librarian** and AI-to-AI messaging is **Helmian Courier**.

Sam's own instance: one Neon Postgres database (`claude_memory` in Neon project "dairyforge", <NEON_PROJECT_ID>)
that every AI reads and writes through one MCP door: `https://<SERVER_HOST>/mcp`.

This repo holds:

| Path | What |
|---|---|
| `src/librarian/` | **The Librarian**: a deterministic rules engine (no AI). Files every memory by layered triggers: source, shape, content words. |
| `src/librarian/presets.ts` | Setup presets A/B/C/D, each a full rulebook. |
| `src/librarian/plainRules.ts` | Plain-word custom rules ("anything mentioning X goes in Y"). |
| `src/librarian/learn.ts` | Learned triggers from manual moves (still code, not AI). |
| `src/server/librarian-store.ts` | Glue for the MCP server: `fileMessage` (call after save_memory), plus `list_unsorted`, `explain_filing`, `move_memory`, `add_rule`. Append-only (works with `memory_rw`, SELECT + INSERT). |
| `migrations/001_librarian.sql` | Additive schema: filings history, rules, moves, settings, unsorted-tray view. `001_librarian.down.sql` reverses it. |
| `migrations/002_fix_ro_role.sql` | Security fix: take `memory_ro_hz` out of `neon_superuser`. **Sam's call.** |
| `scripts/dry-run.ts` | Read-only classification report (fixture or a READ ONLY DB transaction). |
| `scripts/backfill.ts` | Files existing messages once (append-only). **Sam's call.** |
| `ops/pull-server-source.sh` | Copies the live server source off the box, minus secrets (needs the authorized SSH key). |
| `ops/deploy-librarian.sh` | One-command reversible deploy: backup dir + rollback image tag + health check + auto-rollback. **Sam's call.** |
| `server.src/app/` | The MCP server. `SCRIBE_MODE=single` (default; `MEMORY_MODE` also accepted) is the self-host server; `SCRIBE_MODE=saas` is the hosted multi-tenant server (`src/saas/`). Shared modules: `src/flags/` (scanner, alerts, moderation), `src/courier/` (AI-to-AI messages). |
| `migrations/004_flags.sql`, `005_saas.sql`, `006_courier.sql` | New, additive, each with a `.down.sql`. **None run on production.** 005 is for the hosted database only. |
| `staging/` | Local staging: `docker-compose.yml` (throwaway Postgres + app + webhook receiver) and `smoke.mjs`. |

## Status
- Tests: `npm test` (engine unit tests + the real migration SQL run on an in-process Postgres).
- Never commit `app.env`, connection strings, or the passphrase. `.gitignore` blocks env files.

See `docs/PROD_STEPS.md` for the exact go-live steps.

## Helmian Scribe hosted mode (branch `saas`)

The same server can run as a hosted, multi-tenant product: accounts with email magic-link sign-in, one tenant per account with its own MCP URL (`/t/<slug>/mcp`), OAuth consent by the signed-in account instead of a shared passphrase, row-level security between tenants, free/pro/team plans with limits, export-all and delete-all, Stripe (test mode only), a Flags module (secrets and PII redacted before storage, plus harmful-code and hedging flags with email/webhook alerts), and Helmian Courier so connected AIs can message each other.

- Setup, environment, migrations and what remains: [docs/SAAS.md](docs/SAAS.md)
- Flags API for other services (Helmian Guard): [docs/FLAGS_API.md](docs/FLAGS_API.md)
- Helmian Courier tools: [docs/COURIER.md](docs/COURIER.md)

```bash
cd server.src/app && npm install && npm test
docker compose -f staging/docker-compose.yml up -d --build && node staging/smoke.mjs
```

Self-host mode keeps working as before (`SCRIBE_MODE`/`MEMORY_MODE` unset = `single`). It also gets save-time redaction, `report_flag` / `list_flags` (with `004_flags.sql`) and the Courier tools (with `006_courier.sql`).
