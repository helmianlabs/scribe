/**
 * Optional OpenAI Moderation check. Off unless OPENAI_API_KEY is set (and FLAGS_MODERATION is
 * not "off"). Only ever sees text that has ALREADY been redacted by the scanner. Never throws:
 * a timeout or API error means "no moderation finding", never a failed save.
 */
import type { Finding, Severity } from "./scanner.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function moderationEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && (process.env.FLAGS_MODERATION || "on") !== "off";
}

const HIGH = new Set(["sexual/minors", "self-harm/instructions", "violence/graphic", "illicit/violent", "hate/threatening", "harassment/threatening"]);

export async function moderate(redactedText: string, fetchImpl: FetchLike = fetch): Promise<Finding[]> {
  if (!moderationEnabled()) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.FLAGS_MODERATION_TIMEOUT_MS || 3000));
  try {
    const r = await fetchImpl("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest", input: redactedText.slice(0, 20000) }),
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const body = (await r.json()) as { results?: Array<{ flagged: boolean; categories: Record<string, boolean> }> };
    const res = body.results?.[0];
    if (!res?.flagged) return [];
    const cats = Object.entries(res.categories || {}).filter(([, v]) => v).map(([k]) => k);
    const severity: Severity = cats.some((c) => HIGH.has(c)) ? "high" : "medium";
    return [{ category: "moderation", rule: "moderation.openai", severity, reason: `Moderation flagged: ${cats.join(", ")}.` }];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
