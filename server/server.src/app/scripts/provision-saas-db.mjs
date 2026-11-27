#!/usr/bin/env node
// Provisions a FRESH database for Helmian Scribe SaaS mode (SCRIBE_MODE=saas):
// creates the roles the migrations expect, applies the migration chain in order,
// and verifies the result. Idempotent: re-running skips what is already applied
// (tracked in the schema_migrations ledger, by content hash) and re-verifies.
//
//   PROVISION_DATABASE_URL=postgres://<owner>:<pw>@<host>:5432/<db> \
//   MEMORY_APP_PASSWORD=<strong password for the memory_app role> \
//     node scripts/provision-saas-db.mjs
//
//   node scripts/provision-saas-db.mjs --check-only   # verify only, change nothing
//
// PROVISION_DATABASE_URL must be an OWNER-level connection (it creates roles and
// owns the tables). The server itself must NEVER use it: the server connects as
// memory_app (DATABASE_URL), a NOSUPERUSER / NOBYPASSRLS login role, so the
// row-level security switched on by 005/006 actually binds it.
//
// The chain is: 000_base -> 001_librarian -> 003_search_index -> 004_flags ->
// 005_saas -> 006_courier -> 007_stripe_events_status -> 009_plans_personal -> 010_paddle_seats -> 011_recall_quality.
// 002_fix_ro_role.sql is deliberately NOT in the chain:
// it is a one-off fix for Sam's live claude_memory database (it references
// Neon-specific roles) and is Sam's call, not a provisioning step.
//
// Exit code is 0 only when every migration is applied AND every verification
// check passes. Any drift (a migration file whose hash differs from the ledger),
// any unsafe pre-existing role, or any missing object/policy/grant is a loud
// failure, never a silent skip. See docs/PROVISIONING.md for the full runbook.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const checkOnly = process.argv.includes("--check-only");
const MIGRATIONS = [
  "000_base.sql",
  "001_librarian.sql",
  "003_search_index.sql", // optional trigram search index; part of the standard chain
  "004_flags.sql",
  "005_saas.sql",
  "006_courier.sql",
  "007_stripe_events_status.sql",
  "009_plans_personal.sql",
  "010_paddle_seats.sql",
  "011_recall_quality.sql",
];
const MIG_DIR = new URL("../../../migrations/", import.meta.url);

// Tables a fully provisioned SaaS database must have (base + 001 + control plane + 004 + 006).
const EXPECTED_TABLES = [
  "projects", "conversations", "messages",
  "librarian_settings", "memory_categories", "librarian_rules", "memory_filings", "memory_moves",
  "tenants", "users", "memberships", "magic_links", "sessions", "oauth_clients", "oauth_pending",
  "oauth_codes", "oauth_tokens", "api_keys", "stripe_events", "paddle_events", "usage_daily", "tenant_storage",
  "flags", "agent_messages", "agent_message_reads", "agent_directory",
  "memory_supersessions", "memory_recalls",
];
const EXPECTED_VIEWS = ["memory_current_filing", "memory_unsorted", "librarian_active_rules"];
// Tables 005/006 put under FORCE row-level security with a tenant_isolation policy.
const RLS_TABLES = [
  "conversations", "messages", "projects", "librarian_settings", "librarian_rules",
  "memory_filings", "memory_moves", "flags", "usage_daily", "tenant_storage",
  "agent_messages", "agent_message_reads", "agent_directory",
  "memory_supersessions", "memory_recalls",
];

const fail = (msg) => { console.error(`\nPROVISIONING FAILED: ${msg}`); process.exit(1); };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const quoteLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const url = process.env.PROVISION_DATABASE_URL || "";
if (!url) fail("Set PROVISION_DATABASE_URL to an OWNER-level connection string for the empty database.");
const appPassword = process.env.MEMORY_APP_PASSWORD || "";

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const me = (await client.query("SELECT current_user AS u, current_database() AS d, version() AS v, current_setting('server_version_num')::int AS vn")).rows[0];
  console.log(`Connected as ${me.u} to database "${me.d}"`);
  console.log(`Server: ${me.v.split(" ").slice(0, 2).join(" ")}`);
  if (me.u === "memory_app") fail("PROVISION_DATABASE_URL connects as memory_app. Provisioning needs the database OWNER; the server (not this script) is what runs as memory_app.");
  if (me.vn < 150000) fail(`PostgreSQL 15+ is required (005 rebuilds views WITH (security_invoker = true)); this server reports version_num ${me.vn}.`);

  // ---------------------------------------------------------- roles
  const roleRows = (await client.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('memory_rw','memory_ro_hz','memory_app')")).rows;
  const roles = Object.fromEntries(roleRows.map((r) => [r.rolname, r]));
  const app = roles["memory_app"];
  if (app) {
    if (app.rolsuper || app.rolbypassrls) fail("Role memory_app already exists but is SUPERUSER or BYPASSRLS — row-level security would not bind it. Fix it (ALTER ROLE memory_app NOSUPERUSER NOBYPASSRLS) or drop it and re-run; refusing to continue.");
    if (!app.rolcanlogin) fail("Role memory_app already exists but cannot LOGIN. Fix it (ALTER ROLE memory_app LOGIN) or drop it and re-run.");
    console.log("Role memory_app: exists, attributes safe (login, non-superuser, no BYPASSRLS).");
  }
  if (!checkOnly) {
    if (!roles["memory_rw"]) { await client.query("CREATE ROLE memory_rw NOLOGIN"); console.log("Created role memory_rw (NOLOGIN)."); }
    if (!roles["memory_ro_hz"]) { await client.query("CREATE ROLE memory_ro_hz NOLOGIN"); console.log("Created role memory_ro_hz (NOLOGIN)."); }
    if (!app) {
      if (!appPassword) fail("Role memory_app does not exist and MEMORY_APP_PASSWORD is not set. Set it to a strong password: it becomes the server's DATABASE_URL password.");
      await client.query(`CREATE ROLE memory_app LOGIN PASSWORD ${quoteLiteral(appPassword)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      console.log("Created role memory_app (LOGIN, NOSUPERUSER, NOBYPASSRLS).");
    }
  } else if (!app || !roles["memory_rw"] || !roles["memory_ro_hz"]) {
    fail("--check-only: one or more of memory_rw / memory_ro_hz / memory_app is missing.");
  }

  // ------------------------------------------- migration ledger + apply
  if (!checkOnly) {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // The running server (memory_app) reads the ledger at boot for its drift
    // check (src/saas/validate.ts). Read-only; the server never writes it.
    await client.query("GRANT SELECT ON schema_migrations TO memory_app");
  }
  const ledger = new Map();
  const hasLedger = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
  if (hasLedger) {
    for (const r of (await client.query("SELECT name, sha256 FROM schema_migrations")).rows) ledger.set(r.name, r.sha256);
  } else if (checkOnly) {
    fail("--check-only: schema_migrations ledger does not exist — this database was not provisioned by this script.");
  }

  for (const name of MIGRATIONS) {
    const buf = readFileSync(new URL(name, MIG_DIR));
    const hash = sha256(buf);
    const recorded = ledger.get(name);
    if (recorded === hash) { console.log(`  ${name}: already applied (hash match), skipped.`); continue; }
    if (recorded) fail(`Migration drift: ${name} is recorded in schema_migrations with hash ${recorded.slice(0, 12)}… but the file on disk hashes to ${hash.slice(0, 12)}…. The database and the code disagree; stop and reconcile by hand.`);
    if (checkOnly) fail(`--check-only: migration ${name} has not been applied.`);
    console.log(`  ${name}: applying…`);
    // Migration files carry their own BEGIN/COMMIT (except 003, two idempotent statements).
    // The ledger row is written only after the file completes; if the process dies in
    // between, the next run simply re-applies the (idempotent) file and records it then.
    await client.query(buf.toString("utf8"));
    await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, hash]);
    console.log(`  ${name}: applied + recorded.`);
  }

  // ---------------------------------------------------------- verify (fail loudly)
  const problems = [];
  const tables = new Set((await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.table_name));
  for (const t of EXPECTED_TABLES) if (!tables.has(t)) problems.push(`missing table: ${t}`);
  const views = new Set((await client.query(
    "SELECT table_name FROM information_schema.views WHERE table_schema='public'")).rows.map((r) => r.table_name));
  for (const v of EXPECTED_VIEWS) if (!views.has(v)) problems.push(`missing view: ${v}`);

  const rls = (await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname AND p.policyname='tenant_isolation') AS has_policy
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname = ANY($1)`, [RLS_TABLES])).rows;
  const rlsByName = Object.fromEntries(rls.map((r) => [r.relname, r]));
  for (const t of RLS_TABLES) {
    const r = rlsByName[t];
    if (!r) { problems.push(`RLS check: table ${t} not found`); continue; }
    if (!r.relrowsecurity || !r.relforcerowsecurity) problems.push(`RLS not ENABLE+FORCE on ${t}`);
    if (!r.has_policy) problems.push(`missing tenant_isolation policy on ${t}`);
  }

  const priv = async (obj, p, kind = "table") =>
    (await client.query(`SELECT has_${kind}_privilege('memory_app', $1, $2) AS ok`, [obj, p])).rows[0].ok;
  if (!(await priv("messages", "SELECT"))) problems.push("memory_app lacks SELECT on messages");
  if (!(await priv("messages", "INSERT"))) problems.push("memory_app lacks INSERT on messages");
  if (!(await priv("tenants", "SELECT"))) problems.push("memory_app lacks SELECT on tenants (control plane)");
  if (!(await priv("agent_messages", "INSERT"))) problems.push("memory_app lacks INSERT on agent_messages (Courier)");
  if (!(await priv("messages_id_seq", "USAGE", "sequence"))) problems.push("memory_app lacks USAGE on messages_id_seq");
  if (!(await priv("memory_recalls", "INSERT"))) problems.push("memory_app lacks INSERT on memory_recalls (011_recall_quality.sql)");
  if (!(await priv("memory_supersessions", "INSERT"))) problems.push("memory_app lacks INSERT on memory_supersessions (011_recall_quality.sql)");
  if (!(await priv("schema_migrations", "SELECT"))) problems.push("memory_app lacks SELECT on schema_migrations (the server's boot-time drift check reads it; re-run provisioning in apply mode to grant it)");

  if (tables.has("tenants")) {
    const self = (await client.query("SELECT count(*)::int AS n FROM tenants WHERE id='self'")).rows[0].n;
    if (self !== 1) problems.push("tenants is missing the seeded 'self' tenant row (005 inserts it)");
  }
  const ext = (await client.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='pg_trgm'")).rows[0].n;
  if (ext !== 1) problems.push("extension pg_trgm missing (003_search_index.sql)");
  const idx = (await client.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname='messages_text_trgm'")).rows[0].n;
  if (idx !== 1) problems.push("index messages_text_trgm missing (003_search_index.sql)");
  const fts = (await client.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname='messages_text_fts'")).rows[0].n;
  if (fts !== 1) problems.push("index messages_text_fts missing (011_recall_quality.sql)");

  if (problems.length) {
    console.error("\nVerification found problems:");
    for (const p of problems) console.error(`  - ${p}`);
    fail(`${problems.length} verification problem(s). The database is NOT fully provisioned; do not point the server at it.`);
  }
  console.log(`\nVerified: ${EXPECTED_TABLES.length} tables, ${EXPECTED_VIEWS.length} views, RLS + tenant_isolation on ${RLS_TABLES.length} tables, memory_app grants, 'self' tenant, pg_trgm, full-text index.`);
  console.log("Provisioning complete. The server connects as memory_app, e.g.:");
  console.log("  DATABASE_URL=postgres://memory_app:<MEMORY_APP_PASSWORD>@<host>:5432/<db>");
  console.log("Next: copy server.src/app/.env.example to .env, fill it in, and follow docs/PROVISIONING.md.");
} finally {
  await client.end();
}
