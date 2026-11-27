/**
 * Optional meaning-based (embedding) search for the personal, single-user server.
 *
 * OFF by default. Turned on only by SCRIBE_EMBEDDINGS=local, and then only does anything when ALL of these hold:
 *   - the package @huggingface/transformers is installed (it is NOT a dependency; build the image with
 *     --build-arg WITH_EMBEDDINGS=1, or `npm install --no-save @huggingface/transformers@4.3.2`),
 *   - the model (Xenova/all-MiniLM-L6-v2, quantised, about 25 MB, downloaded on first use) loads,
 *   - the optional table from migrations/p002_memory_embeddings.sql exists.
 * If any of them is missing, search is word-based only and saving works exactly as before. Nothing here can make a
 * save or a search fail.
 *
 * Long memories are split into passages (~500 characters, on sentence ends); each passage gets its own vector, so
 * one relevant sentence inside a long mixed note can still be found.
 */
import type { Q } from "./recall.js";

export interface Embedder {
  /** Stored with each vector so a model change never mixes incompatible vectors. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const PASSAGE_CHARS = 500;

export class EmbeddingsUnavailable extends Error {}

/** Local model through @huggingface/transformers (not a dependency). Loaded on first use; embed() throws if unavailable. */
export function localEmbedder(model = process.env.SCRIBE_EMBED_MODEL || DEFAULT_EMBED_MODEL): Embedder {
  let pipe: Promise<((t: string[], o: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null> | null = null;
  const load = () => (pipe ??= (async () => {
    try {
      const pkg = "@huggingface/transformers"; // a variable specifier, so builds without the package still compile
      const mod: any = await import(pkg);
      return await mod.pipeline("feature-extraction", model, { dtype: "q8" });
    } catch (e) {
      console.warn(`[embeddings] local model unavailable (${e instanceof Error ? e.message : String(e)}); search stays word-based.`);
      return null;
    }
  })());
  return {
    model,
    async embed(texts: string[]) {
      const p = await load();
      if (!p) throw new EmbeddingsUnavailable("local embedding model unavailable");
      const out = await p(texts, { pooling: "mean", normalize: true });
      return out.tolist();
    },
  };
}

/** "fallback" (default): meaning-based results only when the words find (almost) nothing. "blend": always fused. */
export type SemanticMode = "fallback" | "blend" | "off";
export function semanticModeFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticMode {
  return (env.SCRIBE_EMBEDDINGS_MODE ?? "").trim().toLowerCase() === "blend" ? "blend" : "fallback";
}

/** The embedder chosen by configuration, or undefined (word-based only). Default: undefined (OFF). */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | undefined {
  return (env.SCRIBE_EMBEDDINGS ?? "").trim().toLowerCase() === "local" ? localEmbedder() : undefined;
}

/** Split into passages of about `size` characters, ending on sentence boundaries where possible. */
export function passages(text: string, size = PASSAGE_CHARS): { start: number; text: string }[] {
  const t = text ?? "";
  if (t.length <= size) return t.trim() ? [{ start: 0, text: t }] : [];
  const out: { start: number; text: string }[] = [];
  let start = 0;
  let cur = "";
  for (const m of t.matchAll(/[^\n]+?(?:[.!?]+(?=\s|$)|(?=\n)|$)\s*/g)) {
    const s = m[0];
    if (!s) continue;
    if (cur && cur.length + s.length > size) { out.push({ start, text: cur.trim() }); start = m.index ?? 0; cur = ""; }
    if (!cur) start = m.index ?? 0;
    cur += s;
    while (cur.length > size * 2) { out.push({ start, text: cur.slice(0, size) }); start += size; cur = cur.slice(size); }
  }
  if (cur.trim()) out.push({ start, text: cur.trim() });
  return out;
}

const isMissingTable = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "42P01";

/**
 * Embed one memory and store its passage vectors (write pool, memory_rw). Fail-soft: a missing table (p002 not
 * applied), a missing grant or a model failure returns 0 and never touches the save that already committed.
 */
export async function storeEmbeddings(q: Q, messageId: number, text: string, embedder: Embedder): Promise<number> {
  const parts = passages(text);
  if (!parts.length) return 0;
  let vecs: number[][];
  try { vecs = await embedder.embed(parts.map((p) => p.text)); } catch { return 0; }
  try {
    const vals: unknown[] = [];
    const rows = parts.map((p, i) => {
      vals.push(messageId, embedder.model, i, p.start, vecs[i]);
      const b = i * 5;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
    });
    await q.query(
      `INSERT INTO memory_embeddings (message_id, model, chunk_index, chunk_start, embedding) VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
      vals);
    return parts.length;
  } catch (e) {
    if (!isMissingTable(e)) console.warn(`[embeddings] could not store vectors for memory ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** Embed memories that have no vectors yet for this model (oldest first). Returns how many memories were embedded. */
export async function backfillEmbeddings(read: Q, write: Q, embedder: Embedder, batch = 200, afterId = 0): Promise<{ embedded: number; lastId: number }> {
  const r = await read.query(
    `SELECT m.id, m.text FROM messages m
      WHERE m.id > $3 AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.message_id = m.id AND e.model = $1)
      ORDER BY m.id LIMIT $2`, [embedder.model, batch, afterId]);
  let n = 0;
  let lastId = afterId;
  for (const row of r.rows) {
    lastId = Number(row.id);
    if ((await storeEmbeddings(write, lastId, row.text ?? "", embedder)) > 0) n++;
  }
  return { embedded: n, lastId };
}

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };

export interface SemanticHit { message_id: number; similarity: number; chunk_start: number }

/**
 * Nearest memories to the query by meaning: best passage per memory (vectors are normalised, so dot = cosine).
 * Read pool only. Returns [] when embeddings are unavailable for any reason, so callers stay word-based.
 */
export async function semanticSearch(q: Q, query: string, embedder: Embedder, opts: { top?: number; minSimilarity?: number; scanLimit?: number } = {}): Promise<SemanticHit[]> {
  let qv: number[];
  try { [qv] = await embedder.embed([query]); } catch { return []; }
  let rows: any[];
  try {
    rows = (await q.query(
      "SELECT message_id, chunk_start, embedding FROM memory_embeddings WHERE model = $1 ORDER BY id DESC LIMIT $2",
      [embedder.model, opts.scanLimit ?? 50_000])).rows;
  } catch {
    return [];
  }
  const best = new Map<number, SemanticHit>();
  for (const r of rows) {
    const sim = dot(qv, (r.embedding as unknown[]).map(Number));
    const id = Number(r.message_id);
    const cur = best.get(id);
    if (!cur || sim > cur.similarity) best.set(id, { message_id: id, similarity: sim, chunk_start: Number(r.chunk_start) });
  }
  const min = opts.minSimilarity ?? 0.25;
  return [...best.values()].filter((h) => h.similarity >= min).sort((a, b) => b.similarity - a.similarity).slice(0, opts.top ?? 50);
}
