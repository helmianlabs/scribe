/**
 * Tenant-scoped memory operations. Every function runs inside db.tenant(...) (RLS active)
 * and ALSO filters by tenant_id explicitly. Nothing here can reach another tenant's rows.
 */
import { isMailboxCategory } from "../courier/mailboxes.js";
import { randomUUID } from "node:crypto";
import type { Q } from "./db.js";
import {
  checkCategory, classify, knownCategories, withoutEntityShelves, learnFromMove, parsePlainRule, planBackfill, PLAIN_RULE_HELP, PRESETS, trailOf, trailSummary, UNSORTED, withRetry,
  type Filing, type MemoryItem, type RetryOptions, type Rule, type Rulebook,
} from "../librarian/index.js";
import { LimitError, fmtBytes, type Plan } from "./plans.js";

export const ENGINE_VERSION = "librarian-0.3.0+saas";

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

// ------------------------------------------------------------------ usage + limits
/**
 * Meters a call in usage_daily. There is no per-day call cap on any plan: the numbers are kept for the dashboard and
 * for abuse review. Plan limits are memories, stored bytes and typed rules (see saveMemory and TenantLibrarian.addRule).
 */
export async function countCall(q: Q, tenantId: string, kind: "call" | "save" = "call"): Promise<number> {
  const r = await q.query(
    `INSERT INTO usage_daily (tenant_id, day, calls, saves) VALUES ($1, CURRENT_DATE, 1, $2)
     ON CONFLICT (tenant_id, day) DO UPDATE SET calls = usage_daily.calls + 1, saves = usage_daily.saves + EXCLUDED.saves
     RETURNING calls`, [tenantId, kind === "save" ? 1 : 0]);
  return Number(r.rows[0].calls);
}

export async function usage(q: Q, tenantId: string): Promise<{ memories: number; bytes: number; calls_today: number; saves_today: number }> {
  const m = await q.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [tenantId]);
  const b = await q.query("SELECT bytes FROM tenant_storage WHERE tenant_id = $1", [tenantId]);
  const u = await q.query("SELECT calls, saves FROM usage_daily WHERE tenant_id = $1 AND day = CURRENT_DATE", [tenantId]);
  return { memories: m.rows[0].n, bytes: Number(b.rows[0]?.bytes ?? 0), calls_today: u.rows[0]?.calls ?? 0, saves_today: u.rows[0]?.saves ?? 0 };
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

export interface FullMessage {
  id: number;
  sender: string;
  created_at: string;
  conversation_name: string;
  text: string;
}

/**
 * Fetch one complete message by its stable id (the read_memory backing query),
 * scoped to the tenant both explicitly and by the caller's RLS transaction.
 * Returns null when the tenant has no message with that id — another tenant's
 * message is indistinguishable from a missing one.
 */
export async function getMessageById(q: Q, tenantId: string, id: number): Promise<FullMessage | null> {
  const r = await q.query(
    `SELECT m.id AS id, m.sender AS sender, m.created_at AS created_at, c.name AS conversation_name, m.text AS text
     FROM messages m JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1 AND m.id = $2`, [tenantId, id]);
  const x = r.rows[0];
  if (!x) return null;
  return { id: Number(x.id), sender: x.sender, created_at: iso(x.created_at), conversation_name: x.conversation_name, text: x.text ?? "" };
}

export interface SaveParams { content: string; source: string; category?: string; tags?: string[]; }

export async function saveMemory(q: Q, tenantId: string, plan: Plan, p: SaveParams) {
  const upgrade = plan.id === "free" ? " Upgrade to Personal, or export your memories." : " Export your memories, or contact support.";
  if (plan.maxMemories !== null) {
    const n = (await q.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [tenantId])).rows[0].n as number;
    if (n >= plan.maxMemories) {
      throw new LimitError(`Memory limit reached: the ${plan.name} plan holds ${plan.maxMemories.toLocaleString("en-US")} memories.${upgrade} Search, read and export still work.`, "memories");
    }
  }
  const source = p.source.trim().toLowerCase();
  const category = p.category?.trim();
  const notebook = category ? `Shared Memory — ${category}` : `Shared Memory — ${source}`;
  const tags = (p.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const text = tags.length ? `[tags: ${tags.join(", ")}]\n${p.content}` : p.content;

  // Stored bytes: one counter row per tenant, bumped here in the same transaction as the insert below. The upsert takes the
  // row lock, so concurrent saves are serialised and cannot jointly overshoot; throwing rolls the bump back with the save.
  const bumped = await q.query(
    `INSERT INTO tenant_storage (tenant_id, bytes) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET bytes = tenant_storage.bytes + EXCLUDED.bytes, updated_at = now() RETURNING bytes`,
    [tenantId, Buffer.byteLength(text, "utf8")]);
  if (Number(bumped.rows[0].bytes) > plan.maxBytes) {
    throw new LimitError(`Storage limit reached: the ${plan.name} plan holds ${fmtBytes(plan.maxBytes)} of memories.${upgrade} Search, read and export still work.`, "bytes");
  }

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
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class TenantLibrarian {
  /** `plan` is optional so callers without one (tests, tools) keep the full feature set; the hosted server always passes it. */
  constructor(private q: Q, private tenantId: string, private retry: RetryOptions = {}, private plan?: Plan) {}

  async rulebook(): Promise<Rulebook> {
    const r = await this.q.query("SELECT rulebook FROM librarian_settings WHERE tenant_id = $1 ORDER BY chosen_at DESC, id DESC LIMIT 1", [this.tenantId]);
    const id = r.rows[0]?.rulebook as string | undefined;
    const book = Object.values(PRESETS).find((b) => b.id === id) ?? PRESETS.D;
    // Plans without the people / places / companies shelves file with the same rulebook minus those shelves.
    return this.plan && !this.plan.features.entityShelves ? withoutEntityShelves(book) : book;
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

  /**
   * Runs `fn` inside a SAVEPOINT. The caller's tenant transaction also holds the saved memory: without the savepoint, one
   * failed filing statement would abort that whole transaction and lose the memory. Failed attempts roll back to the savepoint.
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      await this.q.query("SAVEPOINT librarian_op");
      try {
        const out = await fn();
        await this.q.query("RELEASE SAVEPOINT librarian_op");
        return out;
      } catch (err) {
        await this.q.query("ROLLBACK TO SAVEPOINT librarian_op").catch(() => {});
        throw err;
      }
    }, this.retry);
  }

  /** Never throws: a failed write is retried, then reported (stderr + `error`); the memory waits in the tray as "Not filed yet". */
  async fileSaved(item: MemoryItem): Promise<{ category: string; tags: string[]; explanation: string; recorded: boolean; error?: string }> {
    const f = classify(item, await this.rulebook(), await this.extraRules());
    try {
      await this.guarded(() => this.record(Number(item.id), f, "librarian"));
      return { category: f.category, tags: f.tags, explanation: f.explanation, recorded: true };
    } catch (err) {
      console.error(`[librarian] tenant ${this.tenantId}: could not record the filing of memory ${item.id} after retries (it stays in the unsorted tray as "Not filed yet"): ${errText(err)}`);
      return { category: f.category, tags: f.tags, explanation: f.explanation, recorded: false, error: errText(err) };
    }
  }

  /** The repair path: re-file this tenant's unsorted tray (filed as unsorted or never filed) with the CURRENT rules. */
  async refileUnsorted(limit = 200): Promise<{ examined: number; refiled: number; stillUnsorted: number }> {
    const [book, extra] = [await this.rulebook(), await this.extraRules()];
    const r = await this.q.query(
      `SELECT m.id, m.text, m.sender, c.name AS conv, (f.message_id IS NULL) AS never_filed
         FROM memory_unsorted u
         JOIN messages m ON m.id = u.message_id AND m.tenant_id = u.tenant_id
         LEFT JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id
         LEFT JOIN memory_current_filing f ON f.message_id = m.id AND f.tenant_id = m.tenant_id
        WHERE u.tenant_id = $1
        ORDER BY m.id DESC LIMIT $2`, [this.tenantId, Math.min(Math.max(limit, 1), 1000)]);
    const items: MemoryItem[] = r.rows.map((x) => ({ id: Number(x.id), text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    const current = new Map<string, string>(r.rows.filter((x) => !x.never_filed).map((x) => [String(x.id), UNSORTED]));
    const plan = planBackfill(items, current, book, extra);
    for (const f of plan.toWrite) await this.record(Number(f.itemId), f, "backfill");
    return { examined: plan.examined, refiled: plan.toWrite.filter((f) => f.category !== UNSORTED).length, stillUnsorted: plan.stillUnsorted };
  }

  private async refileSoft() {
    try {
      await this.q.query("SAVEPOINT librarian_refile");
      const out = await this.refileUnsorted();
      await this.q.query("RELEASE SAVEPOINT librarian_refile");
      return out;
    } catch (err) {
      await this.q.query("ROLLBACK TO SAVEPOINT librarian_refile").catch(() => {});
      return { error: errText(err) };
    }
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

  /** Which shelf, the deciding rule, and EVERY rule that matched (the full trail). */
  async explain(id: number) {
    const r = await this.q.query(
      "SELECT category, tags, rule_key, explanation, hits, filed_by, filed_at FROM memory_current_filing WHERE tenant_id = $1 AND message_id = $2", [this.tenantId, id]);
    if (r.rows[0]) {
      const { hits, ...rest } = r.rows[0];
      const matched_rules = trailOf(hits, rest.rule_key, rest.category);
      return { recorded: true, ...rest, filed_at: iso(rest.filed_at), matched_rules, trail_summary: trailSummary(matched_rules) };
    }
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const f = classify(item, await this.rulebook(), await this.extraRules());
    const matched_rules = trailOf(f.hits, f.winningRule, f.category);
    return { recorded: false, note: "Not recorded yet; this is how the Librarian would file it now.", category: f.category, tags: f.tags, rule_key: f.winningRule, explanation: f.explanation, matched_rules, trail_summary: trailSummary(matched_rules) };
  }

  private async knownShelves(book: Rulebook, extra: Rule[]) {
    const filed = (await this.q.query("SELECT DISTINCT category FROM memory_current_filing WHERE tenant_id = $1", [this.tenantId])).rows.map((x) => String(x.category));
    return knownCategories(book, extra, filed);
  }

  async move(id: number, toCategory: string, movedBy: string, opts: { confirmNewCategory?: boolean } = {}) {
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const [book, extra] = [await this.rulebook(), await this.extraRules()];
    const check = checkCategory(toCategory, await this.knownShelves(book, extra), opts.confirmNewCategory === true);
    if (!check.ok) return { moved: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
    toCategory = check.slug;
    const before = classify(item, book, extra);
    const ref = (await this.q.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 ORDER BY m.id DESC LIMIT 500",
      [this.tenantId])).rows.map((x) => ({ id: Number(x.id), text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    const { rule, note } = isMailboxCategory(toCategory) || isMailboxCategory(before.category)
      ? { rule: null, note: "Mailbox move recorded; no rule learned (moves into or out of for-<agent> mailboxes never teach the Librarian)." }
      : this.plan && !this.plan.features.learning
        ? { rule: null, note: "Moved. Learning from your moves is part of the Personal plan, so no rule was learned; you can still type a rule with add_rule." }
        : learnFromMove(item, toCategory, book, extra, ref);
    if (rule) await this.q.query("INSERT INTO librarian_rules (tenant_id, rule_key, layer, rule_json, created_by) VALUES ($1,$2,'learned',$3,$4)", [this.tenantId, rule.id, JSON.stringify(rule), movedBy]);
    await this.q.query("INSERT INTO memory_moves (tenant_id, message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5,$6)", [this.tenantId, id, before.category, toCategory, rule?.id ?? null, movedBy]);
    // Stored matches are refreshed: the rules that match NOW (including the one just learned) plus the hand move itself.
    const after = classify(item, book, rule ? [...extra, rule] : extra);
    const manualHit = { ruleId: "manual.move", layer: "manual" as const, category: toCategory, priority: 10000, matched: [`moved by ${movedBy}`], description: `You moved it to "${toCategory}" by hand.` };
    await this.record(id, { ...after, category: toCategory, winningRule: rule?.id ?? null, hits: [manualHit, ...after.hits], explanation: `Moved here by ${movedBy}. ${note}` }, "manual");
    const refiled = rule ? await this.refileSoft() : undefined;
    return { moved: true, from: before.category, to: toCategory, learned_rule: rule?.id ?? null, note, ...(refiled ? { refiled_unsorted: refiled } : {}) };
  }

  async addRule(sentence: string, createdBy: string, opts: { confirmNewCategory?: boolean } = {}) {
    const probe = parsePlainRule(sentence, "custom.probe");
    if (!probe) return { added: false, note: `I could not read that rule. ${PLAIN_RULE_HELP}` };
    const [book, extra] = [await this.rulebook(), await this.extraRules()];
    let category = probe.category;
    if (category) {
      const check = checkCategory(category, await this.knownShelves(book, extra), opts.confirmNewCategory === true);
      if (!check.ok) return { added: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
      category = check.slug;
    }
    // Unique id under concurrency: serialise rule creation per tenant for the rest of this transaction, then take max + 1.
    await this.q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`librarian_rule:${this.tenantId}`]);
    // Typed-rule cap. Counted under the lock above, so concurrent adds cannot jointly pass it. Only rules typed with add_rule
    // (layer custom) count; a rule that was replaced or disabled no longer appears in librarian_active_rules.
    if (this.plan && this.plan.maxTypedRules !== null) {
      const typed = (await this.q.query("SELECT count(*)::int AS n FROM librarian_active_rules WHERE tenant_id = $1 AND layer = 'custom'", [this.tenantId])).rows[0].n as number;
      if (typed >= this.plan.maxTypedRules) {
        throw new LimitError(`Rule limit reached: the ${this.plan.name} plan allows ${this.plan.maxTypedRules} typed rules. Upgrade to Personal for unlimited rules.`, "rules");
      }
    }
    const n = (await this.q.query(
      "SELECT COALESCE(MAX(substring(rule_key from 8)::int), 0) + 1 AS n FROM librarian_rules WHERE tenant_id = $1 AND rule_key ~ '^custom\\.[0-9]+$'", [this.tenantId])).rows[0].n as number;
    const rule = { ...parsePlainRule(sentence, `custom.${n}`)!, category };
    await this.q.query("INSERT INTO librarian_rules (tenant_id, rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,$2,'custom',$3,$4,$5)", [this.tenantId, rule.id, JSON.stringify(rule), sentence, createdBy]);
    const refiled = await this.refileSoft();
    return { added: true, rule_key: rule.id, category: rule.category, when: rule.when, refiled_unsorted: refiled };
  }
}
export { UNSORTED };

// ------------------------------------------------------------------ export / delete-all
// librarian_settings (the chosen rulebook) and usage_daily (fair-use metering) are kept.
const DATA_TABLES = ["agent_message_receipts", "agent_message_reads", "agent_directory", "agent_messages", "flags", "memory_moves", "memory_filings", "librarian_rules", "messages", "conversations", "projects"] as const;

export async function exportAll(q: Q, tenantId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of ["conversations", "messages", "projects", "memory_filings", "memory_moves", "librarian_rules", "librarian_settings", "flags", "usage_daily", "agent_messages", "agent_message_reads", "agent_message_receipts", "agent_directory"]) {
    const r = await q.query(`SELECT * FROM ${t} WHERE tenant_id = $1 ORDER BY 1`, [tenantId]);
    out[t] = r.rows;
  }
  return { format: "helmian-scribe-export", version: 1, tenant_id: tenantId, exported_at: new Date().toISOString(), tables: out };
}

/** Deletes every memory row for the tenant (keeps the account, billing and API keys). */
export async function deleteAll(q: Q, tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of DATA_TABLES) {
    const r = await q.query(`WITH d AS (DELETE FROM ${t} WHERE tenant_id = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [tenantId]);
    counts[t] = r.rows[0].n;
  }
  await q.query("UPDATE tenant_storage SET bytes = 0, updated_at = now() WHERE tenant_id = $1", [tenantId]);
  return counts;
}
