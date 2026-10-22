/**
 * Tenant-scoped memory operations. Every function runs inside db.tenant(...) (RLS active)
 * and ALSO filters by tenant_id explicitly. Nothing here can reach another tenant's rows.
 */
import { randomUUID } from "node:crypto";
import type { Q } from "./db.js";
import {
  classify, learnFromMove, parsePlainRule, PRESETS, UNSORTED,
  type Filing, type MemoryItem, type Rule, type Rulebook,
} from "../librarian/index.js";
import { LimitError, type Plan } from "./plans.js";

export const ENGINE_VERSION = "librarian-0.1.0+saas";

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

// ------------------------------------------------------------------ usage + limits
export async function countCall(q: Q, tenantId: string, plan: Plan, kind: "call" | "save" = "call"): Promise<number> {
  const r = await q.query(
    `INSERT INTO usage_daily (tenant_id, day, calls, saves) VALUES ($1, CURRENT_DATE, 1, $2)
     ON CONFLICT (tenant_id, day) DO UPDATE SET calls = usage_daily.calls + 1, saves = usage_daily.saves + EXCLUDED.saves
     RETURNING calls`, [tenantId, kind === "save" ? 1 : 0]);
  const calls = Number(r.rows[0].calls);
  if (calls > plan.callsPerDay) {
    throw new LimitError(`Daily limit reached: the ${plan.name} plan allows ${plan.callsPerDay.toLocaleString("en-US")} calls a day. Upgrade on your dashboard or try again tomorrow (UTC).`, "calls");
  }
  return calls;
}

export async function usage(q: Q, tenantId: string): Promise<{ memories: number; calls_today: number; saves_today: number }> {
  const m = await q.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [tenantId]);
  const u = await q.query("SELECT calls, saves FROM usage_daily WHERE tenant_id = $1 AND day = CURRENT_DATE", [tenantId]);
  return { memories: m.rows[0].n, calls_today: u.rows[0]?.calls ?? 0, saves_today: u.rows[0]?.saves ?? 0 };
}

// ------------------------------------------------------------------ search / save
export async function searchMemory(q: Q, tenantId: string, p: { query: string; since?: string; limit: number }) {
  const vals: unknown[] = [tenantId, `%${p.query.replace(/[\\%_]/g, (c) => "\\" + c)}%`];
  let since = "";
  if (p.since?.trim()) { vals.push(p.since.trim()); since = `AND m.created_at >= $${vals.length}`; }
  vals.push(p.limit);
  const r = await q.query(
    `SELECT m.id AS message_id, c.name AS conversation_name, m.sender, m.created_at, LEFT(m.text, 300) AS snippet
     FROM messages m JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1 AND m.text ILIKE $2 ${since}
     ORDER BY m.created_at DESC LIMIT $${vals.length}`, vals);
  return r.rows.map((x) => ({ message_id: Number(x.message_id), conversation_name: x.conversation_name, sender: x.sender, created_at: iso(x.created_at), snippet: x.snippet ?? "" }));
}

export interface SaveParams { content: string; source: string; category?: string; tags?: string[]; }

export async function saveMemory(q: Q, tenantId: string, plan: Plan, p: SaveParams) {
  const n = (await q.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [tenantId])).rows[0].n as number;
  if (n >= plan.maxMemories) {
    throw new LimitError(`Storage limit reached: the ${plan.name} plan holds ${plan.maxMemories.toLocaleString("en-US")} memories. Upgrade, or export and delete old ones.`, "memories");
  }
  const source = p.source.trim().toLowerCase();
  const category = p.category?.trim();
  const notebook = category ? `Shared Memory — ${category}` : `Shared Memory — ${source}`;
  const tags = (p.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const text = tags.length ? `[tags: ${tags.join(", ")}]\n${p.content}` : p.content;

  const existing = await q.query("SELECT uuid FROM conversations WHERE tenant_id = $1 AND name = $2 ORDER BY created_at ASC LIMIT 1", [tenantId, notebook]);
  let conv: string;
  if (existing.rows[0]) conv = existing.rows[0].uuid;
  else {
    conv = randomUUID();
    await q.query("INSERT INTO conversations (tenant_id, uuid, name, created_at, updated_at, message_count) VALUES ($1,$2,$3, now(), now(), 1)", [tenantId, conv, notebook]);
  }
  const next = await q.query("SELECT COALESCE(MAX(turn_index), -1) + 1 AS i FROM messages WHERE tenant_id = $1 AND conversation_uuid = $2", [tenantId, conv]);
  const ins = await q.query(
    "INSERT INTO messages (tenant_id, conversation_uuid, turn_index, sender, text, created_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id, created_at",
    [tenantId, conv, next.rows[0].i, source, text]);
  return { conversation_name: notebook, conversation_uuid: conv, message_id: Number(ins.rows[0].id), created_at: iso(ins.rows[0].created_at), text };
}

// ------------------------------------------------------------------ Librarian (tenant scoped)
export class TenantLibrarian {
  constructor(private q: Q, private tenantId: string) {}

  async rulebook(): Promise<Rulebook> {
    const r = await this.q.query("SELECT rulebook FROM librarian_settings WHERE tenant_id = $1 ORDER BY chosen_at DESC, id DESC LIMIT 1", [this.tenantId]);
    const id = r.rows[0]?.rulebook as string | undefined;
    return Object.values(PRESETS).find((b) => b.id === id) ?? PRESETS.D;
  }

  async extraRules(): Promise<Rule[]> {
    const r = await this.q.query("SELECT rule_key, layer, rule_json FROM librarian_active_rules WHERE tenant_id = $1", [this.tenantId]);
    return r.rows.map((x) => ({ ...x.rule_json, id: x.rule_key, layer: x.layer }));
  }

  private async record(messageId: number, f: Filing, filedBy: "librarian" | "manual" | "backfill") {
    await this.q.query(
      `INSERT INTO memory_filings (tenant_id, message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [this.tenantId, messageId, f.category, f.tags, f.shape, f.source, f.rulebook, f.winningRule, f.explanation, JSON.stringify(f.hits), filedBy, ENGINE_VERSION]);
  }

  async fileSaved(item: MemoryItem) {
    const f = classify(item, await this.rulebook(), await this.extraRules());
    await this.record(Number(item.id), f, "librarian");
    return { category: f.category, tags: f.tags, explanation: f.explanation, recorded: true };
  }

  async listUnsorted(limit: number) {
    const r = await this.q.query(
      "SELECT message_id, created_at, preview, why FROM memory_unsorted WHERE tenant_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT $2",
      [this.tenantId, Math.min(Math.max(limit, 1), 100)]);
    return { installed: true, items: r.rows.map((x) => ({ ...x, message_id: Number(x.message_id), created_at: x.created_at ? iso(x.created_at) : null })) };
  }

  private async loadItem(id: number): Promise<MemoryItem | null> {
    const r = await this.q.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND m.id = $2",
      [this.tenantId, id]);
    const x = r.rows[0];
    return x ? { id: Number(x.id), text: x.text ?? "", sender: x.sender, conversationName: x.conv } : null;
  }

  async explain(id: number) {
    const r = await this.q.query(
      "SELECT category, tags, rule_key, explanation, filed_by, filed_at FROM memory_current_filing WHERE tenant_id = $1 AND message_id = $2", [this.tenantId, id]);
    if (r.rows[0]) return { recorded: true, ...r.rows[0], filed_at: iso(r.rows[0].filed_at) };
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const f = classify(item, await this.rulebook(), await this.extraRules());
    return { recorded: false, note: "Not recorded yet; this is how the Librarian would file it now.", category: f.category, tags: f.tags, rule_key: f.winningRule, explanation: f.explanation };
  }

  async move(id: number, toCategory: string, movedBy: string) {
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const [book, extra] = [await this.rulebook(), await this.extraRules()];
    const before = classify(item, book, extra);
    const ref = (await this.q.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 ORDER BY m.id DESC LIMIT 500",
      [this.tenantId])).rows.map((x) => ({ id: Number(x.id), text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    const { rule, note } = learnFromMove(item, toCategory, book, extra, ref);
    if (rule) await this.q.query("INSERT INTO librarian_rules (tenant_id, rule_key, layer, rule_json, created_by) VALUES ($1,$2,'learned',$3,$4)", [this.tenantId, rule.id, JSON.stringify(rule), movedBy]);
    await this.q.query("INSERT INTO memory_moves (tenant_id, message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5,$6)", [this.tenantId, id, before.category, toCategory, rule?.id ?? null, movedBy]);
    await this.record(id, { ...before, category: toCategory, winningRule: rule?.id ?? null, explanation: `Moved here by ${movedBy}. ${note}` }, "manual");
    return { moved: true, from: before.category, to: toCategory, learned_rule: rule?.id ?? null, note };
  }

  async addRule(sentence: string, createdBy: string) {
    const n = (await this.q.query("SELECT count(*)::int AS n FROM librarian_rules WHERE tenant_id = $1 AND layer = 'custom'", [this.tenantId])).rows[0].n as number;
    const rule = parsePlainRule(sentence, `custom.${n + 1}`);
    if (!rule) return { added: false, note: 'I could not read that rule. Try: "anything mentioning X goes in Y".' };
    await this.q.query("INSERT INTO librarian_rules (tenant_id, rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,$2,'custom',$3,$4,$5)", [this.tenantId, rule.id, JSON.stringify(rule), sentence, createdBy]);
    return { added: true, rule_key: rule.id, category: rule.category, when: rule.when };
  }
}
export { UNSORTED };

// ------------------------------------------------------------------ export / delete-all
// librarian_settings (the chosen rulebook) and usage_daily (fair-use metering) are kept.
const DATA_TABLES = ["agent_message_reads", "agent_directory", "agent_messages", "flags", "memory_moves", "memory_filings", "librarian_rules", "messages", "conversations", "projects"] as const;

export async function exportAll(q: Q, tenantId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of ["conversations", "messages", "projects", "memory_filings", "memory_moves", "librarian_rules", "librarian_settings", "flags", "usage_daily", "agent_messages", "agent_message_reads", "agent_directory"]) {
    const r = await q.query(`SELECT * FROM ${t} WHERE tenant_id = $1 ORDER BY 1`, [tenantId]);
    out[t] = r.rows;
  }
  return { format: "shared-memory-export", version: 1, tenant_id: tenantId, exported_at: new Date().toISOString(), tables: out };
}

/** Deletes every memory row for the tenant (keeps the account, billing and API keys). */
export async function deleteAll(q: Q, tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of DATA_TABLES) {
    const r = await q.query(`WITH d AS (DELETE FROM ${t} WHERE tenant_id = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [tenantId]);
    counts[t] = r.rows[0].n;
  }
  return counts;
}
