/** Entry point for MEMORY_MODE=saas. */
import { loadSaasConfig } from "./config.js";
import { pgDb } from "./db.js";
import { createSaasApp } from "./app.js";

const cfg = loadSaasConfig();
if (!cfg.databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
const db = pgDb(cfg.databaseUrl, cfg.databaseSsl);
const { app, oauth, billing } = createSaasApp({ db, cfg });
setInterval(() => { oauth.cleanup().catch(() => {}); }, 10 * 60 * 1000).unref();
app.listen(cfg.port, () => {
  console.error(`shared-memory (saas) listening on :${cfg.port}\n  public: ${cfg.publicUrl}\n  mail: ${cfg.mail.provider}\n  billing: ${billing.mode}`);
});
