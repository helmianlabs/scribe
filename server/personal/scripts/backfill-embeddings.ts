/**
 * Embed existing memories for meaning-based search (only useful with SCRIBE_EMBEDDINGS=local and p002 applied).
 * Insert-only, resumable, re-runnable. NOT run by anything automatically.
 *   DATABASE_URL=... DATABASE_WRITE_URL=... npx tsx scripts/backfill-embeddings.ts [--batch 200] [--max 100000]
 */
import pg from "pg";
import { localEmbedder, backfillEmbeddings } from "../src/embeddings.js";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const read = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
const write = new pg.Pool({ connectionString: process.env.DATABASE_WRITE_URL, max: 1, ssl: { rejectUnauthorized: false } });
const embedder = localEmbedder();
let after = 0, total = 0;
const batch = arg("--batch", 200), max = arg("--max", Infinity);
while (total < max) {
  const { embedded, lastId } = await backfillEmbeddings(read, write, embedder, batch, after);
  if (lastId === after) break;
  after = lastId; total += embedded;
  console.log(`embedded ${total} (up to message ${after})`);
}
await read.end(); await write.end();
