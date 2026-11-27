/**
 * SaaS-mode startup validation (called once from main.ts before the app listens).
 *
 * The failure mode this exists to kill is the SILENT one (B1 gaps §5.5/§5.6): a
 * production deploy that boots happily with PUBLIC_URL defaulted to localhost, or
 * with the dev mailer quietly swallowing every magic-link email, or pointed at a
 * database nobody provisioned. Here those are loud refusals in production posture,
 * and loud warnings otherwise. Development posture stays permissive so local and
 * staging runs (localhost PUBLIC_URL, dev mailer) keep working — but never quietly.
 *
 * Posture: "production" when NODE_ENV=production or DEPLOY_ENV=production.
 *
 * Database checks run over db.control AS THE SERVER'S OWN ROLE (memory_app):
 * the provisioning ledger (schema_migrations — the provisioning script grants the
 * server SELECT on it), the 'self' tenant, the role's own attributes, and the RLS
 * state of every data-plane table. This is the boot-time half of B4's check; the
 * owner-level half is scripts/provision-saas-db.mjs --check-only, which the
 * container entrypoint runs before the server starts (docs/HOSTING.md).
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";

// The provisioning chain, in order — keep in sync with scripts/provision-saas-db.mjs.
export const MIGRATION_FILES = [
  "000_base.sql",
  "001_librarian.sql",
  "003_search_index.sql",
  "004_flags.sql",
  "005_saas.sql",
  "006_courier.sql",
  "007_stripe_events_status.sql",
  "009_plans_personal.sql",
  "010_paddle_seats.sql",
  "011_recall_quality.sql",
];
// Tables 005/006 put under FORCE row-level security with a tenant_isolation policy.
const RLS_TABLES = [
  "conversations", "messages", "projects", "librarian_settings", "librarian_rules",
  "memory_filings", "memory_moves", "flags", "usage_daily", "tenant_storage",
  "agent_messages", "agent_message_reads", "agent_message_receipts", "agent_directory",
  "memory_supersessions", "memory_recalls",
];

export function isProductionPosture(): boolean {
  return process.env.NODE_ENV === "production" || process.env.DEPLOY_ENV === "production";
}

/** Locate the migration files (for the drift check): MIGRATIONS_DIR, else the image layout. */
export function migrationsDir(): string | null {
  const candidates: string[] = [];
  if (process.env.MIGRATIONS_DIR) candidates.push(process.env.MIGRATIONS_DIR);
  // Repo layout (src/saas and dist/saas both sit 4 levels below the repo root, where
  // migrations/ lives) and the SaaS image layout (app at /app, migrations at /migrations —
  // the same relative path clamps at the filesystem root). 
  candidates.push(new URL("../../../../migrations/", import.meta.url).pathname);
  candidates.push(new URL("../../../migrations/", import.meta.url).pathname);
  for (const dir of candidates) if (existsSync(`${dir}/000_base.sql`)) return dir.replace(/\/+$/, "");
  return null;
}

export interface ConfigAssessment { problems: string[]; warnings: string[]; }

/** Pure configuration checks (no database). Exported for tests. */
export function assessConfig(cfg: SaasConfig, production: boolean): ConfigAssessment {
  const problems: string[] = [];
  const warnings: string[] = [];

  // --- PUBLIC_URL: issuer, resource URLs, cookie Secure flags and Stripe redirects
  // all derive from it (config.ts silently defaults it to http://localhost:8080).
  let url: URL | null = null;
  try { url = new URL(cfg.publicUrl); } catch { /* handled below */ }
  if (!url) {
    problems.push(`PUBLIC_URL "${cfg.publicUrl}" is not a valid URL.`);
  } else {
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (production) {
      if (!process.env.PUBLIC_URL) problems.push("PUBLIC_URL is not set — it silently defaulted to http://localhost:8080 (config.ts). Set it to the exact public https origin (e.g. https://scribemem.helmian.cloud).");
      if (local) problems.push(`PUBLIC_URL points at ${url.hostname} in production posture. OAuth issuer/resource URLs and cookies would be minted for a loopback origin no client can reach.`);
      if (url.protocol !== "https:") problems.push(`PUBLIC_URL must be an https:// origin in production posture (got ${url.protocol}//). TLS is terminated at the reverse proxy; the public origin is still https.`);
    } else if (local) {
      warnings.push(`PUBLIC_URL is ${cfg.publicUrl} (development posture — fine locally, never in production).`);
    }
  }

  // --- Sign-in email: the dev mailer sends NOTHING (magic links go to a file).
  if (cfg.mail.provider === "dev") {
    if (production) {
      problems.push("Mail provider resolved to 'dev': magic-link sign-in email would never be sent (links are appended to an outbox file instead). Set RESEND_API_KEY and MAIL_FROM (verified Resend sending domain) — see docs/HOSTING.md.");
    } else {
      warnings.push(
        "\n====================================================================\n" +
        "  DEV MAILER ACTIVE — no email will be sent. Magic links are only\n" +
        `  appended to the outbox file: ${cfg.mail.outboxFile}\n` +
        "  Fine for local/staging. NEVER run production this way.\n" +
        "====================================================================");
    }
  }

  // --- Payment provider: PAYMENT_PROVIDER picks one; a typo must not silently fall back to Stripe.
  const rawProvider = process.env.PAYMENT_PROVIDER?.trim();
  if (rawProvider && rawProvider !== "stripe" && rawProvider !== "paddle") {
    problems.push(`PAYMENT_PROVIDER is "${rawProvider}"; it must be "stripe" or "paddle" (or unset, which means stripe).`);
  }

  // --- Paddle: fully configured or fully off — never half. Only checked when it is the selected provider or a key is set.
  const pd = cfg.paddle;
  if (cfg.paymentProvider === "paddle" || pd.apiKey) {
    if (pd.apiKey) {
      const missing: string[] = [];
      if (!pd.webhookSecret) missing.push("PADDLE_WEBHOOK_SECRET");
      if (!pd.clientToken) missing.push("PADDLE_CLIENT_TOKEN");
      if (!pd.prices.personal) missing.push("PADDLE_PRICE_PERSONAL");
      if (!pd.prices.personalYearly) missing.push("PADDLE_PRICE_PERSONAL_YEARLY");
      if (!pd.prices.team) missing.push("PADDLE_PRICE_TEAM");
      if (missing.length) problems.push(`Paddle is half-configured: PADDLE_API_KEY is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Either complete the billing configuration or unset PADDLE_API_KEY to run with billing off.`);
      const sandboxKey = pd.apiKey.includes("_sdbx");
      if (!sandboxKey && !pd.allowLive) problems.push("PADDLE_API_KEY is a LIVE key but PADDLE_ALLOW_LIVE is not set to 'yes-i-mean-live'. Live billing is a deliberate, separate decision — refusing to boot.");
      if (pd.clientToken) {
        if (sandboxKey && !pd.clientToken.startsWith("test_")) problems.push("PADDLE_API_KEY is a sandbox key but PADDLE_CLIENT_TOKEN is not a sandbox token (sandbox tokens start with test_). Sandbox and live credentials cannot be mixed.");
        if (!sandboxKey && !pd.clientToken.startsWith("live_")) problems.push("PADDLE_API_KEY is a live key but PADDLE_CLIENT_TOKEN is not a live token (live tokens start with live_). Sandbox and live credentials cannot be mixed.");
      }
    } else {
      warnings.push("PAYMENT_PROVIDER is paddle but PADDLE_API_KEY is not set — billing runs in mock mode (checkout disabled, plans display-only).");
    }
  }

  // --- Stripe: fully configured or fully off — never half.
  const s = cfg.stripe;
  if (cfg.paymentProvider === "paddle" && !s.secretKey) {
    // Paddle is the provider; Stripe is intentionally off. No Stripe warning.
  } else if (s.secretKey) {
    const missing: string[] = [];
    if (!s.webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
    if (!s.prices.personal) missing.push("STRIPE_PRICE_PERSONAL");
    if (!s.prices.personalYearly) missing.push("STRIPE_PRICE_PERSONAL_YEARLY");
    if (!s.prices.team) missing.push("STRIPE_PRICE_TEAM");
    if (missing.length) problems.push(`Stripe is half-configured: STRIPE_SECRET_KEY is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Either complete the billing configuration or unset STRIPE_SECRET_KEY to run with billing off.`);
    if (s.secretKey.startsWith("sk_live") && !s.allowLive) problems.push("STRIPE_SECRET_KEY is a LIVE key but STRIPE_ALLOW_LIVE is not set to 'yes-i-mean-live'. Live billing is a deliberate, separate decision — refusing to boot.");
  } else {
    warnings.push("Stripe is not configured — billing runs in mock mode (checkout disabled, plans display-only). Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + STRIPE_PRICE_PERSONAL + STRIPE_PRICE_PERSONAL_YEARLY + STRIPE_PRICE_TEAM to enable it.");
  }

  if (!cfg.databaseUrl) problems.push("DATABASE_URL is not set.");
  return { problems, warnings };
}

export interface StartupReport { production: boolean; warnings: string[]; }

export class StartupValidationError extends Error {
  constructor(problems: string[]) {
    super(
      `SAAS STARTUP VALIDATION FAILED — refusing to boot (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\nFix the configuration and restart. See docs/HOSTING.md and docs/PROVISIONING.md.");
    this.name = "StartupValidationError";
  }
}

/**
 * Full startup validation: config assessment + database checks. Resolves with a
 * report (warnings to print loudly) or throws StartupValidationError listing
 * every problem found — all of them, not just the first.
 */
export async function validateSaasStartup(cfg: SaasConfig, db: Db): Promise<StartupReport> {
  const production = isProductionPosture();
  const { problems, warnings } = assessConfig(cfg, production);
  if (cfg.databaseUrl) {
    try {
      await checkDatabase(db, production, problems, warnings);
    } catch (err) {
      problems.push(`Database checks could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (problems.length) throw new StartupValidationError(problems);
  return { production, warnings };
}

async function checkDatabase(db: Db, production: boolean, problems: string[], warnings: string[]): Promise<void> {
  const { rows: roleRows } = await db.control.query(
    "SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const role = roleRows[0];
  if (!role) { problems.push("Could not read the server role's attributes from pg_roles."); return; }
  if (role.rolsuper || role.rolbypassrls) {
    const msg = `DATABASE_URL connects as role "${role.u}" which is ${role.rolsuper ? "SUPERUSER" : "BYPASSRLS"} — row-level security does not bind such a role, so tenant isolation would be decorative. The server must connect as memory_app (NOSUPERUSER, NOBYPASSRLS); see docs/PROVISIONING.md.`;
    if (production) problems.push(msg); else warnings.push(msg);
  }

  // --- Provisioning ledger: missing/unreadable ⇒ unprovisioned; hash mismatch ⇒ drift.
  let ledger = new Map<string, string>();
  try {
    const { rows } = await db.control.query("SELECT name, sha256 FROM schema_migrations");
    ledger = new Map(rows.map((r: { name: string; sha256: string }) => [r.name, r.sha256]));
  } catch {
    problems.push("The database is NOT provisioned: the schema_migrations ledger is missing or unreadable by the server role. Run the provisioning script (owner connection): node scripts/provision-saas-db.mjs — see docs/PROVISIONING.md. (Databases provisioned before this release need one apply-mode run to grant the server read access to the ledger.)");
    return;
  }
  const dir = migrationsDir();
  if (!dir) {
    const msg = "Migration files were not found on disk (looked in MIGRATIONS_DIR and the standard layouts), so the drift check cannot run.";
    if (production) problems.push(`${msg} The SaaS image carries them at /migrations; a production boot must be able to verify the database matches the code.`);
    else warnings.push(`${msg} Ledger presence was still verified.`);
  }
  for (const name of MIGRATION_FILES) {
    const recorded = ledger.get(name);
    if (!recorded) { problems.push(`Migration ${name} is not recorded in schema_migrations — the database is unprovisioned or partially provisioned. Run scripts/provision-saas-db.mjs (docs/PROVISIONING.md).`); continue; }
    if (dir) {
      const hash = createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex");
      if (hash !== recorded) problems.push(`Migration drift: ${name} is recorded with hash ${recorded.slice(0, 12)}… but the file in this deployment hashes to ${hash.slice(0, 12)}…. The database and the code disagree; stop and reconcile by hand — never edit an applied migration.`);
    }
  }
  if (problems.length) return; // schema state is already damning; deeper checks would just add noise

  // --- Seeded tenant + RLS state on every data-plane table.
  const { rows: selfRows } = await db.control.query("SELECT count(*)::int AS n FROM tenants WHERE id = 'self'");
  if (selfRows[0]?.n !== 1) problems.push("The seeded 'self' tenant row is missing from tenants (005_saas.sql inserts it) — the database is not fully provisioned.");

  const { rows: rlsRows } = await db.control.query(
    `SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            (p.polname IS NOT NULL) AS has_policy
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [RLS_TABLES]);
  const byName = new Map(rlsRows.map((r: { t: string }) => [r.t, r]));
  for (const t of RLS_TABLES) {
    const r = byName.get(t) as { enabled: boolean; forced: boolean; has_policy: boolean } | undefined;
    if (!r) { problems.push(`RLS check: table ${t} not found — the database is not fully provisioned.`); continue; }
    if (!r.enabled || !r.forced) problems.push(`Row-level security is not ENABLE+FORCE on ${t}.`);
    if (!r.has_policy) problems.push(`Table ${t} has no tenant_isolation policy.`);
  }
}
