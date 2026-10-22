# Go-live steps (each needs Sam's yes)

Nothing here has been run against production.

0. **Get the source into the repo** (step one of spec 2.9): from Sam's PC or any machine with the
   authorized `hetzner-runner` key: `ops/pull-server-source.sh`, review, commit `server.src/`.
1. **Pick the preset** (A by project, B by kind of work, C work/personal then project, D all-round default).
   Default if he does not pick: D.
2. **Migration** — Neon SQL editor, project dairyforge, database `claude_memory`, as `neondb_owner`:
   paste `migrations/001_librarian.sql`. Proof query:
   `SELECT count(*) FROM information_schema.tables WHERE table_name IN ('memory_filings','librarian_rules','memory_moves','librarian_settings','memory_categories');` -> 5.
   Then record the preset: `INSERT INTO librarian_settings (rulebook, chosen_by) VALUES ('preset-d','sam');`
   Undo: `migrations/001_librarian.down.sql` (drops only Librarian objects; memory rows untouched).
3. **Dry run on real data** (read-only): `DATABASE_URL=<read url> npm run dry-run -- --sample 5000 --preset D`.
   Review unsorted % and the top rules; tune words in `src/librarian/vocab.ts` if needed.
4. **Patch + deploy** the server (`docs/SERVER_PATCH.md`), then on the box: `bash ops/deploy-librarian.sh`.
   It backs up `/opt/claude-memory-mcp` to `/opt/backups/claude-memory-mcp-<stamp>-prelibrarian/`, tags the running
   image `claude-memory-mcp:prelibrarian-<stamp>`, swaps, health-checks, and rolls back by itself on failure.
   Manual rollback: `bash /opt/claude-memory-mcp/rollback-librarian.sh`. Older rollback: `claude-memory-mcp:prewrite-20261021`.
   After a restart each connected AI may ask Sam to re-approve (one click + passphrase).
5. **Backfill** existing ~49k messages: `DATABASE_WRITE_URL=... npx tsx scripts/backfill.ts --preset D` (append-only; re-runnable).
6. **Security fix** (separate decision): `migrations/002_fix_ro_role.sql` takes `memory_ro_hz` out of `neon_superuser`.
7. **Proof**: save a memory from one AI, check `explain_filing` from another; `list_unsorted` shows the tray.
