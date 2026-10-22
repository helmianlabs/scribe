/**
 * Dry run: classify memories and report the category distribution + unsorted %. READ ONLY.
 *
 *   npm run dry-run -- --fixture fixtures/synthetic-sample.jsonl [--preset D]
 *   DATABASE_URL=<read-only url to claude_memory> npm run dry-run -- --sample 2000 [--preset D]
 *
 * Against a database it opens a READ ONLY transaction (Postgres refuses any write inside it),
 * reads a random sample of messages, and never prints message text unless --show is passed.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { classifyAll, distribution, PRESETS, type MemoryItem } from '../src/librarian/index.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const presetKey = (arg('--preset') ?? 'D').toUpperCase() as keyof typeof PRESETS;
const book = PRESETS[presetKey];
if (!book) throw new Error(`unknown preset ${presetKey}`);

async function load(): Promise<{ items: MemoryItem[]; origin: string }> {
  const fixture = arg('--fixture');
  if (fixture) {
    const items = readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { items, origin: `fixture ${fixture}` };
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (read-only) or pass --fixture');
  const n = Number(arg('--sample') ?? 2000);
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const total = (await client.query('SELECT count(*)::int n FROM messages')).rows[0].n;
    const r = await client.query(
      `SELECT m.id, m.text, m.sender, m.created_at, c.name AS conversation_name
         FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
        ORDER BY md5(m.id::text) LIMIT $1`, [n]); // deterministic pseudo-random sample
    await client.query('ROLLBACK');
    return {
      items: r.rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conversation_name, createdAt: x.created_at })),
      origin: `database sample ${r.rows.length} of ${total} messages`,
    };
  } finally { await client.end(); }
}

const { items, origin } = await load();
const filings = classifyAll(items, book);
const dist = distribution(filings);
const unsorted = dist.find((d) => d.category === 'unsorted');
console.log(`Librarian dry run — ${book.name} — ${origin}`);
console.log(`items: ${items.length}   unsorted: ${unsorted?.count ?? 0} (${unsorted?.pct ?? 0}%)`);
for (const d of dist) console.log(`  ${d.category.padEnd(26)} ${String(d.count).padStart(6)}  ${d.pct}%`);
const byRule = new Map<string, number>();
for (const f of filings) byRule.set(f.winningRule ?? '(unsorted)', (byRule.get(f.winningRule ?? '(unsorted)') ?? 0) + 1);
console.log('top rules:');
for (const [r, c] of [...byRule].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${r.padEnd(34)} ${c}`);
if (args.includes('--show')) for (const f of filings) console.log(`[${f.itemId}] ${f.category} :: ${f.explanation}`);
