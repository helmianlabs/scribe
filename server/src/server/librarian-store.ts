/**
 * Glue between the MCP server and the Librarian. Append-only, so it works with memory_rw (SELECT + INSERT).
 * Call fileMessage() right after save_memory inserts its message row.
 */
import { classify, PRESETS, type MemoryItem, type Rule, type Rulebook, type Filing } from '../librarian/index.ts';

export const ENGINE_VERSION = 'librarian-0.1.0';

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

/** File one saved memory. Never throws into the caller's save path: a filing failure leaves it in the unsorted tray view. */
export async function fileMessage(db: Queryable, item: MemoryItem): Promise<Filing | null> {
  try {
    const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
    const f = classify(item, book, extra);
    await recordFiling(db, item.id, f, 'librarian');
    return f;
  } catch {
    return null;
  }
}

// ---------- MCP tool handlers (append-only; safe for memory_rw) ----------
import { learnFromMove, parsePlainRule } from '../librarian/index.ts';

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

export async function explainFiling(db: Queryable, messageId: number | string) {
  const r = await db.query('SELECT category, tags, rule_key, explanation, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1', [messageId]);
  return r.rows[0] ?? { category: 'unsorted', explanation: 'Not filed yet; it is in the unsorted tray.' };
}

/** Manual move. Records the move, files it, and learns a trigger when a safe one exists. */
export async function moveMemory(db: Queryable, messageId: number | string, toCategory: string, movedBy: string) {
  const item = await loadItem(db, messageId);
  if (!item) throw new Error(`No memory with id ${messageId}`);
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const before = classify(item, book, extra);
  const ref = (await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500`,
  )).rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
  const { rule, note } = learnFromMove(item, toCategory, book, extra, ref);
  if (rule) {
    await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)`, [rule.id, JSON.stringify(rule), movedBy]);
  }
  await db.query(`INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)`,
    [messageId, before.category, toCategory, rule?.id ?? null, movedBy]);
  await recordFiling(db, messageId, { ...before, category: toCategory, winningRule: rule?.id ?? null, explanation: `Moved here by ${movedBy}. ${note}` }, 'manual');
  return { from: before.category, to: toCategory, learned: rule?.id ?? null, note };
}

export async function addPlainRule(db: Queryable, sentence: string, createdBy: string) {
  const n = (await db.query('SELECT count(*)::int n FROM librarian_rules WHERE layer = $1', ['custom'])).rows[0].n;
  const rule = parsePlainRule(sentence, `custom.${n + 1}`);
  if (!rule) return { ok: false, note: 'I could not read that rule. Try: "anything mentioning X goes in Y".' };
  await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)`,
    [rule.id, JSON.stringify(rule), sentence, createdBy]);
  return { ok: true, rule };
}

export const LIBRARIAN_TOOLS = [
  { name: 'list_unsorted', scope: 'memory.read', description: 'List memories in the unsorted tray (nothing the Librarian could file).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } },
  { name: 'explain_filing', scope: 'memory.read', description: 'Say which shelf a memory is on and the exact rule that put it there.', inputSchema: { type: 'object', properties: { message_id: { type: 'integer' } }, required: ['message_id'] } },
  { name: 'move_memory', scope: 'memory.write', description: 'Move a memory to another shelf. The Librarian may learn a trigger word from the move.', inputSchema: { type: 'object', properties: { message_id: { type: 'integer' }, to_category: { type: 'string' }, source: { type: 'string' } }, required: ['message_id', 'to_category', 'source'] } },
  { name: 'add_rule', scope: 'memory.write', description: 'Add a plain-word filing rule, e.g. "anything mentioning invoices goes in money".', inputSchema: { type: 'object', properties: { rule: { type: 'string' }, source: { type: 'string' } }, required: ['rule', 'source'] } },
] as const;
