/**
 * Meaning-based (embedding) search for the hosted server. Cheap by design: a small local model
 * (Xenova/all-MiniLM-L6-v2, quantised, 384 numbers per passage) run in-process through @huggingface/transformers,
 * which is NOT a dependency (install it to enable: npm install --no-save @huggingface/transformers@4.3.2).
 * No paid key, no outside API at query time; the model (about 25 MB) downloads on first use.
 *
 * Off unless SCRIBE_EMBEDDINGS=local (or an Embedder is passed in). When it is off, when the package or model is
 * missing, or when migration 012 is not applied, search is full-text/literal only and saving works as before.
 *
 * Long memories are split into passages (~500 characters, on sentence ends) and each passage gets its own vector,
 * so one relevant sentence inside a long mixed note can still be found.
 */
import type { Q } from "./db.js";

export interface Embedder {
  /** Stored with each vector so a model change never mixes incompatible vectors. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const PASSAGE_CHARS = 500;

/** Local model through @huggingface/transformers (not a dependency). Loaded on first use; embed() throws if unavailable. */
export function localEmbedder(model = process.env.SCRIBE_EMBED_MODEL || DEFAULT_EMBED_MODEL): Embedder {
  let pipe: Promise<((t: string[], o: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null> | null = null;
  const load = () => (pipe ??= (async () => {
    try {
      const pkg = "@huggingface/transformers"; // not a dependency: a variable specifier so builds without it still compile
      const mod: any = await import(pkg);
      return await mod.pipeline("feature-extraction", model, { dtype: "q8" });
    } catch (e) {
      console.warn(`[embeddings] local model unavailable (${e instanceof Error ? e.message : String(e)}); search stays full-text only.`);
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

export class EmbeddingsUnavailable extends Error {}

/** "fallback": meaning-based results only when the words find (almost) nothing. "blend": always fused with word ranking. */
export type SemanticMode = "fallback" | "blend" | "off";
export function semanticModeFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticMode {
  return (env.SCRIBE_EMBEDDINGS_MODE ?? "").trim().toLowerCase() === "blend" ? "blend" : "fallback";
}

/** The embedder chosen by configuration, or undefined (full-text only). */
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
 * Embed one memory and store its passage vectors. Fail-soft: runs inside a SAVEPOINT, so a missing table (012 not
 * applied) or a model failure never breaks the save that called it. Returns how many passages were stored.
 */
export async function storeEmbeddings(q: Q, tenantId: string, messageId: number, text: string, embedder: Embedder): Promise<number> {
  const parts = passages(text);
  if (!parts.length) return 0;
  let vecs: number[][];
  try { vecs = await embedder.embed(parts.map((p) => p.text)); } catch { return 0; }
  await q.query("SAVEPOINT scribe_embed");
  try {
    for (let i = 0; i < parts.length; i++) {
      await q.query(
        "INSERT INTO memory_embeddings (tenant_id, message_id, model, chunk_index, chunk_start, embedding) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [tenantId, messageId, embedder.model, i, parts[i].start, vecs[i]]);
    }
    await q.query("RELEASE SAVEPOINT scribe_embed");
    return parts.length;
  } catch (e) {
    await q.query("ROLLBACK TO SAVEPOINT scribe_embed");
    if (!isMissingTable(e)) console.warn(`[embeddings] could not store vectors for memory ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** Embed memories that have no vectors yet for this model (oldest first). Returns how many memories were embedded. */
export async function backfillEmbeddings(q: Q, tenantId: string, embedder: Embedder, batch = 200): Promise<number> {
  const r = await q.query(
    `SELECT m.id, m.text FROM messages m
      WHERE m.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.tenant_id = m.tenant_id AND e.message_id = m.id AND e.model = $2)
      ORDER BY m.id LIMIT $3`, [tenantId, embedder.model, batch]);
  let n = 0;
  for (const row of r.rows) if ((await storeEmbeddings(q, tenantId, Number(row.id), row.text ?? "", embedder)) > 0) n++;
  return n;
}

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };

export interface SemanticHit { message_id: number; similarity: number; chunk_start: number }

/**
 * Nearest memories to the query by meaning: best passage per memory (vectors are normalised, so dot = cosine).
 * Returns [] when embeddings are unavailable for any reason, so callers fall back to full-text/literal search.
 */
export async function semanticSearch(q: Q, tenantId: string, query: string, embedder: Embedder, opts: { top?: number; minSimilarity?: number; scanLimit?: number } = {}): Promise<SemanticHit[]> {
  let qv: number[];
  try { [qv] = await embedder.embed([query]); } catch { return []; }
  await q.query("SAVEPOINT scribe_semantic");
  let rows: any[];
  try {
    rows = (await q.query(
      "SELECT message_id, chunk_start, embedding FROM memory_embeddings WHERE tenant_id = $1 AND model = $2 ORDER BY id DESC LIMIT $3",
      [tenantId, embedder.model, opts.scanLimit ?? 50_000])).rows;
    await q.query("RELEASE SAVEPOINT scribe_semantic");
  } catch {
    await q.query("ROLLBACK TO SAVEPOINT scribe_semantic");
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
