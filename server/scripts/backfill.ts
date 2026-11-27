/**
 * Backfill / repair: file messages with the SAME rules the live server uses (the chosen rulebook + every active
 * custom and learned rule) plus the conversation context layer. APPEND-ONLY (INSERT only), safe to re-run.
 *   - never filed             -> filed (filed_by='backfill')
 *   - sitting in the unsorted tray -> re-filed if a rule now puts it on a real shelf
 *   - already on a real shelf -> left alone, unless listed with --refile
 * Run only after 001_librarian.sql is applied. Uses DATABASE_WRITE_URL (memory_rw).
 *   DATABASE_WRITE_URL=... npx tsx scripts/backfill.ts [--dry] [--preset D] [--refile 1,2,3]
 *   --dry            print what would be written and the shelf distribution; write nothing (do this first)
 *   --preset X       use preset A-D instead of the rulebook chosen in the database
 *   --refile 1,2,3   also append a fresh filing for these already-filed ids. Older rows are kept; the newest row is current.
 * Undo: DELETE FROM memory_filings WHERE filed_by = 'backfill';   (needs DELETE, i.e. the table owner;
 * memory_rw has INSERT + SELECT only). Messages are never touched; the undo also drops --refile rows,
 * so any earlier live filing becomes current again.
 * This script is never run by the server or by CI; a person runs it, on purpose.
 */
import pg from 'pg';
import { distribution, planBackfill, PRESETS } from '../src/librarian/index.ts';
import { activeExtraRules, activeRulebook, recordFilingsBulk } from '../src/server/librarian-store.ts';
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const url = process.env.DATABASE_WRITE_URL; if (!url) throw new Error('DATABASE_WRITE_URL not set');
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
const presetArg = arg('--preset');
const book = presetArg ? PRESETS[presetArg.toUpperCase() as keyof typeof PRESETS] : await activeRulebook(db);
if (!book) throw new Error(`unknown preset ${presetArg}`);
const extra = await activeExtraRules(db);
const r = await db.query(`SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m
  LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id`);
const current = new Map<string, string>((await db.query('SELECT message_id, category FROM memory_current_filing')).rows.map((x) => [String(x.message_id), String(x.category)]));
const items = r.rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
const force = new Set((arg('--refile') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const plan = planBackfill(items, current, book, extra, force);
console.log(`rulebook ${book.id}; rules: ${book.rules.length} built-in + ${extra.length} custom/learned`);
console.log(`examined ${plan.examined}: to write ${plan.toWrite.length} (new ${plan.newlyFiled}, re-filed from unsorted ${plan.refiledUnsorted}, forced ${plan.forced}); left alone ${plan.skipped}; still unsorted ${plan.stillUnsorted}`);
if (!args.includes('--dry')) {
  for (let i = 0; i < plan.toWrite.length; i += 1000) {
    await recordFilingsBulk(db, plan.toWrite.slice(i, i + 1000), 'backfill');
    console.log(`filed ${Math.min(i + 1000, plan.toWrite.length)}`);
  }
} else console.log('(dry run: nothing written)');
for (const d of distribution(plan.toWrite)) console.log(`  ${d.category.padEnd(24)} ${d.count}  ${d.pct}%`);
await db.end();
