// migrate-008.mjs — check or apply migration 008 (graph 'value' kind) on ONE memory database.
// Runs INSIDE a one-off container started from a memory-server image (which bundles node + pg);
// it is never run against a live container and never writes in check mode.
//
//   node migrate-008.mjs <envFile> <varName> <sqlFile|-> <check|apply> [dbOverride]
//
// <envFile>  an env file holding the OWNER connection string (mounted read-only by the caller).
// <varName>  the variable inside it that names this database's owner connection.
// [dbOverride]  optional database-name override: the Scribe-side owner string in
//            /root/neon-migration.env (FREE_DAIRYFORGE_URL) names database `neondb`,
//            while Scribe's memory lives in `claude_memory` on the same endpoint —
//            pass `claude_memory` to retarget the same owner connection at it.
// The connection value is read in-process and never printed. Output is limited to the
// constraint name, its definition, and counts — safe to log.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [envFile, varName, sqlFile, mode, dbOverride] = process.argv.slice(2);
if (!envFile || !varName || !sqlFile || !["check", "apply"].includes(mode ?? "")) {
  console.error("usage: node migrate-008.mjs <envFile> <varName> <sqlFile|-> <check|apply> [dbOverride]");
  process.exit(2);
}
const envText = readFileSync(envFile, "utf8");
let conn = envText.match(new RegExp("^" + varName + "=(.+)$", "m"))?.[1].trim().replace(/^["']|["']$/g, "");
if (!conn) { console.error(`variable ${varName} not found in env file`); process.exit(2); }
if (dbOverride) { const u = new URL(conn); u.pathname = "/" + dbOverride; conn = u.toString(); }

const require = createRequire(process.cwd() + "/");
const pg = require("pg");
const client = new pg.Client({ connectionString: conn });
await client.connect();
try {
  const check = async () => {
    const c = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'entities'::regclass AND contype = 'c' AND conname LIKE '%kind%' ORDER BY conname`);
    const v = await client.query(`SELECT count(*)::int AS n FROM entities WHERE kind = 'value'`);
    return { constraints: c.rows, valueEntities: v.rows[0].n };
  };
  const before = await check();
  console.log("constraints:", JSON.stringify(before.constraints));
  console.log("value entities:", before.valueEntities);
  const names = before.constraints.map((r) => r.conname);
  if (!names.includes("entities_kind_check")) {
    console.error("ABORT: expected constraint entities_kind_check not found; names seen: " + names.join(", "));
    process.exit(3);
  }
  const hasValue = before.constraints.some((r) => r.def.includes("'value'"));
  if (mode === "check") {
    console.log(hasValue ? "STATE: 008 already applied ('value' in CHECK)" : "STATE: 008 not applied");
    process.exit(0);
  }
  if (hasValue) { console.log("STATE: already applied, nothing to do"); process.exit(0); }
  const sql = readFileSync(sqlFile, "utf8");
  await client.query(sql);
  const after = await check();
  console.log("after:", JSON.stringify(after.constraints));
  if (!after.constraints.some((r) => r.def.includes("'value'"))) {
    console.error("ABORT: migration ran but 'value' is not in the CHECK afterwards");
    process.exit(4);
  }
  console.log("APPLIED: 008 in place, 'value' admitted by entities_kind_check");
} finally {
  await client.end();
}
