/**
 * Tenant-aware database access for SaaS mode.
 *
 *   db.control(sql, params)    control-plane tables (tenants, users, sessions, OAuth, keys)
 *   db.tenant(id, async q => ...)  one transaction with app.tenant_id set; RLS limits every
 *                              data-plane table to that tenant. Code ALSO filters by tenant_id.
 *
 * Works with node-postgres (production/staging) and PGlite (tests).
 */
import pg from "pg";
import type { Q } from "../flags/store.js";

export type { Q };

export interface Db {
  control: Q;
  tenant<T>(tenantId: string, fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string, ssl: boolean): Db {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    application_name: "shared-memory-saas",
  });
  return {
    control: { query: (sql, params) => pool.query(sql, params as unknown[]) },
    async tenant(tenantId, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const out = await fn({ query: (sql, params) => client.query(sql, params as unknown[]) });
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** PGlite adapter (tests). `role` lets tests run as a non-superuser so RLS really applies. */
export function pgliteDb(db: any, role?: string): Db {
  let chain: Promise<unknown> = Promise.resolve();
  // PGlite is a single connection: serialize work so tenant transactions never interleave.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const asRole = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (role) await db.query(`SET ROLE ${role}`);
    try { return await fn(); } finally { if (role) await db.query("RESET ROLE"); }
  };
  return {
    control: { query: (sql, params) => serial(() => asRole(() => db.query(sql, params))) },
    tenant: (tenantId, fn) => serial(() => asRole(() =>
      db.transaction(async (tx: any) => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return fn({ query: (sql, params) => tx.query(sql, params) });
      }))),
    close: async () => {},
  };
}
