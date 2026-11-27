/**
 * Ranked recall for hosted Scribe Memory (migration 011).
 *
 *  - Ranking: Postgres full-text search (english stemming, ts_rank with length normalisation), with the old
 *    case-insensitive substring match kept as a lower fallback tier, so nothing that used to be found disappears.
 *  - Usage: memories that are read in full or confirmed rank higher (strengthening); memories nobody has used for a
 *    long time rank a little lower (fading). Fading never hides or deletes anything.
 *  - Supersede: a memory replaced by a newer one is hidden from search by default; include_history shows it.
 *  - Results: the snippet is centred on the match (not the first 300 characters), near-duplicate results are folded
 *    into the first one (similar_hidden counts them), and the response is cut to a token budget.
 *  - An optional rerank hook (e.g. an embedding model) can reorder candidates. None is wired by default.
 * Every query runs inside the caller's tenant transaction (RLS) and also filters tenant_id explicitly.
 */
import type { Q } from "./db.js";

export const SNIPPET_CHARS = 300;
export const DEFAULT_MAX_TOKENS = 2000;
const CANDIDATES = 400;
const SIMILAR = 0.6;

export interface SearchParams {
  query: string;
  since?: string;
  limit: number;
  maxTokens?: number;
  includeHistory?: boolean;
  diverse?: boolean;
  now?: Date;
  rerank?: RerankHook;
}
export interface SearchResult {
  message_id: number;
  conversation_name: string;
  sender: string;
  created_at: string;
  snippet: string;
  /** true when the snippet is the entire memory (no need to call read_memory). */
  whole: boolean;
  score: number;
  superseded_by?: number;
  replaces?: number[];
  similar_hidden?: number;
}
/** Optional reordering step (for example an embedding similarity model). Receives ranked candidates, returns them reordered. */
export type RerankHook = (query: string, candidates: SearchResult[]) => Promise<SearchResult[]>;

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
export function centeredSnippet(text: string, query: string, size = SNIPPET_CHARS): { snippet: string; whole: boolean } {
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
  const best = places.length ? [...places].sort((x, y) => y.score - x.score || x.pos - y.pos)[0].pos : 0;
  return { snippet: render([windowAt(text, best, size)]), whole: false };
}

/** Strengthening and fading. Fresh or recently used memories are untouched (1.0); the floor is 0.6, never zero. */
export function usageFactor(reads: number, lastUsed: Date | null, created: Date, now: Date): number {
  const strength = 1 + Math.min(1, 0.25 * Math.log1p(Math.max(0, reads)));
  const days = (now.getTime() - (lastUsed ?? created).getTime()) / 86_400_000;
  const fade = 0.6 + 0.4 * Math.exp(-Math.max(0, days - 30) / 180);
  return strength * fade;
}

/**
 * The sentences of `text` that contain a query match, joined. Two results whose matching sentences are near-identical
 * say the same thing about the query, even when the rest of each memory differs, so they are folded together.
 */
export function matchingSentences(text: string, query: string): string {
  const lower = text.toLowerCase();
  const hits = matchHits(lower, query);
  if (!hits.length) return text;
  const out: string[] = [];
  let from = 0;
  for (const m of [...text.matchAll(/[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)/g)]) {
    const start = m.index ?? 0; const end = start + m[0].length;
    if (start < from) continue;
    if (hits.some((h) => h.pos >= start && h.pos < end)) out.push(m[0]);
    from = end;
  }
  return out.length ? out.join(" ") : text;
}

const wordSet = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
function jaccard(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(1, a.size + b.size - n);
}
export const estimateTokens = (o: unknown) => Math.ceil(JSON.stringify(o).length / 4);

export async function searchRanked(q: Q, tenantId: string, p: SearchParams) {
  const now = p.now ?? new Date();
  const literal = `%${p.query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const vals: unknown[] = [tenantId, p.query, literal];
  let since = "";
  if (p.since?.trim()) { vals.push(p.since.trim()); since = `AND m.created_at >= $${vals.length}`; }
  const hide = p.includeHistory ? "" : `AND NOT EXISTS (SELECT 1 FROM memory_supersessions s WHERE s.tenant_id = m.tenant_id AND s.old_message_id = m.id)`;
  const tsv = "to_tsvector('english', coalesce(m.text, ''))";
  const r = await q.query(
    `WITH tq AS (SELECT websearch_to_tsquery('english', $2) AS q),
     cand AS (
       SELECT m.id, m.text, m.sender, m.created_at, c.name AS conversation_name,
              CASE WHEN numnode(tq.q) > 0 AND ${tsv} @@ tq.q THEN ts_rank(${tsv}, tq.q, 1) ELSE 0 END AS fts,
              (m.text ILIKE $3) AS literal
       FROM messages m JOIN conversations c ON c.uuid = m.conversation_uuid AND c.tenant_id = m.tenant_id CROSS JOIN tq
       WHERE m.tenant_id = $1 AND ((numnode(tq.q) > 0 AND ${tsv} @@ tq.q) OR m.text ILIKE $3) ${since} ${hide}
       ORDER BY fts DESC, m.created_at DESC
       LIMIT ${CANDIDATES})
     SELECT cand.*, u.reads, u.last_used, so.new_id AS superseded_by, rp.ids AS replaces
     FROM cand
     LEFT JOIN LATERAL (SELECT count(*)::int AS reads, max(x.created_at) AS last_used FROM memory_recalls x WHERE x.tenant_id = $1 AND x.message_id = cand.id) u ON true
     LEFT JOIN LATERAL (SELECT s.new_message_id AS new_id FROM memory_supersessions s WHERE s.tenant_id = $1 AND s.old_message_id = cand.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) so ON true
     LEFT JOIN LATERAL (SELECT array_agg(s.old_message_id ORDER BY s.old_message_id) AS ids FROM memory_supersessions s WHERE s.tenant_id = $1 AND s.new_message_id = cand.id) rp ON true`,
    vals);
  const multiword = /\s/.test(p.query.trim());
  type Row = SearchResult & { text: string; ts: number };
  let ranked: Row[] = r.rows.map((x: any) => {
    const fts = Number(x.fts) || 0;
    const relevance = fts > 0 ? fts * (x.literal ? (multiword ? 1.5 : 1.1) : 1) : 0.0001; // substring-only matches sit below every full-text match
    const created = x.created_at instanceof Date ? x.created_at : new Date(x.created_at);
    const score = relevance * usageFactor(Number(x.reads) || 0, x.last_used ? new Date(x.last_used) : null, created, now);
    const { snippet, whole } = centeredSnippet(x.text ?? "", p.query);
    const row: Row = { message_id: Number(x.id), conversation_name: x.conversation_name, sender: x.sender, created_at: iso(x.created_at), snippet, whole, score: Number(score.toFixed(6)), text: x.text ?? "", ts: created.getTime() };
    if (x.superseded_by) row.superseded_by = Number(x.superseded_by);
    if (x.replaces?.length) row.replaces = x.replaces.map(Number);
    return row;
  });
  ranked.sort((a, b) => b.score - a.score || b.ts - a.ts || b.message_id - a.message_id);
  if (p.rerank) {
    const head = ranked.slice(0, 50);
    const order = await p.rerank(p.query, head.map(({ text: _t, ts: _s, ...rest }) => rest));
    const byId = new Map(head.map((h) => [h.message_id, h]));
    const reordered = order.map((o) => byId.get(o.message_id)).filter((x): x is Row => Boolean(x));
    ranked = [...reordered, ...head.filter((h) => !reordered.includes(h)), ...ranked.slice(50)];
  }
  // Fold near-duplicates into the first (best) one, so repeated notes do not crowd out distinct memories.
  const kept: { row: Row; words: Set<string> }[] = [];
  for (const row of ranked) {
    if (p.diverse !== false) {
      const words = wordSet(matchingSentences(row.text, p.query)); // what each result says about the query
      const twin = kept.find((k) => jaccard(k.words, words) >= SIMILAR);
      if (twin) { twin.row.similar_hidden = (twin.row.similar_hidden ?? 0) + 1; continue; }
      kept.push({ row, words });
    } else kept.push({ row, words: new Set() });
    if (kept.length >= p.limit * 3) break;
  }
  const budget = Math.max(100, p.maxTokens ?? DEFAULT_MAX_TOKENS);
  const results: SearchResult[] = [];
  let used = 0;
  for (const { row } of kept) {
    if (results.length >= p.limit) break;
    const { text: _t, ts: _s, ...out } = row;
    const cost = estimateTokens(out);
    if (results.length > 0 && used + cost > budget) break;
    results.push(out); used += cost;
  }
  return { total_matches: r.rows.length >= CANDIDATES ? `${CANDIDATES}+` : r.rows.length, returned: results.length, est_tokens: used, results };
}

// ------------------------------------------------------------------ recall log + supersede
export async function logRecall(q: Q, tenantId: string, messageId: number, kind: "read" | "confirm", source: string | null): Promise<void> {
  await q.query("INSERT INTO memory_recalls (tenant_id, message_id, kind, source) VALUES ($1,$2,$3,$4)", [tenantId, messageId, kind, source]);
}

async function exists(q: Q, tenantId: string, id: number): Promise<boolean> {
  return (await q.query("SELECT 1 FROM messages WHERE tenant_id = $1 AND id = $2", [tenantId, id])).rows.length > 0;
}

export class SupersedeError extends Error {}

/** Record that `newId` replaces `oldId`. Nothing is edited or deleted; a repeat is a no-op; a loop is refused. */
export async function supersede(q: Q, tenantId: string, oldId: number, newId: number, by: string, reason?: string) {
  if (oldId === newId) throw new SupersedeError("A memory cannot replace itself.");
  for (const id of [oldId, newId]) if (!(await exists(q, tenantId, id))) throw new SupersedeError(`No memory with id ${id}.`);
  // Following "replaced by" links from newId must not reach oldId, or the new link would close a loop.
  const reverse = await q.query(
    `WITH RECURSIVE chain(id) AS (SELECT $2::bigint UNION SELECT s.new_message_id FROM memory_supersessions s JOIN chain ON s.old_message_id = chain.id WHERE s.tenant_id = $1)
     SELECT 1 FROM chain WHERE id = $3 LIMIT 1`, [tenantId, newId, oldId]);
  if (reverse.rows.length) throw new SupersedeError(`Memory ${oldId} already replaces ${newId} (directly or through a chain); refusing a loop.`);
  await q.query(
    `INSERT INTO memory_supersessions (tenant_id, old_message_id, new_message_id, reason, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT ON CONSTRAINT memory_supersessions_once DO NOTHING`, [tenantId, oldId, newId, reason ?? null, by]);
  return { old_message_id: oldId, new_message_id: newId, hidden_from_search: true, history_kept: true };
}

/** Which memory replaced this one (latest), and which ones it replaces. */
export async function historyOf(q: Q, tenantId: string, id: number) {
  const up = await q.query("SELECT new_message_id, created_at, reason FROM memory_supersessions WHERE tenant_id = $1 AND old_message_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1", [tenantId, id]);
  const down = await q.query("SELECT old_message_id, created_at FROM memory_supersessions WHERE tenant_id = $1 AND new_message_id = $2 ORDER BY old_message_id", [tenantId, id]);
  const u = up.rows[0];
  return {
    superseded_by: u ? { message_id: Number(u.new_message_id), at: iso(u.created_at), reason: u.reason ?? null } : null,
    replaces: down.rows.map((x: any) => ({ message_id: Number(x.old_message_id), at: iso(x.created_at) })),
  };
}
