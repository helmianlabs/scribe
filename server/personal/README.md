# Personal (single-user) Scribe memory server

This folder is the source of the owner's own memory server, the one that runs on the production host as the
`claude-memory-mcp-scribe` container (built on the host from `/opt/scribe-build/graph-src`) over the single-user
`claude_memory` database. It is **not** the hosted multi-tenant service in `server/server.src/app`.

**Origin.** The first commit that adds this folder is a verbatim copy of `/opt/scribe-build/graph-src` as it was on
2026-11-27 after the `scribe:unread-20261127` deploy (the 2026-11-26 snapshot in
`live-snapshots/2026-11-26-hetzner/memory-server-scribe` plus that day's `/mailbox/unread` change). Copied read-only;
no `node_modules`, `dist`, env files or `*.bak*` files. Until now this code lived only on the host.

Build: `npm ci && npm run build` (or the `Dockerfile`). Tests: `npm test` (in-process Postgres, no network).

## Recall quality (ported from the hosted server, PR #5 / #6)

`search_memory` now ranks by relevance instead of newest-first substring:

- **Ranked search** (`src/recall.ts`): Postgres full-text search (english stemming, `ts_rank`), an exact phrase ranks
  higher, the old case-insensitive substring match stays as a lower tier so nothing the old search found disappears.
  Snippets are centred on the matching words. Results are cut to a token budget (`max_tokens`, default 2000).
- **Novelty filter + sentence fix**: a result whose matching sentences were already shown is folded into the first one
  (`similar_hidden`), so repeated notes cannot crowd out the memory that has something new to say. Decimals such as
  `12.5%` no longer split a sentence.
- **Meaning-based search** (`src/embeddings.ts`): **OFF by default.** See below.

All of it is read-only SQL on the existing read pool (`memory_ro_hz`). The result fields keep the old names
(`id`, `conversation_name`, `sender`, `created_at`, `snippet`) and add `whole`, `score`, `similar_hidden`.

### Switches (environment)

| Variable | Default | Effect |
|---|---|---|
| `SCRIBE_SEARCH` | `ranked` | `substring` = the old newest-first ILIKE search, unchanged (instant switch-back, no rebuild). |
| `SCRIBE_EMBEDDINGS` | unset (off) | `local` = meaning-based search with a small local model. Also needs the package (`--build-arg WITH_EMBEDDINGS=1`, ~750 MB image growth) and migration `p002`. |
| `SCRIBE_EMBEDDINGS_MODE` | `fallback` | `fallback`: meaning search only when the words find fewer than 3 memories. `blend`: always fused. |

### Migrations (single-user, optional, additive; written for `claude_memory`, NOT applied)

| File | Needed for | Notes |
|---|---|---|
| `migrations/p001_fts_index.sql` | speed only | GIN full-text index, built `CONCURRENTLY` (no write lock). Ranked search works without it, just slower on a big archive. Down: `p001_fts_index.down.sql`. |
| `migrations/p002_memory_embeddings.sql` | meaning search only | One new table `memory_embeddings` (no tenant column, no RLS), SELECT to `memory_ro_hz`, INSERT to `memory_rw`. Down: drops only that table. |

**Never apply the hosted migrations `005`, `011` or `012` (in `server/migrations`) to `claude_memory`.** They add
tenants and row-level security; with them the personal server would see an empty archive.

`scripts/backfill-embeddings.ts` embeds existing memories (insert-only, resumable). Only useful with meaning search on.
