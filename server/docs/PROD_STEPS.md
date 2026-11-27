# Production status and remaining steps

> **Historical document.** The status and steps below are the 2026-10-22 state (server v1.2.0, Librarian
> migration 001 not yet applied). They are kept for the record and are **out of date**: the live servers have
> since moved on (graph tables applied, door in front). For what runs now, see
> [`live-snapshots/2026-11-26-hetzner/README.md`](../../live-snapshots/2026-11-26-hetzner/README.md); for the
> current change set and the deploy checklist, see [`docs/LIBRARIAN-AUDIT-FIXES.md`](../../docs/LIBRARIAN-AUDIT-FIXES.md).
> Migration 008 (graph) is `migrations/008_graph.sql`; the backfill now runs `scripts/backfill.ts --dry|--refile`.

## Live now (2026-10-22, ~02:21 MDT)
- Server v1.2.0 (image `claude-memory-mcp:librarian-20261022-082053`) at https://<SERVER_HOST>/mcp.
  Tools: search_memory, save_memory, list_unsorted, explain_filing, move_memory, add_rule.
- Every save_memory is filed by the Librarian (preset D) and the result (shelf, tags, reason) is returned.
  Until migration 001 is applied the filing is computed but NOT recorded (`filing_recorded: false`); saving is unaffected.
- Backup: /opt/backups/claude-memory-mcp-20261022-082053-prelibrarian/ ; rollback image `claude-memory-mcp:prelibrarian-20261022-082053`.
  Rollback: `bash /opt/claude-memory-mcp/rollback-librarian.sh`.

## Step 1 — migration 001 (needs the database owner; no owner credential exists on the box)
1. Neon Console (account you@example.com) -> project **dairyforge** (<NEON_PROJECT_ID>).
2. Safety copy first: Branches -> Create branch from main, name `pre-librarian-20261022` (instant, copy-on-write).
3. SQL Editor -> database **claude_memory** -> role neondb_owner -> paste `migrations/001_librarian.sql` -> Run.
4. Same editor: `INSERT INTO librarian_settings (rulebook, chosen_by) VALUES ('preset-d', 'sam');`
5. Proof (expect 5 rows, then INSERT,SELECT for memory_rw on each):
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_name IN
     ('librarian_settings','memory_categories','librarian_rules','memory_filings','memory_moves');
   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
    WHERE grantee='memory_rw' AND table_name LIKE ANY (ARRAY['memory_%','librarian_%']) GROUP BY 1;
   ```
   Undo: `migrations/001_librarian.down.sql` (drops only Librarian objects).
No server restart is needed: the live server starts recording filings as soon as the tables exist.

## Step 2 — backfill (after step 1)
`ops/backfill-in-container.sh --dry` then `ops/backfill-in-container.sh`. Append-only, re-runnable.
Expected from the read-only full-archive run: ~27.6% unsorted (the full-archive dry-run output is kept privately).

## Step 3 — optional
- `migrations/003_search_index.sql`: trigram index so search_memory stops scanning every row.
- `migrations/002_fix_ro_role.sql`: SECURITY (Sam's call): memory_ro_hz is in neon_superuser AND memory_rw, with CREATEROLE.

## Notes
- After any container restart each connected AI may ask Sam to approve again (one click + passphrase).
- To re-deploy: `bash /opt/claude-memory-mcp/deploy-librarian.sh <new app dir>` (backup, candidate verify on :18081, swap, verify, auto-rollback).
