/**
 * The Librarian inside the MCP server: files every saved memory and exposes the
 * unsorted tray, explanations, manual moves and plain-word rules.
 *
 * Append-only by design: every write is an INSERT, so the memory_rw role
 * (SELECT + INSERT) is enough. Reads use the read pool (read-only sessions).
 * If the Librarian tables are not installed yet (migration 001 not applied),
 * saving still works; the filing is computed and reported but not recorded.
 */
import type pg from "pg";
import {
  classify, learnFromMove, parsePlainRule, PRESETS, UNSORTED,
  type Filing, type MemoryItem, type Rule, type Rulebook,
} from "./librarian/index.js";

export const ENGINE_VERSION = "librarian-0.2.0";
const NOT_INSTALLED = "The Librarian's tables are not installed in the database yet (migration 001_librarian.sql), so nothing can be recorded.";

function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

export class Librarian {
  constructor(private read: pg.Pool, private write: pg.Pool) {}

  async rulebook(): Promise<Rulebook> {
    try {
      const r = await this.read.query("SELECT rulebook FROM librarian_settings ORDER BY chosen_at DESC, id DESC LIMIT 1");
      const id = r.rows[0]?.rulebook as string | undefined;
      return Object.values(PRESETS).find((b) => b.id === id) ?? PRESETS.D;
    } catch {
      return PRESETS.D;
    }
  }

  async extraRules(): Promise<Rule[]> {
    try {
      const r = await this.read.query("SELECT rule_key, layer, rule_json FROM librarian_active_rules");
      return r.rows.map((x) => ({ ...x.rule_json, id: x.rule_key, layer: x.layer }));
    } catch {
      return [];
    }
  }

  private async record(messageId: number | string, f: Filing, filedBy: "librarian" | "manual" | "backfill") {
    await this.write.query(
      `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [messageId, f.category, f.tags, f.shape, f.source, f.rulebook, f.winningRule, f.explanation, JSON.stringify(f.hits), filedBy, ENGINE_VERSION],
    );
  }

  /** Called right after save_memory commits. Never throws. */
  async fileSaved(item: MemoryItem): Promise<{ category: string; tags: string[]; explanation: string; recorded: boolean }> {
    try {
      const [book, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
      const f = classify(item, book, extra);
      let recorded = false;
      try { await this.record(item.id, f, "librarian"); recorded = true; } catch { /* tables missing or transient: stays in the tray view */ }
      return { category: f.category, tags: f.tags, explanation: f.explanation, recorded };
    } catch (err) {
      return { category: UNSORTED, tags: [], explanation: `Librarian error: ${err instanceof Error ? err.message : String(err)}`, recorded: false };
    }
  }

  async listUnsorted(limit: number) {
    try {
      const r = await this.read.query(
        "SELECT message_id, created_at, preview, why FROM memory_unsorted ORDER BY created_at DESC NULLS LAST LIMIT $1",
        [Math.min(Math.max(limit, 1), 100)],
      );
      return { installed: true, items: r.rows };
    } catch (err) {
      if (isMissingTable(err)) return { installed: false, note: NOT_INSTALLED, items: [] };
      throw err;
    }
  }

  private async loadItem(id: number): Promise<MemoryItem | null> {
    const r = await this.read.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid WHERE m.id = $1",
      [id],
    );
    const x = r.rows[0];
    return x ? { id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv } : null;
  }

  async explain(id: number) {
    try {
      const r = await this.read.query(
        "SELECT category, tags, rule_key, explanation, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1",
        [id],
      );
      if (r.rows[0]) return { installed: true, recorded: true, ...r.rows[0] };
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const f = classify(item, await this.rulebook(), await this.extraRules());
    return { recorded: false, note: "Not recorded yet; this is how the Librarian would file it now.", category: f.category, tags: f.tags, rule_key: f.winningRule, explanation: f.explanation };
  }

  async move(id: number, toCategory: string, movedBy: string) {
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const [book, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
    const before = classify(item, book, extra);
    const ref = (await this.read.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500",
    )).rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    const { rule, note } = learnFromMove(item, toCategory, book, extra, ref);
    try {
      if (rule) await this.write.query("INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)", [rule.id, JSON.stringify(rule), movedBy]);
      await this.write.query("INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)", [id, before.category, toCategory, rule?.id ?? null, movedBy]);
      await this.record(id, { ...before, category: toCategory, winningRule: rule?.id ?? null, explanation: `Moved here by ${movedBy}. ${note}` }, "manual");
    } catch (err) {
      if (isMissingTable(err)) return { moved: false, note: NOT_INSTALLED };
      throw err;
    }
    return { moved: true, from: before.category, to: toCategory, learned_rule: rule?.id ?? null, note };
  }

  async addRule(sentence: string, createdBy: string) {
    try {
      const n = (await this.read.query("SELECT count(*)::int AS n FROM librarian_rules WHERE layer = 'custom'")).rows[0].n as number;
      const rule = parsePlainRule(sentence, `custom.${n + 1}`);
      if (!rule) return { added: false, note: 'I could not read that rule. Try: "anything mentioning X goes in Y".' };
      await this.write.query("INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)", [rule.id, JSON.stringify(rule), sentence, createdBy]);
      return { added: true, rule_key: rule.id, category: rule.category, when: rule.when };
    } catch (err) {
      if (isMissingTable(err)) return { added: false, note: NOT_INSTALLED };
      throw err;
    }
  }
}
