/**
 * Accounts: email magic-link sign-in, sessions, tenants and memberships.
 * Tokens (magic links, sessions) are stored only as SHA-256 hashes.
 */
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";
import type { Mailer } from "./mailer.js";
import { sha256, randomToken, newId, newSlug } from "./crypto.js";
import { PRESETS } from "../librarian/index.js";

export interface User { id: string; email: string; }
export interface Tenant {
  id: string; slug: string; name: string; plan: string; plan_status: string;
  stripe_customer_id: string | null; stripe_subscription_id: string | null;
  alert_email: string | null; alert_webhook_url: string | null; alert_min_severity: string;
}
export interface Membership { tenant: Tenant; role: string; }

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

export function normalizeEmail(raw: string): string | null {
  const e = String(raw || "").trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

/** Only same-site relative paths; never "//host" or a scheme. */
export function safeReturnTo(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.length > 500 || /[\r\n]/.test(s)) return null;
  return s;
}

const TENANT_COLS = "id, slug, name, plan, plan_status, stripe_customer_id, stripe_subscription_id, alert_email, alert_webhook_url, alert_min_severity";

export class Accounts {
  constructor(private db: Db, private cfg: SaasConfig, private mailer: Mailer) {}

  async startMagicLink(rawEmail: string, returnTo: string | null): Promise<{ ok: boolean; error?: string }> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { ok: false, error: "That doesn't look like an email address." };
    const recent = await this.db.control.query(
      "SELECT count(*)::int AS n FROM magic_links WHERE email = $1 AND created_at > now() - interval '15 minutes'", [email]);
    if (recent.rows[0].n >= 5) return { ok: false, error: "Too many sign-in links requested. Wait a few minutes and try again." };
    const token = randomToken(32);
    await this.db.control.query(
      `INSERT INTO magic_links (token_hash, email, return_to, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
      [sha256(token), email, safeReturnTo(returnTo), this.cfg.magicLinkTtlMin]);
    const link = `${this.cfg.publicUrl}/auth/verify?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: email,
      subject: "Your Helmian Scribe sign-in link",
      text: `Sign in to Helmian Scribe:\n\n${link}\n\nThis link works once and expires in ${this.cfg.magicLinkTtlMin} minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Sign in to Helmian Scribe:</p><p><a href="${link}">Sign in</a></p><p style="color:#888">This link works once and expires in ${this.cfg.magicLinkTtlMin} minutes. If you didn't ask for it, ignore this email.</p>`,
    });
    return { ok: true };
  }

  /** Consumes a magic link. Creates the user and a personal tenant on first sign-in. */
  async consumeMagicLink(token: string): Promise<{ sessionToken: string; user: User; returnTo: string | null; created: boolean } | null> {
    const r = await this.db.control.query(
      `UPDATE magic_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email, return_to`,
      [sha256(String(token || ""))]);
    const row = r.rows[0];
    if (!row) return null;
    let created = false;
    let user = (await this.db.control.query("SELECT id, email FROM users WHERE email = $1", [row.email])).rows[0] as User | undefined;
    if (!user) {
      user = { id: newId(), email: row.email };
      await this.db.control.query("INSERT INTO users (id, email) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING", [user.id, user.email]);
      user = (await this.db.control.query("SELECT id, email FROM users WHERE email = $1", [row.email])).rows[0] as User;
      created = true;
    }
    const has = await this.db.control.query("SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1", [user.id]);
    if (!has.rows.length) await this.createTenant(user, `${user.email.split("@")[0]}'s memory`);
    await this.db.control.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    const sessionToken = randomToken(32);
    await this.db.control.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))",
      [sha256(sessionToken), user.id, this.cfg.sessionTtlDays]);
    return { sessionToken, user, returnTo: row.return_to ?? null, created };
  }

  async createTenant(owner: User, name: string, preset = "preset-d"): Promise<Tenant> {
    const id = newId();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.db.control.query(
          "INSERT INTO tenants (id, slug, name, alert_email) VALUES ($1,$2,$3,$4)", [id, newSlug(), name.slice(0, 80), owner.email]);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "23505" || attempt === 4) throw e; // slug collision: retry
      }
    }
    await this.db.control.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')", [id, owner.id]);
    const book = Object.values(PRESETS).find((b) => b.id === preset) ? preset : "preset-d";
    await this.db.tenant(id, (q) => q.query(
      "INSERT INTO librarian_settings (tenant_id, rulebook, chosen_by) VALUES ($1,$2,$3)", [id, book, owner.email]));
    return (await this.tenantById(id))!;
  }

  async userForSession(sessionToken: string | undefined): Promise<User | null> {
    if (!sessionToken) return null;
    const r = await this.db.control.query(
      "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
      [sha256(sessionToken)]);
    return (r.rows[0] as User) ?? null;
  }

  async endSession(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.db.control.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(sessionToken)]);
  }

  async memberships(userId: string): Promise<Membership[]> {
    const r = await this.db.control.query(
      `SELECT m.role, ${TENANT_COLS.split(", ").map((c) => "t." + c).join(", ")} FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 ORDER BY m.created_at ASC`, [userId]);
    return r.rows.map((x) => { const { role, ...tenant } = x; return { role, tenant: tenant as Tenant }; });
  }

  async membership(userId: string, tenantId: string): Promise<Membership | null> {
    return (await this.memberships(userId)).find((m) => m.tenant.id === tenantId) ?? null;
  }

  async tenantById(id: string): Promise<Tenant | null> {
    return ((await this.db.control.query(`SELECT ${TENANT_COLS} FROM tenants WHERE id = $1`, [id])).rows[0] as Tenant) ?? null;
  }
  async tenantBySlug(slug: string): Promise<Tenant | null> {
    return ((await this.db.control.query(`SELECT ${TENANT_COLS} FROM tenants WHERE slug = $1`, [slug])).rows[0] as Tenant) ?? null;
  }
  async tenantByCustomer(customerId: string): Promise<Tenant | null> {
    return ((await this.db.control.query(`SELECT ${TENANT_COLS} FROM tenants WHERE stripe_customer_id = $1`, [customerId])).rows[0] as Tenant) ?? null;
  }

  async updateAlerts(tenantId: string, a: { alert_email?: string | null; alert_webhook_url?: string | null; alert_min_severity?: string }) {
    const email = a.alert_email === undefined ? undefined : a.alert_email ? normalizeEmail(a.alert_email) : null;
    if (a.alert_email && !email) throw new Error("Alert email is not a valid address.");
    let hook = a.alert_webhook_url;
    if (hook) { const u = new URL(hook); if (u.protocol !== "https:" && process.env.ALERT_ALLOW_HTTP_WEBHOOK !== "1") throw new Error("Webhook URL must be https."); hook = u.toString(); }
    if (a.alert_min_severity && !["low", "medium", "high", "critical"].includes(a.alert_min_severity)) throw new Error("Bad severity.");
    await this.db.control.query(
      `UPDATE tenants SET alert_email = CASE WHEN $2::boolean THEN $3 ELSE alert_email END,
                          alert_webhook_url = CASE WHEN $4::boolean THEN $5 ELSE alert_webhook_url END,
                          alert_min_severity = COALESCE($6, alert_min_severity), updated_at = now() WHERE id = $1`,
      [tenantId, email !== undefined, email ?? null, hook !== undefined, hook ?? null, a.alert_min_severity ?? null]);
  }

  async setPreset(tenantId: string, preset: string, by: string) {
    if (!Object.values(PRESETS).find((b) => b.id === preset)) throw new Error("Unknown rulebook preset.");
    await this.db.tenant(tenantId, (q) => q.query("INSERT INTO librarian_settings (tenant_id, rulebook, chosen_by) VALUES ($1,$2,$3)", [tenantId, preset, by]));
  }
}
