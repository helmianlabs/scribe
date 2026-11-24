/** Entry point for MEMORY_MODE=saas. */
import { loadSaasConfig } from "./config.js";
import { pgDb } from "./db.js";
import { createSaasApp } from "./app.js";
import { validateSaasStartup } from "./validate.js";

const cfg = loadSaasConfig();
if (!cfg.databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
const db = pgDb(cfg.databaseUrl, cfg.databaseSsl);

// Boot validation (validate.ts): refuse to serve on a silently-degraded
// configuration — localhost PUBLIC_URL in production, the dev mailer in
// production, an unprovisioned/drifted database, a role RLS cannot bind.
let report;
try {
  report = await validateSaasStartup(cfg, db);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  await db.close().catch(() => {});
  process.exit(1);
}
for (const w of report.warnings) console.error(w);
console.error(`startup validation: OK (posture: ${report.production ? "production" : "development"})`);

const { app, oauth, billing } = createSaasApp({ db, cfg });
setInterval(() => { oauth.cleanup().catch(() => {}); }, 10 * 60 * 1000).unref();
app.listen(cfg.port, () => {
  console.error(`helmian-scribe (saas) listening on :${cfg.port}\n  public: ${cfg.publicUrl}\n  mail: ${cfg.mail.provider}\n  billing: ${billing.mode}\n  posture: ${report.production ? "production" : "development"}`);
});
