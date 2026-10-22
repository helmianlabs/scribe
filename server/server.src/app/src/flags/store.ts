/**
 * Flags persistence. Takes any query function (a pg Pool, a pg client inside a tenant
 * transaction, or PGlite). Every write passes tenant_id explicitly; every read filters by it
 * (RLS in SaaS mode is a second wall, not the only one).
 */
import { redact, SEVERITIES, severityRank, type Severity } from "./scanner.js";

export interface Q {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface FlagInput {
  severity: Severity;
  category: string;
  rule?: string | null;
  origin: "scanner" | "moderation" | "report" | "api";
  source_ai?: string | null;
  reporter?: string | null;
  reason: string;
  excerpt?: string | null;
  message_id?: number | null;
  context?: Record<string, unknown>;
}

export interface FlagRow extends FlagInput {
  id: number;
  tenant_id: string;
  created_at: string;
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

function cleanContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!ctx) return {};
  const json = JSON.stringify(ctx).slice(0, 4000);
  try { return JSON.parse(redact(json)); } catch { return { note: "context could not be stored safely" }; }
}

export async function insertFlags(q: Q, tenantId: string, flags: FlagInput[]): Promise<{ installed: boolean; rows: FlagRow[] }> {
  const rows: FlagRow[] = [];
  try {
    for (const f of flags) {
      const r = await q.query(
        `INSERT INTO flags (tenant_id, severity, category, rule, origin, source_ai, reporter, reason, excerpt, message_id, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, tenant_id, severity, category, rule, origin, source_ai, reporter, reason, excerpt, message_id, context, created_at`,
        [tenantId, f.severity, f.category.slice(0, 40), f.rule ?? null, f.origin, f.source_ai?.slice(0, 60) ?? null, f.reporter?.slice(0, 80) ?? null,
         redact(f.reason).slice(0, 1000), f.excerpt ? redact(f.excerpt).slice(0, 2000) : null, f.message_id ?? null, JSON.stringify(cleanContext(f.context))],
      );
      rows.push(normalize(r.rows[0]));
    }
    return { installed: true, rows };
  } catch (err) {
    if (isMissing(err)) return { installed: false, rows };
    throw err;
  }
}

export interface ListFlagsParams {
  min_severity?: Severity;
  category?: string;
  since?: string;
  limit?: number;
}

export async function listFlags(q: Q, tenantId: string, p: ListFlagsParams = {}): Promise<{ installed: boolean; flags: FlagRow[] }> {
  const vals: unknown[] = [tenantId];
  let where = "tenant_id = $1";
  if (p.min_severity) {
    vals.push(SEVERITIES.filter((s) => severityRank(s) >= severityRank(p.min_severity!)));
    where += ` AND severity = ANY($${vals.length})`;
  }
  if (p.category) { vals.push(p.category); where += ` AND category = $${vals.length}`; }
  if (p.since) { vals.push(p.since); where += ` AND created_at >= $${vals.length}`; }
  vals.push(Math.min(Math.max(p.limit ?? 50, 1), 500));
  try {
    const r = await q.query(
      `SELECT id, tenant_id, severity, category, rule, origin, source_ai, reporter, reason, excerpt, message_id, context, created_at
       FROM flags WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${vals.length}`, vals);
    return { installed: true, flags: r.rows.map(normalize) };
  } catch (err) {
    if (isMissing(err)) return { installed: false, flags: [] };
    throw err;
  }
}

function normalize(r: any): FlagRow {
  return {
    ...r,
    id: Number(r.id),
    message_id: r.message_id == null ? null : Number(r.message_id),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
