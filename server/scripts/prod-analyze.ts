/**
 * READ-ONLY full-archive analysis, meant to run INSIDE the claude-memory-mcp container
 * (uses its DATABASE_URL, the read role, in a READ ONLY transaction). Prints aggregates only,
 * plus short unsorted previews when SHOW=n is set. Never prints connection details.
 */
import pg from 'pg';
import { classify, classifyBatch, distribution, PRESETS, type MemoryItem } from '../src/librarian/index.ts';
const book = PRESETS[(process.env.PRESET ?? 'D') as 'A' | 'B' | 'C' | 'D'];
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('BEGIN TRANSACTION READ ONLY');
const r = await c.query(`SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id`);
await c.query('ROLLBACK'); await c.end();
const items: MemoryItem[] = r.rows.map((x) => ({ id: x.id, text: x.text ?? '', sender: x.sender, conversationName: x.conv }));
const filings = process.env.NOCONTEXT ? items.map((i) => classify(i, book)) : classifyBatch(items, book);
const dist = distribution(filings);
const out: any = { preset: book.id, total: items.length, distribution: dist };
const uns = filings.map((f, i) => [f, items[i]] as const).filter(([f]) => f.category === 'unsorted');
const buckets: Record<string, number> = { '<=20': 0, '21-80': 0, '81-300': 0, '>300': 0 };
for (const [, it] of uns) { const n = it.text.length; buckets[n <= 20 ? '<=20' : n <= 80 ? '21-80' : n <= 300 ? '81-300' : '>300']++; }
out.unsortedByLength = buckets;
const convs = new Map<string, number>();
for (const [, it] of uns) convs.set(it.conversationName ?? '(none)', (convs.get(it.conversationName ?? '(none)') ?? 0) + 1);
out.unsortedTopConversations = [...convs].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOPCONV ?? 40));
const STOP = new Set('that this with have what your from will just they there about would like need want which when then them their make sure here also some into want could should been were being going know think more only look does done than over yeah okay right good thing things time first still because something really back where these those other very doing much even well made work working said before after again want sounds great'.split(' '));
const words = new Map<string, number>();
for (const [, it] of uns) if (it.text.length > 80) for (const w of new Set(it.text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])) if (!STOP.has(w)) words.set(w, (words.get(w) ?? 0) + 1);
out.unsortedTopWords = [...words].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOPWORDS ?? 120)).map(([w, n]) => `${w}:${n}`).join(' ');
const rules = new Map<string, number>();
for (const f of filings) rules.set(f.winningRule ?? '(unsorted)', (rules.get(f.winningRule ?? '(unsorted)') ?? 0) + 1);
out.topRules = [...rules].sort((a, b) => b[1] - a[1]).slice(0, 25);
if (process.env.SHOW) out.unsortedPreviews = uns.filter(([, it]) => it.text.length > 80).filter((_, i) => i % 97 === 0).slice(0, Number(process.env.SHOW)).map(([, it]) => `${it.conversationName?.slice(0, 50)} | ${it.text.replace(/\s+/g, ' ').slice(0, 110)}`);
console.log(JSON.stringify(out, null, 1));
