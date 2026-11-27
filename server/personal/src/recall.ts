/**
 * Ranked recall for the personal, single-user server (the claude_memory database; no tenants).
 * Ported from the hosted server's recall.ts (helmianlabs/scribe PR #5 and PR #6): the same ranking, snippets,
 * novelty filter and sentence splitter, minus the hosted-only parts (tenant filter, supersede, recall log).
 *
 *  - Ranking: Postgres full-text search (english stemming, ts_rank with length normalisation), with the old
 *    case-insensitive substring match kept as a lower fallback tier, so nothing the old search found disappears.
 *    Works without any migration; migrations/p001_fts_index.sql (optional) adds the index that makes it fast.
 *  - Results: the snippet is centred on the match (not the first 300 characters); a result whose matching sentences
 *    were already shown is folded into the first one (similar_hidden counts them), so repeated notes no longer crowd
 *    out a memory with something new to say; the response is cut to a token budget.
 *  - Optional meaning-based search (embeddings.ts), OFF unless SCRIBE_EMBEDDINGS=local.
 * Every statement here is a SELECT, so it runs on the read-only pool.
 */
import { semanticSearch, semanticModeFromEnv, type Embedder, type SemanticHit, type SemanticMode } from "./embeddings.js";

/** Anything with pg's query(): a pg.Pool, a pg.PoolClient, or a test database. */
export interface Q { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }

export const SNIPPET_CHARS = 300;
export const DEFAULT_MAX_TOKENS = 2000;
const CANDIDATES = 400;
const SIMILAR = 0.6;
/** Meaning-based candidates blended per search, and the reciprocal-rank-fusion constant (the usual 60). */
const SEMANTIC_TOP = 50;
const RRF_K = 60;
/** fallback mode: meaning-based search runs when the words find fewer than this many memories. */
const FALLBACK_BELOW = 3;

export interface SearchParams {
  query: string;
  since?: string;
  limit: number;
  maxTokens?: number;
  diverse?: boolean;
  /** Optional meaning-based search. Absent or failing = word-based only. */
  embedder?: Embedder;
  semanticMode?: SemanticMode;
}
export interface SearchResult {
  id: number;
  conversation_name: string;
  sender: string;
  created_at: string;
  snippet: string;
  /** true when the snippet is the entire memory (no need to call read_memory). */
  whole: boolean;
  score: number;
  similar_hidden?: number;
}

/** "ranked" (default) or "substring" (the old newest-first ILIKE search, kept as a switch-back). */
export type SearchMode = "ranked" | "substring";
export function searchModeFromEnv(env: NodeJS.ProcessEnv = process.env): SearchMode {
  return (env.SCRIBE_SEARCH ?? "").trim().toLowerCase() === "substring" ? "substring" : "ranked";
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));
const STOP = new Set("a an and are as at be but by for from has have i in is it its of on or our that the their this to was we were what when where which who why will with you your".split(" "));

/** Query words used to centre snippets: lower-case, stop words dropped, de-duplicated. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const w of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (w.length >= 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the query matches in `lower`: literal phrase hits (weight 2) and query-word hits by word start (weight 1). */
function matchHits(lower: string, query: string): { pos: number; term: string; w: number }[] {
  const hits: { pos: number; term: string; w: number }[] = [];
  const phrase = query.trim().toLowerCase();
  if (phrase) for (let i = lower.indexOf(phrase); i >= 0; i = lower.indexOf(phrase, i + 1)) hits.push({ pos: i, term: "\u0000phrase", w: 2 });
  for (const t of queryTerms(query)) {
    const stem = t.length > 5 ? t.slice(0, Math.max(5, t.length - 2)) : t;
    for (const m of lower.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(stem)}`, "gu"))) hits.push({ pos: m.index ?? 0, term: t, w: 1 });
  }
  return hits.sort((x, y) => x.pos - y.pos);
}

/** Cut `len` chars of `text` around `at` (match sits about a third of the way in), clamped to the text. */
function windowAt(text: string, at: number, len: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(at - Math.floor(len / 3), text.length - len));
  return { start, end: Math.min(text.length, start + len) };
}

/**
 * Match-centred snippet of at most SNIPPET_CHARS. Short texts are returned whole. In a long text the matches are grouped
 * into places (hits closer than half a snippet belong together) and each place is scored by the distinct query words it
 * holds (a literal phrase hit counts double). One place: one window centred on it. Several places: the two best are
 * shown as two half-size fragments joined by " … ", like a search engine's multi-fragment highlight, so a memory that
 * mentions the subject twice in different contexts shows both. Total length is exactly `size` for truncated texts.
 */
export function centeredSnippet(text: string, query: string, size = SNIPPET_CHARS, hintPos?: number): { snippet: string; whole: boolean } {
  if (text.length <= size) return { snippet: text, whole: true };
  const hits = matchHits(text.toLowerCase(), query);
  const places: { pos: number; score: number; terms: Set<string> }[] = [];
  for (const h of hits) {
    const last = places[places.length - 1];
    if (last && h.pos - last.pos < size / 2) { if (!last.terms.has(h.term)) { last.terms.add(h.term); last.score += h.w; } continue; }
    places.push({ pos: h.pos, score: h.w, terms: new Set([h.term]) });
  }
  const render = (parts: { start: number; end: number }[]) => {
    let out = "";
    parts.forEach((p, i) => {
      const pre = p.start > 0 ? "…" : "";
      const post = p.end < text.length ? "…" : "";
      if (i > 0) out += " ";
      out += pre + text.slice(p.start + pre.length + (i > 0 ? 1 : 0), p.end - post.length) + post;
    });
    return out;
  };
  if (places.length >= 2) {
    const top = [...places].sort((x, y) => y.score - x.score || x.pos - y.pos).slice(0, 2).sort((x, y) => x.pos - y.pos);
    const half = Math.floor(size / 2);
    const a = windowAt(text, top[0].pos, half);
    const b = windowAt(text, top[1].pos, size - half);
    if (b.start >= a.end) return { snippet: render([a, b]), whole: false };
  }
  // No word match (a meaning-only result): centre on the passage the embedding search matched.
  const best = places.length ? [...places].sort((x, y) => y.score - x.score || x.pos - y.pos)[0].pos : Math.max(0, hintPos ?? 0) + Math.floor(size / 3);
  return { snippet: render([windowAt(text, best, size)]), whole: false };
}

/** The sentences of `text` that contain a query match (the whole text when nothing matches by word). */
export function matchingSentenceList(text: string, query: string): string[] {
  const hits = matchHits(text.toLowerCase(), query);
  if (!hits.length) return [text];
  const out: string[] = [];
  for (const m of text.matchAll(/[^\n]+?(?:[.!?]+(?=\s|$)|(?=\n)|$)/g)) {
    const start = m.index ?? 0; const end = start + m[0].length;
    if (m[0].trim() && hits.some((h) => h.pos >= start && h.pos < end)) out.push(m[0].trim());
  }
  return out.length ? out : [text];
}

/**
 * The sentences of `text` that contain a query match, joined. Two results whose matching sentences are near-identical
 * say the same thing about the query, even when the rest of each memory differs, so they are folded together.
 */
export function matchingSentences(text: string, query: string): string {
  return matchingSentenceList(text, query).join(" ");
}

const wordSet = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
function jaccard(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(1, a.size + b.size - n);
}
export const estimateTokens = (o: unknown) => Math.ceil(JSON.stringify(o).length / 4);

/** Word (full-text + substring) candidates, plus any meaning-based ids. */
async function candidates(q: Q, p: SearchParams, literal: string, semIds: number[]) {
  const vals: unknown[] = [p.query, literal, semIds];
  let since = "";
  if (p.since?.trim()) { vals.push(p.since.trim()); since = `AND m.created_at >= $${vals.length}`; }
  // Must match the expression in migrations/p001_fts_index.sql for the index to be used.
  const tsv = "to_tsvector('english', coalesce(m.text, ''))";
  return q.query(
    `WITH tq AS (SELECT websearch_to_tsquery('english', $1) AS q)
     SELECT m.id, m.text, m.sender, m.created_at, c.name AS conversation_name,
            CASE WHEN numnode(tq.q) > 0 AND ${tsv} @@ tq.q THEN ts_rank(${tsv}, tq.q, 1) ELSE 0 END AS fts,
            (m.text ILIKE $2) AS literal
     FROM messages m JOIN conversations c ON c.uuid = m.conversation_uuid CROSS JOIN tq
     WHERE ((numnode(tq.q) > 0 AND ${tsv} @@ tq.q) OR m.text ILIKE $2 OR m.id = ANY($3::bigint[])) ${since}
     ORDER BY (m.id = ANY($3::bigint[])) DESC, fts DESC, m.created_at DESC
     LIMIT ${CANDIDATES}`,
    vals);
}

export interface RankedSearch { total_matches: number | string; returned: number; est_tokens: number; results: SearchResult[] }

export async function searchRanked(q: Q, p: SearchParams): Promise<RankedSearch> {
  const literal = `%${p.query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const mode = p.embedder ? (p.semanticMode ?? semanticModeFromEnv()) : "off";
  // blend: meaning-based candidates are always fetched and fused with the word ranking.
  // fallback (default): words first; meaning-based search only runs when the words find fewer than FALLBACK_BELOW memories.
  let sem: SemanticHit[] = mode === "blend" ? await semanticSearch(q, p.query, p.embedder!, { top: SEMANTIC_TOP }) : [];
  const runQuery = () => candidates(q, p, literal, sem.map((h) => h.message_id));
  let r = await runQuery();
  if (mode === "fallback" && r.rows.filter((x: any) => Number(x.fts) > 0 || x.literal === true).length < FALLBACK_BELOW) {
    sem = await semanticSearch(q, p.query, p.embedder!, { top: SEMANTIC_TOP });
    if (sem.length) r = await runQuery();
  }
  const semRank = new Map(sem.map((h, i) => [h.message_id, i + 1]));
  const semSim = new Map(sem.map((h) => [h.message_id, h.similarity]));
  const semStart = new Map(sem.map((h) => [h.message_id, h.chunk_start]));
  const multiword = /\s/.test(p.query.trim());
  type Row = SearchResult & { text: string; ts: number };

  const base = r.rows.map((x: any) => {
    const fts = Number(x.fts) || 0;
    const lexical = fts > 0 || x.literal === true;
    const relevance = fts > 0 ? fts * (x.literal ? (multiword ? 1.5 : 1.1) : 1) : lexical ? 0.0001 : 0; // substring-only matches sit below every full-text match
    const created = x.created_at instanceof Date ? x.created_at : new Date(x.created_at);
    return { x, relevance, lexical, created };
  });
  // Without meaning-based hits the score is full-text relevance. With blend, reciprocal rank fusion (1/(60+rank) from
  // each list), so a memory near the top of either list can surface.
  const lexRank = new Map([...base].filter((b) => b.lexical).sort((a, b) => b.relevance - a.relevance || b.created.getTime() - a.created.getTime()).map((b, i) => [Number(b.x.id), i + 1]));
  const fused = mode === "blend" && sem.length > 0;
  const ranked: Row[] = base.map(({ x, relevance, created }) => {
    const id = Number(x.id);
    // fallback mode: meaning-only results sit below every word match, ordered by similarity.
    const score = fused ? (lexRank.has(id) ? 1 / (RRF_K + lexRank.get(id)!) : 0) + (semRank.has(id) ? 1 / (RRF_K + semRank.get(id)!) : 0)
      : relevance > 0 ? relevance : (semSim.get(id) ?? 0) * 1e-5;
    const { snippet, whole } = centeredSnippet(x.text ?? "", p.query, SNIPPET_CHARS, semStart.get(id));
    const created_at = created.getTime() ? created.toISOString() : iso(x.created_at);
    return { id, conversation_name: x.conversation_name, sender: x.sender, created_at, snippet, whole, score: Number(score.toFixed(6)), text: x.text ?? "", ts: created.getTime() || 0 };
  });
  ranked.sort((a, b) => b.score - a.score || b.ts - a.ts || b.id - a.id);
  // Novelty filter: a result is shown only if at least one of its matching sentences says something not already shown
  // (near-duplicate sentences, Jaccard >= SIMILAR, count as already shown). Otherwise it is folded into the result that
  // first showed that sentence (similar_hidden).
  const kept: Row[] = [];
  const shown: { words: Set<string>; owner: Row }[] = [];
  for (const row of ranked) {
    if (p.diverse !== false) {
      const sents = matchingSentenceList(row.text, p.query).map(wordSet);
      const novel = sents.filter((w) => !shown.some((x) => jaccard(x.words, w) >= SIMILAR));
      if (!novel.length) {
        const owner = shown.find((x) => sents.some((w) => jaccard(x.words, w) >= SIMILAR))!.owner;
        owner.similar_hidden = (owner.similar_hidden ?? 0) + 1;
        continue;
      }
      for (const w of novel) shown.push({ words: w, owner: row });
    }
    kept.push(row);
    if (kept.length >= p.limit * 3) break;
  }
  const budget = Math.max(100, p.maxTokens ?? DEFAULT_MAX_TOKENS);
  const results: SearchResult[] = [];
  let used = 0;
  for (const row of kept) {
    if (results.length >= p.limit) break;
    const { text: _t, ts: _s, ...out } = row;
    const cost = estimateTokens(out);
    if (results.length > 0 && used + cost > budget) break;
    results.push(out); used += cost;
  }
  return { total_matches: r.rows.length >= CANDIDATES ? `${CANDIDATES}+` : r.rows.length, returned: results.length, est_tokens: used, results };
}
