import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { BASE, sql } from "./helpers.ts";

const tables = async (db: PGlite) => (await db.query<any>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);

test("004/005/006 are idempotent and reversible; memory rows survive", async () => {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(sql("001_librarian.sql"));
  const before = await tables(db);
  for (let i = 0; i < 2; i++) { await db.exec(sql("004_flags.sql")); await db.exec(sql("005_saas.sql")); await db.exec(sql("006_courier.sql")); }
  const after = await tables(db);
  for (const t of ["flags", "tenants", "users", "memberships", "sessions", "magic_links", "oauth_clients", "oauth_codes", "oauth_tokens", "api_keys", "usage_daily", "stripe_events", "agent_messages", "agent_message_reads", "agent_directory"]) assert.ok(after.includes(t), t);
  assert.equal((await db.query<any>("SELECT tenant_id FROM messages")).rows[0].tenant_id, "self", "existing rows become tenant 'self'");
  const rls = await db.query<any>("SELECT relname FROM pg_class WHERE relrowsecurity AND relforcerowsecurity ORDER BY 1");
  assert.deepEqual(rls.rows.map((r) => r.relname), ["agent_directory", "agent_message_reads", "agent_messages", "conversations", "flags", "librarian_rules", "librarian_settings", "memory_filings", "memory_moves", "messages", "projects", "usage_daily"]);
  await db.exec(sql("006_courier.down.sql"));
  await db.exec(sql("005_saas.down.sql"));
  await db.exec(sql("004_flags.down.sql"));
  assert.deepEqual(await tables(db), before);
  assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM messages")).rows[0].n, 1);
  assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM memory_unsorted")).rows[0].n, 1, "001 views restored");
});

test("self-host grants stay append-only on the new tables", async () => {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(sql("001_librarian.sql"));
  await db.exec(sql("004_flags.sql"));
  await db.exec(sql("006_courier.sql"));
  const g = await db.query<any>("SELECT DISTINCT privilege_type FROM information_schema.role_table_grants WHERE grantee='memory_rw' AND table_name IN ('flags','agent_messages','agent_message_reads','agent_directory') ORDER BY 1");
  assert.deepEqual(g.rows.map((r) => r.privilege_type), ["INSERT", "SELECT"]);
});
