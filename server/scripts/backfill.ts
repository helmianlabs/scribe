/**
 * Backfill: file every message that has no filing yet (filed_by='backfill'), using the same
 * engine as the server plus the conversation context layer. APPEND-ONLY (INSERT only), safe to re-run.
 * Run only after 001_librarian.sql is applied. Uses DATABASE_WRITE_URL (memory_rw).
 *   DATABASE_WRITE_URL=... npx tsx scripts/backfill.ts --preset D [--dry]
 *   --refile 1,2,3   also append a fresh filing for these already-filed ids (e.g. ones the live server
 *                    filed under older rules). Older rows are kept; the newest row is the current filing.
 * Undo: DELETE FROM memory_filings WHERE filed_by = 'backfill';   (needs DELETE, i.e. neondb_owner;
 * memory_rw has INSERT + SELECT only). Messages are never touched; the undo also drops --refile rows,
 * so any earlier live filing becomes current again.
 */
import pg from 'pg';
import { classifyBatch, distribution, PRESETS } from '../src/librarian/index.ts';
import { recordFilingsBulk } from '../src/server/librarian-store.ts';
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const book = PRESETS[(arg('--preset') ?? 'D').toUpperCase() as keyof typeof PRESETS];
const url = process.env.DATABASE_WRITE_URL; if (!url) throw new Error('DATABASE_WRITE_URL not set');
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
const r = await db.query(`SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m
  LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id`);
const done = new Set((await db.query('SELECT DISTINCT message_id FROM memory_filings')).rows.map((x) => String(x.message_id)));
const items = r.rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
const refile = new Set((arg('--refile') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const filings = classifyBatch(items, book).filter((f) => !done.has(String(f.itemId)) || refile.has(String(f.itemId)));
console.log(`to file: ${filings.length} (already filed: ${done.size}, re-filing: ${refile.size})`);
if (!args.includes('--dry')) {
  for (let i = 0; i < filings.length; i += 1000) {
    await recordFilingsBulk(db, filings.slice(i, i + 1000), 'backfill');
    console.log(`filed ${Math.min(i + 1000, filings.length)}`);
  }
}
for (const d of distribution(filings)) console.log(`  ${d.category.padEnd(24)} ${d.count}  ${d.pct}%`);
await db.end();
