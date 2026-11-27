/**
 * Glue between the MCP server and the Librarian. Append-only, so it works with memory_rw (SELECT + INSERT).
 * Call fileMessage() right after save_memory inserts its message row.
 */
import {
  checkCategory, classify, knownCategories, learnFromMove, normaliseCategory, parsePlainRule, planBackfill, PLAIN_RULE_HELP, PRESETS, trailOf, trailSummary, UNSORTED, withRetry,
  type Filing, type MemoryItem, type RetryOptions, type Rule, type Rulebook,
} from '../librarian/index.ts';

export const ENGINE_VERSION = 'librarian-0.3.0';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function activeRulebook(db: Queryable): Promise<Rulebook> {
  const r = await db.query('SELECT rulebook FROM librarian_settings ORDER BY chosen_at DESC, id DESC LIMIT 1');
  const id: string = r.rows[0]?.rulebook ?? 'preset-d';
  return Object.values(PRESETS).find((b) => b.id === id) ?? PRESETS.D;
}

export async function activeExtraRules(db: Queryable): Promise<Rule[]> {
  const r = await db.query('SELECT rule_key, layer, rule_json FROM librarian_active_rules');
  return r.rows.map((x) => ({ ...x.rule_json, id: x.rule_key, layer: x.layer }));
}

export async function recordFiling(db: Queryable, messageId: number | string, f: Filing, filedBy: 'librarian' | 'manual' | 'backfill') {
  await db.query(
    `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [messageId, f.category, f.tags, f.shape, f.source, f.rulebook, f.winningRule, f.explanation, JSON.stringify(f.hits), filedBy, ENGINE_VERSION],
  );
}

export interface FileOptions {
  retry?: RetryOptions;
  /** Called with the final error when every retry failed. Default: log to stderr (never silent). */
  onError?: (err: unknown, item: MemoryItem) => void;
}

/**
 * File one saved memory. Never throws into the caller's save path. A failed write is RETRIED (three tries with a
 * short pause), and if it still fails the error is reported through `onError` (default: stderr) instead of being
 * swallowed. The memory then sits in the unsorted tray as "Not filed yet", and refileUnsorted() (also run after
 * every new rule) files it as soon as the database answers again.
 */
export async function fileMessage(db: Queryable, item: MemoryItem, opts: FileOptions = {}): Promise<Filing | null> {
  try {
    const f = await withRetry(async () => {
      const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
      const filing = classify(item, book, extra);
      await recordFiling(db, item.id, filing, 'librarian');
      return filing;
    }, opts.retry);
    return f;
  } catch (err) {
    (opts.onError ?? ((e, it) => console.error(`[librarian] could not file memory ${it.id}: ${e instanceof Error ? e.message : String(e)}`)))(err, item);
    return null;
  }
}

export interface RefileResult { examined: number; refiled: number; stillUnsorted: number }

/**
 * The repair path. Re-classify everything in the unsorted tray (filed as "unsorted" OR never filed) with the CURRENT
 * rules (preset + custom + learned) and append a new filing for each memory that now has a shelf.
 * Append-only (INSERT), safe to re-run, bounded by `limit`. Run automatically after a rule is added.
 */
export async function refileUnsorted(db: Queryable, limit = 200): Promise<RefileResult> {
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const r = await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv, (f.message_id IS NULL) AS never_filed
       FROM memory_unsorted u
       JOIN messages m ON m.id = u.message_id
       LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
       LEFT JOIN memory_current_filing f ON f.message_id = m.id
      ORDER BY m.id DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 1000)]);
  const items = r.rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
  const current = new Map<string, string>(r.rows.filter((x) => !x.never_filed).map((x) => [String(x.id), UNSORTED]));
  const plan = planBackfill(items, current, book, extra);
  // Never-filed memories that still match nothing get an "unsorted" filing too, so the tray says why.
  const toWrite = plan.toWrite;
  if (toWrite.length) await recordFilingsBulk(db, toWrite, 'backfill');
  return { examined: plan.examined, refiled: toWrite.filter((f) => f.category !== UNSORTED).length, stillUnsorted: plan.stillUnsorted };
}

// ---------- MCP tool handlers (append-only; safe for memory_rw) ----------

async function loadItem(db: Queryable, messageId: number | string): Promise<MemoryItem | null> {
  const r = await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid WHERE m.id = $1`,
    [messageId],
  );
  const x = r.rows[0];
  return x ? { id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv } : null;
}

export async function listUnsorted(db: Queryable, limit = 20) {
  const r = await db.query('SELECT message_id, created_at, preview, why FROM memory_unsorted ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 100)]);
  return r.rows;
}

/** Which shelf a memory is on, the rule that decided it, and EVERY rule that matched (the full trail). */
export async function explainFiling(db: Queryable, messageId: number | string) {
  const r = await db.query('SELECT category, tags, rule_key, explanation, hits, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1', [messageId]);
  const row = r.rows[0];
  if (!row) return { category: UNSORTED, explanation: 'Not filed yet; it is in the unsorted tray.', matched_rules: [], trail_summary: 'No rule matched.' };
  const { hits, ...rest } = row;
  const matched_rules = trailOf(hits, row.rule_key, row.category);
  return { ...rest, matched_rules, trail_summary: trailSummary(matched_rules) };
}

async function knownShelves(db: Queryable, book: Rulebook, extra: Rule[]): Promise<Set<string>> {
  const filed = (await db.query('SELECT DISTINCT category FROM memory_current_filing')).rows.map((x) => String(x.category));
  return knownCategories(book, extra, filed);
}

const MAILBOX_MOVE = /^for-[a-z0-9][a-z0-9-]*$/;

export interface MoveOptions { confirmNewCategory?: boolean }
export interface MoveOutcome { moved: boolean; from?: string; to?: string; learned?: string | null; note: string; needs_confirmation?: boolean; did_you_mean?: string[]; refiled_unsorted?: unknown }

/** Manual move. Records the move, refreshes the stored rule matches, learns a trigger when a safe one exists, then re-files the tray. */
export async function moveMemory(db: Queryable, messageId: number | string, toCategory: string, movedBy: string, opts: MoveOptions = {}): Promise<MoveOutcome> {
  const item = await loadItem(db, messageId);
  if (!item) throw new Error(`No memory with id ${messageId}`);
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const check = checkCategory(toCategory, await knownShelves(db, book, extra), opts.confirmNewCategory === true);
  if (!check.ok) return { moved: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
  toCategory = check.slug;
  const before = classify(item, book, extra);
  const ref = (await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500`,
  )).rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
  // Moving a letter into / out of a for-<agent> mailbox is addressing, not a topic decision: record, never learn.
  const { rule, note } = MAILBOX_MOVE.test(toCategory) || MAILBOX_MOVE.test(before.category)
    ? { rule: null, note: 'Mailbox move recorded; no rule learned (moves into or out of for-<agent> mailboxes never teach the Librarian).' }
    : learnFromMove(item, toCategory, book, extra, ref);
  if (rule) {
    await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)`, [rule.id, JSON.stringify(rule), movedBy]);
  }
  await db.query(`INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)`,
    [messageId, before.category, toCategory, rule?.id ?? null, movedBy]);
  // Stored matches are refreshed: the rules that match NOW (including the one just learned), plus the hand move itself.
  const after = classify(item, book, rule ? [...extra, rule] : extra);
  const manualHit = { ruleId: 'manual.move', layer: 'manual' as const, category: toCategory, priority: 10000, matched: [`moved by ${movedBy}`], description: `You moved it to "${toCategory}" by hand.` };
  await recordFiling(db, messageId, { ...after, category: toCategory, winningRule: rule?.id ?? null, hits: [manualHit, ...after.hits], explanation: `Moved here by ${movedBy}. ${note}` }, 'manual');
  const refile = rule ? await refileUnsorted(db).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })) : undefined;
  return { moved: true, from: before.category, to: toCategory, learned: rule?.id ?? null, note, ...(refile ? { refiled_unsorted: refile } : {}) };
}

export interface AddRuleOptions { confirmNewCategory?: boolean }
export interface AddRuleOutcome { ok: boolean; rule?: Rule; note?: string; needs_confirmation?: boolean; did_you_mean?: string[]; refiled_unsorted?: unknown }

/** A rule id that cannot repeat, even when two rules are added at the same instant (database sequence, not a count). */
async function nextRuleKey(db: Queryable): Promise<string> {
  const r = await db.query(`SELECT nextval(pg_get_serial_sequence('librarian_rules','id')) AS n`);
  return `custom.${r.rows[0].n}`;
}

export async function addPlainRule(db: Queryable, sentence: string, createdBy: string, opts: AddRuleOptions = {}): Promise<AddRuleOutcome> {
  const probe = parsePlainRule(sentence, 'custom.probe');
  if (!probe) return { ok: false, note: `I could not read that rule. ${PLAIN_RULE_HELP}` };
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  if (probe.category) {
    const check = checkCategory(probe.category, await knownShelves(db, book, extra), opts.confirmNewCategory === true);
    if (!check.ok) return { ok: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
    probe.category = check.slug;
  }
  const rule = { ...parsePlainRule(sentence, await nextRuleKey(db))!, category: probe.category };
  await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)`,
    [rule.id, JSON.stringify(rule), sentence, createdBy]);
  const refile = await refileUnsorted(db).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { ok: true, rule, refiled_unsorted: refile };
}

export const LIBRARIAN_TOOLS = [
  { name: 'list_unsorted', scope: 'memory.read', description: 'List memories in the unsorted tray (nothing the Librarian could file).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } },
  { name: 'explain_filing', scope: 'memory.read', description: 'Say which shelf a memory is on and the exact rule that put it there.', inputSchema: { type: 'object', properties: { message_id: { type: 'integer' } }, required: ['message_id'] } },
  { name: 'move_memory', scope: 'memory.write', description: 'Move a memory to another shelf. The Librarian may learn a trigger word from the move.', inputSchema: { type: 'object', properties: { message_id: { type: 'integer' }, to_category: { type: 'string' }, source: { type: 'string' }, confirm_new_category: { type: 'boolean', description: 'Set true to create a brand-new shelf; otherwise unknown shelf names are refused.' } }, required: ['message_id', 'to_category', 'source'] } },
  { name: 'add_rule', scope: 'memory.write', description: 'Add a plain-word filing rule, e.g. "anything mentioning invoices goes in money".', inputSchema: { type: 'object', properties: { rule: { type: 'string' }, source: { type: 'string' }, confirm_new_category: { type: 'boolean', description: 'Set true to create a brand-new shelf; otherwise unknown shelf names are refused.' } }, required: ['rule', 'source'] } },
] as const;

/** Bulk append filings (one round trip per batch). Used by the backfill. */
export async function recordFilingsBulk(db: Queryable, filings: Filing[], filedBy: 'librarian' | 'manual' | 'backfill') {
  const rows = filings.map((f) => ({ message_id: f.itemId, category: f.category, tags: f.tags, shape: f.shape, source: f.source, rulebook: f.rulebook, rule_key: f.winningRule, explanation: f.explanation, hits: f.hits }));
  await db.query(
    `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
     SELECT (x->>'message_id')::bigint, x->>'category', ARRAY(SELECT jsonb_array_elements_text(x->'tags')), x->>'shape', x->>'source',
            x->>'rulebook', x->>'rule_key', x->>'explanation', x->'hits', $2, $3
       FROM jsonb_array_elements($1::jsonb) AS x`,
    [JSON.stringify(rows), filedBy, ENGINE_VERSION],
  );
}
