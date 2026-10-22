/**
 * Backfill: file every existing message once (filed_by='backfill'). APPEND-ONLY INSERTs into memory_filings.
 * SAM'S CALL — run only after 001_librarian.sql is applied. Uses DATABASE_WRITE_URL (memory_rw).
 *   DATABASE_WRITE_URL=... npx tsx scripts/backfill.ts --preset D [--limit N]
 * Skips messages that already have a filing, so it is safe to re-run.
 * Undo: DELETE FROM memory_filings WHERE filed_by='backfill' (as neondb_owner), or run 001_librarian.down.sql.
 */
import pg from 'pg';
import { classify, PRESETS } from '../src/librarian/index.ts';
import { recordFiling } from '../src/server/librarian-store.ts';
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const book = PRESETS[(arg('--preset') ?? 'D').toUpperCase() as keyof typeof PRESETS];
const limit = Number(arg('--limit') ?? 1e9);
const url = process.env.DATABASE_WRITE_URL; if (!url) throw new Error('DATABASE_WRITE_URL not set');
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
let done = 0, lastId = 0;
while (done < limit) {
  const r = await db.query(`SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m
      LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
      WHERE m.id > $1 AND NOT EXISTS (SELECT 1 FROM memory_filings f WHERE f.message_id = m.id)
      ORDER BY m.id LIMIT 500`, [lastId]);
  if (!r.rows.length) break;
  for (const x of r.rows) {
    await recordFiling(db, x.id, classify({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }, book), 'backfill');
    lastId = x.id; if (++done >= limit) break;
  }
  console.log(`filed ${done}`);
}
await db.end();
console.log(`backfill complete: ${done} messages filed with ${book.name}`);
