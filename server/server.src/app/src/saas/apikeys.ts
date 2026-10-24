/** Service API keys: "smk_<random>". Stored as SHA-256 only; shown to the user once. */
import type { Db } from "./db.js";
import { sha256, randomToken, newId } from "./crypto.js";
import { LimitError, type Plan } from "./plans.js";

export const API_KEY_SCOPES = ["flags.write", "flags.read", "mailbox.read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Keys created without an explicit scope list keep the historical Flags-only grant. */
export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = ["flags.write", "flags.read"];

export interface ApiKeyAuth { keyId: string; tenantId: string; name: string; scopes: string[]; }

export class ApiKeys {
  constructor(private db: Db) {}

  async create(tenantId: string, plan: Plan, name: string, scopes: string[], createdBy: string) {
    const n = (await this.db.control.query("SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL", [tenantId])).rows[0].n;
    if (n >= plan.maxApiKeys) throw new LimitError(`The ${plan.name} plan allows ${plan.maxApiKeys} active API key${plan.maxApiKeys > 1 ? "s" : ""}. Revoke one or upgrade.`, "api_keys");
    const clean = scopes.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));
    const granted = clean.length ? clean : [...DEFAULT_API_KEY_SCOPES];
    const key = `smk_${randomToken(30)}`;
    const id = newId();
    await this.db.control.query(
      "INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, tenantId, name.slice(0, 60) || "API key", sha256(key), key.slice(0, 10), granted, createdBy]);
    return { id, key, prefix: key.slice(0, 10), scopes: granted };
  }

  async list(tenantId: string) {
    const r = await this.db.control.query(
      "SELECT id, name, prefix, scopes, created_by, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
    return r.rows;
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    const r = await this.db.control.query("UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id", [tenantId, id]);
    return r.rows.length > 0;
  }

  async verify(key: string | undefined): Promise<ApiKeyAuth | null> {
    if (!key || !key.startsWith("smk_")) return null;
    const r = await this.db.control.query(
      "UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, tenant_id, name, scopes", [sha256(key)]);
    const k = r.rows[0];
    return k ? { keyId: k.id, tenantId: k.tenant_id, name: k.name, scopes: k.scopes } : null;
  }
}
