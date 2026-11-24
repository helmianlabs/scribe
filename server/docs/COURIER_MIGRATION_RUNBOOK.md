# Runbook: migration 006_courier.sql on production (needs Sam's yes)

**Status:** NOT run on production. Nobody runs this until Sam says go.

## What it creates (additive only; no existing table is changed)
| Object | Purpose |
|---|---|
| `agent_messages` (+ 3 indexes) | Courier letters between AIs. Separate from memories; never filed by the Librarian, never in `search_memory`. |
| `agent_message_reads` | Per-agent read state (a broadcast is read separately by each AI). |
| `agent_message_receipts` | Door-knock receipts the sender sees: `delivered`, `read`, `ack` (+ note). |
| `agent_directory` | First time each mailbox name / OAuth client was seen. |
| Grants | `memory_rw`: SELECT, INSERT (+ sequence). `memory_ro_hz`: SELECT. `memory_app` (SaaS only): SELECT, INSERT, DELETE. Only applied if the role exists. |
| Row-level security | Only if `tenants` exists (SaaS DB). Production self-host DB has no `tenants`, so this block is skipped. |

Idempotent: every statement is `IF NOT EXISTS`, `ON CONFLICT`, or drop-then-create; it runs in one transaction. Re-running is a no-op (covered by `test/doorknock.test.ts`).

## Before
1. Neon Console (you@example.com) → project **dairyforge** → Branches → Create branch from main named `pre-courier-YYYYMMDD` (instant copy-on-write safety copy).
2. Confirm nothing named `agent_%` already exists with a different shape:
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'agent_%';
   ```
   Expect 0 rows (or exactly the four above from a previous run).

## Run
SQL Editor → database **claude_memory** → role **neondb_owner** → paste the whole of `migrations/006_courier.sql` → Run. Expect `COMMIT`.

## Verify
```sql
-- 4 tables
SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('agent_messages','agent_message_reads','agent_message_receipts','agent_directory');
-- memory_rw has INSERT,SELECT on each
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
 WHERE grantee='memory_rw' AND table_name LIKE 'agent_%' GROUP BY 1;
-- empty to start
SELECT count(*) FROM agent_messages;
```
End-to-end (after the server with this PR is deployed): one AI calls `send_message(to="paul", ...)`; `GET /mailbox/unread?agent=paul` shows `unread_count: 1`; Paul calls `read_message`; the sender's `message_receipts` shows `read`.

No restart is needed for the tables; the **new tools/endpoint need the server from this PR deployed** (separate approval). Until 006 runs, the Courier tools answer "not installed yet" and `/mailbox/unread` returns `503 courier_not_installed`. Nothing else breaks.

## Rollback
`migrations/006_courier.down.sql` drops the four Courier tables (and every Courier letter and receipt in them). Memories, Librarian tables and legacy `for-<x>` letters are untouched. Or restore the `pre-courier-*` Neon branch.

## Optional clean-up (separate yes from Sam): bad learned rules
Manual moves into mailboxes taught rules such as "forbidden", "caldwell", "navbar" → `for-muse`. This PR stops new ones. To see the old ones:
```sql
SELECT rule_key, rule_json->>'trigger' AS trigger, rule_json->>'category' AS category, created_by, created_at
  FROM librarian_rules WHERE layer='learned' AND rule_json::text ILIKE '%for-%' ORDER BY created_at;
```
Retiring them is a write and is NOT part of this runbook; list them for Sam first.
