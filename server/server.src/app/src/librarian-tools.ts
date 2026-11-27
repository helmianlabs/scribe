/**
 * The Librarian inside the MCP server: files every saved memory and exposes the
 * unsorted tray, explanations, manual moves and plain-word rules.
 *
 * Append-only by design: every write is an INSERT, so the memory_rw role
 * (SELECT + INSERT) is enough. Reads use the read pool (read-only sessions).
 * If the Librarian tables are not installed yet (migration 001 not applied),
 * saving still works; the filing is computed and reported but not recorded.
 *
 * Failure handling (audit fix): a failed filing write is retried and then REPORTED
 * (stderr + `filing_error` in the tool answer), never swallowed. A memory that could not
 * be filed waits in the unsorted tray as "Not filed yet", and refileUnsorted() — run after
 * every new rule and every learned move — files it once the database answers again.
 */
import { isMailboxCategory } from "./courier/mailboxes.js";
import type pg from "pg";
import {
  applyIgnore, checkCategory, classify, classifyBatch, KnowledgeGraph, knownCategories, learnFromMove, parsePlainRule, planBackfill, PLAIN_RULE_HELP,
  presetsFor, stripTagLine, trailOf, trailSummary, UNSORTED, withRetry,
  type Filing, type MemoryItem, type Rule, type Rulebook,
} from "./librarian/index.js";
import { vocabFor } from "./librarian/presets.js";

/**
 * Word pack for this single-tenant server: generic by default (the same fresh start hosted tenants get);
 * LIBRARIAN_VOCAB=owner selects the original owner's pack (vocabOwner.ts) on the owner's own install.
 */
const packName = (explicit?: string) => explicit ?? process.env.LIBRARIAN_VOCAB;

export const ENGINE_VERSION = "librarian-0.3.0";
const NOT_INSTALLED = "The Librarian's tables are not installed in the database yet (migration 001_librarian.sql), so nothing can be recorded.";

function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Librarian {
  private graph: KnowledgeGraph;

  private presets: ReturnType<typeof presetsFor>;
  private projects: ReturnType<typeof vocabFor>["projects"];

  /** `opts.vocab` ('generic' | 'owner') overrides LIBRARIAN_VOCAB; the default is generic. */
  constructor(private read: pg.Pool, private write: pg.Pool, private retry: { sleep?: (ms: number) => Promise<void> } = {}, opts: { vocab?: string } = {}) {
    this.graph = new KnowledgeGraph(read, write);
    this.presets = presetsFor(packName(opts.vocab), "generic");
    this.projects = vocabFor(packName(opts.vocab), "generic").projects;
  }

  async rulebook(): Promise<Rulebook> {
    try {
      const r = await this.read.query("SELECT rulebook FROM librarian_settings ORDER BY chosen_at DESC, id DESC LIMIT 1");
      const id = r.rows[0]?.rulebook as string | undefined;
      return Object.values(this.presets).find((b) => b.id === id) ?? this.presets.D;
    } catch {
      return this.presets.D;
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

  private async recordBulk(filings: Filing[], filedBy: "librarian" | "manual" | "backfill") {
    const rows = filings.map((f) => ({ message_id: f.itemId, category: f.category, tags: f.tags, shape: f.shape, source: f.source, rulebook: f.rulebook, rule_key: f.winningRule, explanation: f.explanation, hits: f.hits }));
    await this.write.query(
      `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
       SELECT (x->>'message_id')::bigint, x->>'category', ARRAY(SELECT jsonb_array_elements_text(x->'tags')), x->>'shape', x->>'source',
              x->>'rulebook', x->>'rule_key', x->>'explanation', x->'hits', $2, $3
         FROM jsonb_array_elements($1::jsonb) AS x`,
      [JSON.stringify(rows), filedBy, ENGINE_VERSION],
    );
  }

  private projectNameForFiling(f: Filing): string | null {
    const PROJECTS = this.projects;
    for (const hit of f.hits) {
      const slug = /^(?:content\.project|content\.notebook|content\.project-context)\.(.+)$/.exec(hit.ruleId)?.[1];
      if (slug && PROJECTS[slug]) return PROJECTS[slug].name;
    }
    const categorySlug = f.category.replace(/^work\//, "");
    if (PROJECTS[categorySlug]) return PROJECTS[categorySlug].name;
    const tagSlug = f.tags.find((tag) => PROJECTS[tag]);
    return tagSlug ? PROJECTS[tagSlug].name : null;
  }

  /**
   * Build graph links for a filing that has just been recorded. The graph is
   * additive and fail-soft: migration 008_graph.sql may be absent (the builder reports
   * installed: false) and any other graph error is swallowed, so filing keeps
   * succeeding exactly as it did before the graph existed.
   * Free-text extraction runs over the Librarian's ignore-filtered text, so infrastructure
   * names the rulebook ignores never become entities.
   */
  private async linkFiled(item: MemoryItem, f: Filing, book?: Rulebook): Promise<void> {
    try {
      const b = book ?? (await this.rulebook());
      const extractText = applyIgnore(stripTagLine(item.text ?? ""), b).text;
      await this.graph.buildLinksForFiling({
        messageId: item.id,
        text: item.text ?? "",
        extractText,
        author: item.source ?? item.sender ?? null,
        projectName: this.projectNameForFiling(f),
        category: f.category,
        sourceKind: "message",
        sourceId: typeof item.id === "number" ? item.id : Number(item.id),
      });
    } catch {
      /* graph errors never fail a filing */
    }
  }

  /** Called right after save_memory commits. Never throws; a failed write is retried, then reported. */
  async fileSaved(item: MemoryItem): Promise<{ category: string; tags: string[]; explanation: string; recorded: boolean; error?: string }> {
    let f: Filing;
    let book: Rulebook;
    try {
      const [b, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
      book = b;
      f = classify(item, b, extra);
    } catch (err) {
      console.error(`[librarian] could not classify memory ${item.id}: ${msg(err)}`);
      return { category: UNSORTED, tags: [], explanation: `Librarian error: ${msg(err)}`, recorded: false, error: msg(err) };
    }
    let recorded = false;
    let error: string | undefined;
    try {
      await withRetry(() => this.record(item.id, f, "librarian"), this.retry);
      recorded = true;
    } catch (err) {
      if (!isMissingTable(err)) {
        error = msg(err);
        console.error(`[librarian] could not record the filing of memory ${item.id} after retries (it stays in the unsorted tray as "Not filed yet" until refileUnsorted runs): ${error}`);
      }
    }
    if (recorded) await this.linkFiled(item, f, book);
    return { category: f.category, tags: f.tags, explanation: f.explanation, recorded, ...(error ? { error } : {}) };
  }

  /**
   * The repair path. Re-classify everything in the unsorted tray (filed as unsorted OR never filed) with the
   * CURRENT rules and append a filing for each memory that now has a shelf. Append-only, bounded, safe to re-run.
   */
  async refileUnsorted(limit = 200): Promise<{ examined: number; refiled: number; stillUnsorted: number }> {
    const [book, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
    const r = await this.read.query(
      `SELECT m.id, m.text, m.sender, c.name AS conv, (f.message_id IS NULL) AS never_filed
         FROM memory_unsorted u
         JOIN messages m ON m.id = u.message_id
         LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
         LEFT JOIN memory_current_filing f ON f.message_id = m.id
        ORDER BY m.id DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 1000)]);
    const items: MemoryItem[] = r.rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    const current = new Map<string, string>(r.rows.filter((x) => !x.never_filed).map((x) => [String(x.id), UNSORTED]));
    const plan = planBackfill(items, current, book, extra);
    if (plan.toWrite.length) await withRetry(() => this.recordBulk(plan.toWrite, "backfill"), this.retry);
    const byId = new Map(items.map((i) => [String(i.id), i]));
    for (const f of plan.toWrite) if (f.category !== UNSORTED) { const it = byId.get(String(f.itemId)); if (it) await this.linkFiled(it, f, book); }
    return { examined: plan.examined, refiled: plan.toWrite.filter((f) => f.category !== UNSORTED).length, stillUnsorted: plan.stillUnsorted };
  }

  private async refileSoft() {
    try { return await this.refileUnsorted(); } catch (err) { return { error: msg(err) }; }
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

  /** Which shelf, the deciding rule, and EVERY rule that matched (the full trail). */
  async explain(id: number) {
    try {
      const r = await this.read.query(
        "SELECT category, tags, rule_key, explanation, hits, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1",
        [id],
      );
      if (r.rows[0]) {
        const { hits, ...rest } = r.rows[0];
        const matched_rules = trailOf(hits, rest.rule_key, rest.category);
        return { installed: true, recorded: true, ...rest, matched_rules, trail_summary: trailSummary(matched_rules) };
      }
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const f = classify(item, await this.rulebook(), await this.extraRules());
    const matched_rules = trailOf(f.hits, f.winningRule, f.category);
    return { recorded: false, note: "Not recorded yet; this is how the Librarian would file it now.", category: f.category, tags: f.tags, rule_key: f.winningRule, explanation: f.explanation, matched_rules, trail_summary: trailSummary(matched_rules) };
  }

  private async knownShelves(book: Rulebook, extra: Rule[]) {
    let filed: string[] = [];
    try { filed = (await this.read.query("SELECT DISTINCT category FROM memory_current_filing")).rows.map((x) => String(x.category)); } catch { /* tables missing */ }
    return knownCategories(book, extra, filed);
  }

  async move(id: number, toCategory: string, movedBy: string, opts: { confirmNewCategory?: boolean } = {}) {
    const item = await this.loadItem(id);
    if (!item) return { error: `No memory with id ${id}` };
    const [book, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
    const check = checkCategory(toCategory, await this.knownShelves(book, extra), opts.confirmNewCategory === true);
    if (!check.ok) return { moved: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
    toCategory = check.slug;
    const before = classify(item, book, extra);
    const ref = (await this.read.query(
      "SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500",
    )).rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
    // Moving a letter into a mailbox (for-<agent>) is addressing, not a topic decision:
    // learning trigger words from it taught rules like "navbar" -> for-muse. Record, don't learn.
    const { rule, note } = isMailboxCategory(toCategory) || isMailboxCategory(before.category)
      ? { rule: null, note: "Mailbox move recorded; no rule learned (moves into or out of for-<agent> mailboxes never teach the Librarian)." }
      : learnFromMove(item, toCategory, book, extra, ref);
    // The stored matches are refreshed: the rules that match NOW (including the one just learned) plus the hand move itself.
    const after = classify(item, book, rule ? [...extra, rule] : extra);
    const manualHit = { ruleId: "manual.move", layer: "manual" as const, category: toCategory, priority: 10000, matched: [`moved by ${movedBy}`], description: `You moved it to "${toCategory}" by hand.` };
    const filing: Filing = { ...after, category: toCategory, winningRule: rule?.id ?? null, hits: [manualHit, ...after.hits], explanation: `Moved here by ${movedBy}. ${note}` };
    try {
      if (rule) await this.write.query("INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)", [rule.id, JSON.stringify(rule), movedBy]);
      await this.write.query("INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)", [id, before.category, toCategory, rule?.id ?? null, movedBy]);
      await this.record(id, filing, "manual");
    } catch (err) {
      if (isMissingTable(err)) return { moved: false, note: NOT_INSTALLED };
      throw err;
    }
    await this.linkFiled(item, filing, book);
    const refiled = rule ? await this.refileSoft() : undefined;
    return { moved: true, from: before.category, to: toCategory, learned_rule: rule?.id ?? null, note, ...(refiled ? { refiled_unsorted: refiled } : {}) };
  }

  /** A rule id that cannot repeat even when two rules are added at the same instant: the database sequence, not a count. */
  private async nextRuleKey(): Promise<string> {
    const r = await this.write.query("SELECT nextval(pg_get_serial_sequence('librarian_rules','id')) AS n");
    return `custom.${r.rows[0].n}`;
  }

  async addRule(sentence: string, createdBy: string, opts: { confirmNewCategory?: boolean } = {}) {
    try {
      const probe = parsePlainRule(sentence, "custom.probe");
      if (!probe) return { added: false, note: `I could not read that rule. ${PLAIN_RULE_HELP}` };
      const [book, extra] = await Promise.all([this.rulebook(), this.extraRules()]);
      let category = probe.category;
      if (category) {
        const check = checkCategory(category, await this.knownShelves(book, extra), opts.confirmNewCategory === true);
        if (!check.ok) return { added: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
        category = check.slug;
      }
      const rule = { ...parsePlainRule(sentence, await this.nextRuleKey())!, category };
      await this.write.query("INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)", [rule.id, JSON.stringify(rule), sentence, createdBy]);
      const refiled = await this.refileSoft();
      return { added: true, rule_key: rule.id, category: rule.category, when: rule.when, refiled_unsorted: refiled };
    } catch (err) {
      if (isMissingTable(err)) return { added: false, note: NOT_INSTALLED };
      throw err;
    }
  }
}
