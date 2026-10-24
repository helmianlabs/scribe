/**
 * Alert delivery for flags: email (Resend) and/or a signed webhook. Both are optional and
 * stubbed safely: with no keys/URLs configured, delivery is a no-op that reports "stubbed".
 * Payloads only ever contain REDACTED excerpts. Never throws.
 *
 * Webhook signature (so receivers can verify it came from us):
 *   X-Memory-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */
import { createHmac } from "node:crypto";
import { severityRank, type Severity } from "./scanner.js";
import type { FetchLike } from "./moderation.js";

export interface AlertFlag {
  id?: number | string;
  severity: Severity;
  category: string;
  rule?: string | null;
  reason: string;
  source_ai?: string | null;
  excerpt?: string | null;
  created_at?: string;
}

export interface AlertTarget {
  tenantId: string;
  tenantName?: string;
  email?: string | null;          // recipient
  webhookUrl?: string | null;
  minSeverity?: Severity;
  dashboardUrl?: string;
}

export interface AlertResult {
  sent: boolean;
  email: "sent" | "stubbed" | "skipped" | "failed";
  webhook: "sent" | "stubbed" | "skipped" | "failed";
}

export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expect = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return expect.length === (parts.v1 || "").length && timingSafe(expect, parts.v1);
}

function timingSafe(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function isSafeWebhookUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    // http only for local development receivers
    return url.protocol === "http:" && process.env.ALERT_ALLOW_HTTP_WEBHOOK === "1";
  } catch {
    return false;
  }
}

export async function deliverAlert(target: AlertTarget, flags: AlertFlag[], fetchImpl: FetchLike = fetch): Promise<AlertResult> {
  const min = target.minSeverity || (process.env.ALERT_MIN_SEVERITY as Severity) || "high";
  const due = flags.filter((f) => severityRank(f.severity) >= severityRank(min));
  const result: AlertResult = { sent: false, email: "skipped", webhook: "skipped" };
  if (!due.length) return result;

  const top = due.reduce((a, b) => (severityRank(b.severity) > severityRank(a.severity) ? b : a));
  const subject = `[${top.severity.toUpperCase()}] ${due.length} flag${due.length > 1 ? "s" : ""} in Helmian Scribe`;
  const payload = {
    type: "flags.raised",
    tenant_id: target.tenantId,
    created_at: new Date().toISOString(),
    flags: due.map((f) => ({ id: f.id, severity: f.severity, category: f.category, rule: f.rule, reason: f.reason, source_ai: f.source_ai, excerpt: f.excerpt })),
  };

  // Email (Resend)
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!target.email) result.email = "skipped";
  else if (!key || !from || process.env.ALERT_EMAIL === "off") result.email = "stubbed";
  else {
    const rows = due.map((f) => `<li><b>${esc(f.severity)}</b> · ${esc(f.category)} · ${esc(f.reason)}${f.source_ai ? ` (from ${esc(f.source_ai)})` : ""}${f.excerpt ? `<br><code>${esc(f.excerpt.slice(0, 300))}</code>` : ""}</li>`).join("");
    try {
      const r = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          from, to: [target.email], subject,
          html: `<p>New flags${target.tenantName ? ` in <b>${esc(target.tenantName)}</b>` : ""}:</p><ul>${rows}</ul>${target.dashboardUrl ? `<p><a href="${esc(target.dashboardUrl)}">Open your dashboard</a></p>` : ""}<p style="color:#888">Secrets and personal numbers are redacted before anything is stored or sent.</p>`,
        }),
      });
      result.email = r.ok ? "sent" : "failed";
    } catch {
      result.email = "failed";
    }
  }

  // Webhook
  const url = target.webhookUrl || process.env.ALERT_WEBHOOK_URL;
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!url) result.webhook = "skipped";
  else if (!secret || !isSafeWebhookUrl(url)) result.webhook = "stubbed";
  else {
    const body = JSON.stringify(payload);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Memory-Signature": signWebhook(secret, body) },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      result.webhook = r.ok ? "sent" : "failed";
    } catch {
      result.webhook = "failed";
    }
  }
  result.sent = result.email === "sent" || result.webhook === "sent";
  return result;
}
