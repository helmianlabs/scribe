/**
 * Startup validation (src/saas/validate.ts): the refusals that replace the old
 * silent degradations (B1 §5.5/§5.6). Config assessment is tested purely; the
 * database checks run against PGlite in the memory_app role, with a
 * schema_migrations ledger written the way scripts/provision-saas-db.mjs
 * writes it (same table, same file hashes, same SELECT grant).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { freshDb, sql, BASE } from "./helpers.ts";
import { pgliteDb } from "../src/saas/db.ts";
import { loadSaasConfig, type SaasConfig } from "../src/saas/config.ts";
import { assessConfig, validateSaasStartup, MIGRATION_FILES, StartupValidationError } from "../src/saas/validate.ts";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function cfg(over: Partial<SaasConfig> = {}): SaasConfig {
  return loadSaasConfig({
    publicUrl: "http://127.0.0.1:8080",
    databaseUrl: "pglite",
    mail: { provider: "dev", from: null, outboxFile: "/tmp/smm-test-outbox.jsonl" },
    stripe: { secretKey: null, webhookSecret: null, prices: { personal: null, personalYearly: null, team: null }, allowLive: false },
    ...over,
  });
}

/** freshDb + the provisioning ledger, exactly as the provisioning script leaves it. */
async function provisionedDb() {
  const pg = await freshDb();
  await pg.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const name of MIGRATION_FILES) {
    await pg.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha256(sql(name))]);
  }
  await pg.exec("GRANT SELECT ON schema_migrations TO memory_app");
  return pg;
}

async function withEnv(vars: Record<string, string | null>, fn: () => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const DEV_ENV = { NODE_ENV: null, DEPLOY_ENV: null, PUBLIC_URL: null } as const;

test("provisioned database passes in development posture; dev mailer is a loud warning, not silence", async () => {
  await withEnv({ ...DEV_ENV }, async () => {
    const db = pgliteDb(await provisionedDb(), "memory_app");
    const report = await validateSaasStartup(cfg(), db);
    assert.equal(report.production, false);
    assert.ok(report.warnings.some((w) => w.includes("DEV MAILER ACTIVE")), "dev mailer must announce itself");
    assert.ok(report.warnings.some((w) => w.includes("Stripe is not configured")), "mock billing must announce itself");
  });
});

test("unprovisioned database is refused (no ledger)", async () => {
  await withEnv({ ...DEV_ENV }, async () => {
    const pg = new PGlite();
    await pg.exec(BASE); // base schema only — never provisioned
    const db = pgliteDb(pg, "memory_app");
    await assert.rejects(validateSaasStartup(cfg(), db), (err: unknown) => {
      assert.ok(err instanceof StartupValidationError);
      assert.match(err.message, /NOT provisioned/);
      return true;
    });
  });
});

test("partially provisioned database is refused (a migration is missing from the ledger)", async () => {
  await withEnv({ ...DEV_ENV }, async () => {
    const pg = await provisionedDb();
    await pg.query("DELETE FROM schema_migrations WHERE name = '006_courier.sql'");
    const db = pgliteDb(pg, "memory_app");
    await assert.rejects(validateSaasStartup(cfg(), db), /006_courier\.sql is not recorded/);
  });
});

test("drifted database is refused (ledger hash does not match the migration file)", async () => {
  await withEnv({ ...DEV_ENV }, async () => {
    const pg = await provisionedDb();
    await pg.query("UPDATE schema_migrations SET sha256 = 'deadbeef' WHERE name = '004_flags.sql'");
    const db = pgliteDb(pg, "memory_app");
    await assert.rejects(validateSaasStartup(cfg(), db), /Migration drift: 004_flags\.sql/);
  });
});

test("production posture refuses localhost PUBLIC_URL, an unset PUBLIC_URL, and the dev mailer", async () => {
  await withEnv({ NODE_ENV: "production", DEPLOY_ENV: null, PUBLIC_URL: null }, async () => {
    const db = pgliteDb(await provisionedDb(), "memory_app");
    await assert.rejects(validateSaasStartup(cfg(), db), (err: unknown) => {
      assert.ok(err instanceof StartupValidationError);
      assert.match(err.message, /PUBLIC_URL is not set/);
      assert.match(err.message, /points at 127\.0\.0\.1 in production posture/);
      assert.match(err.message, /Mail provider resolved to 'dev'/);
      return true;
    });
  });
});

test("production posture accepts a fully configured production config", async () => {
  await withEnv({ NODE_ENV: "production", DEPLOY_ENV: null, PUBLIC_URL: "https://scribemem.helmian.cloud" }, async () => {
    const db = pgliteDb(await provisionedDb(), "memory_app");
    const report = await validateSaasStartup(cfg({
      publicUrl: "https://scribemem.helmian.cloud",
      mail: { provider: "resend", from: "Scribe <login@helmian.cloud>", outboxFile: "/tmp/x" },
      stripe: { secretKey: "sk_test_x", webhookSecret: "whsec_x", prices: { personal: "price_p", personalYearly: "price_y", team: "price_t" }, allowLive: false },
    }), db);
    assert.equal(report.production, true);
    assert.deepEqual(report.warnings, []);
  });
});

test("half-configured Stripe is refused in any posture; a live key without the live flag is refused", () => {
  const half = assessConfig(cfg({ stripe: { secretKey: "sk_test_x", webhookSecret: null, prices: { personal: "price_p", personalYearly: "price_y", team: null }, allowLive: false } }), false);
  assert.ok(half.problems.some((p) => p.includes("half-configured") && p.includes("STRIPE_WEBHOOK_SECRET") && p.includes("STRIPE_PRICE_TEAM")));
  const live = assessConfig(cfg({ stripe: { secretKey: "sk_live_x", webhookSecret: "whsec_x", prices: { personal: "price_p", personalYearly: "price_y", team: "price_t" }, allowLive: false } }), false);
  assert.ok(live.problems.some((p) => p.includes("LIVE key")));
});
