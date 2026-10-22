/**
 * The Flags pipeline used by save_memory, report_flag and the Flags API:
 *   1. scan (local): redact secrets/PII, detect harmful code + hedging
 *   2. optional moderation (OpenAI) on the REDACTED text
 *   3. store flags for the tenant
 *   4. alert (email / webhook) at or above the tenant's threshold
 */
import { scanText, type Finding, type Severity } from "./scanner.js";
import { moderate, type FetchLike } from "./moderation.js";
import { insertFlags, type FlagInput, type FlagRow, type Q } from "./store.js";
import { deliverAlert, type AlertResult, type AlertTarget } from "./alerts.js";

export interface PreparedContent {
  text: string;          // what may be stored (redacted)
  findings: Finding[];
  redactions: number;
}

export async function prepareContent(raw: string, fetchImpl?: FetchLike): Promise<PreparedContent> {
  const s = scanText(raw);
  const mod = await moderate(s.redacted, fetchImpl);
  return { text: s.redacted, findings: [...s.findings, ...mod], redactions: s.redactions };
}

export function findingsToFlags(findings: Finding[], ctx: { source_ai?: string | null; reporter?: string | null; message_id?: number | null; excerpt?: string | null }): FlagInput[] {
  return findings.map((f) => ({
    severity: f.severity,
    category: f.category,
    rule: f.rule,
    origin: f.category === "moderation" ? "moderation" : "scanner",
    source_ai: ctx.source_ai ?? null,
    reporter: ctx.reporter ?? "server",
    reason: f.reason,
    excerpt: f.snippet ?? ctx.excerpt ?? null,
    message_id: ctx.message_id ?? null,
  }));
}

export interface RecordResult {
  installed: boolean;
  flags: FlagRow[];
  alert: AlertResult | null;
}

export async function recordFlags(q: Q, tenantId: string, flags: FlagInput[], target: AlertTarget | null, fetchImpl?: FetchLike): Promise<RecordResult> {
  if (!flags.length) return { installed: true, flags: [], alert: null };
  const stored = await insertFlags(q, tenantId, flags);
  const alertable = stored.installed ? stored.rows : flags.map((f) => ({ ...f, id: 0, tenant_id: tenantId, created_at: new Date().toISOString() }));
  const alert = target ? await deliverAlert(target, alertable, fetchImpl) : null;
  return { installed: stored.installed, flags: stored.rows, alert };
}

export function summarize(findings: Finding[]): Array<{ severity: Severity; category: string; rule: string; reason: string }> {
  return findings.map((f) => ({ severity: f.severity, category: f.category, rule: f.rule, reason: f.reason }));
}
