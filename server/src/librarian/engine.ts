import type { Filing, Layer, MemoryItem, Rule, RuleHit, Rulebook } from './types.ts';
import { UNSORTED } from './types.ts';
import { normalise, notebookLabel, parseTags, resolveSource, stripTagLine } from './parse.ts';
import { detectShape } from './shape.ts';
import { findWords } from './match.ts';

/** Tie-break when priorities are equal: the more specific layer wins. */
const LAYER_RANK: Record<Layer, number> = { manual: 6, learned: 5, custom: 4, content: 3, shape: 2, source: 1 };

/**
 * Rule chaining: a rule's `addTags` become visible to the `when.tags` of the owner's own rules (custom and
 * learned layers; built-in preset rules keep seeing only written tags). Matching runs in passes:
 * pass 1 sees only the tags written on the memory; each later pass also sees the tags added by rules that
 * matched in the pass before. A rule fires at most once, and tags only ever grow, so chains cannot loop;
 * they also stop after this many passes (a chain can be at most this many rules deep).
 */
export const MAX_CHAIN_PASSES = 4;

const patternCache = new Map<string, RegExp | null>();
function compilePattern(src: string): RegExp | null {
  if (patternCache.has(src)) return patternCache.get(src)!;
  let re: RegExp | null = null;
  if (src.length <= 3000) { try { re = new RegExp(src, 'u'); } catch { re = null; } }
  patternCache.set(src, re);
  return re;
}
/** The first thing any of the patterns matches in the text, or null. */
function firstPatternHit(text: string, patterns: string[]): string | null {
  for (const src of patterns) {
    const m = compilePattern(src)?.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Returns what matched, or null when the rule does not fire. Every condition given must hold. */
export function evaluateRule(
  rule: Rule,
  ctx: { text: string; source: string | null; shape: ReturnType<typeof detectShape>; tags: string[]; conv: string; chainTags?: string[] },
): string[] | null {
  if (rule.enabled === false) return null;
  const w = rule.when;
  const matched: string[] = [];
  let conditions = 0;

  if (w.source?.length) {
    conditions++;
    const s = ctx.source;
    const hit = s ? w.source.find((x) => normalise(x) === s) : undefined;
    if (!hit) return null;
    matched.push(`source "${hit}"`);
  }
  if (w.shape?.length) {
    conditions++;
    if (!w.shape.includes(ctx.shape)) return null;
    matched.push(`shape ${ctx.shape}`);
  }
  if (w.tags?.length) {
    conditions++;
    // Built-in (preset) rules look only at the tags the writer typed, so shelves that exist today never move.
    // Your own rules (custom / learned) also see tags that other rules added: that is rule chaining.
    const pool = (rule.layer === 'custom' || rule.layer === 'learned') && ctx.chainTags ? ctx.chainTags : ctx.tags;
    const hit = w.tags.find((t) => pool.includes(normalise(t)));
    if (!hit) return null;
    matched.push(`tag "${normalise(hit)}"`);
  }
  if (w.patterns?.length) {
    conditions++;
    if (rule.layer === 'custom' || rule.layer === 'learned') return null; // database rules never run patterns
    const hit = firstPatternHit(ctx.text, w.patterns);
    if (!hit) return null;
    matched.push(`pattern match "${hit.trim().slice(0, 40)}"`);
  }
  if (w.conversationWords?.length) {
    conditions++;
    const hits = findWords(ctx.conv, w.conversationWords);
    if (!hits.length) return null;
    matched.push(`notebook name word "${hits[0]}"`);
  }
  if (w.anyWords?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.anyWords);
    if (!hits.length) return null;
    matched.push(...hits.slice(0, 3).map((h) => `word "${h}"`));
  }
  if (w.allWords?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.allWords);
    if (hits.length !== w.allWords.length) return null;
    matched.push(`all of ${w.allWords.map((x) => `"${x}"`).join(', ')}`);
  }
  if (w.withAny?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.withAny);
    if (!hits.length) return null;
    matched.push(`with context word "${hits[0]}"`);
  }
  if (w.noneWords?.length) {
    if (findWords(ctx.text, w.noneWords).length) return null;
  }
  if (w.nonePatterns?.length && rule.layer !== 'custom' && rule.layer !== 'learned') {
    if (firstPatternHit(ctx.text, w.nonePatterns)) return null;
  }
  return conditions > 0 ? matched : null; // a rule with no conditions never fires
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || a.id.localeCompare(b.id),
  );
}

const ignoreCache = new Map<string, RegExp>();
/** Blank out the rulebook's ignore patterns (infra names). Returns the cleaned text and what was blanked. */
export function applyIgnore(text: string, book: Rulebook): { text: string; ignored: string[] } {
  const ignored: string[] = [];
  let out = text;
  for (const ig of book.ignore ?? []) {
    let re = ignoreCache.get(ig.pattern);
    if (!re) { re = new RegExp(ig.pattern, 'giu'); ignoreCache.set(ig.pattern, re); }
    out = out.replace(re, (m) => { ignored.push(m); return ' '; });
  }
  return { text: out, ignored };
}

/** File one memory. Pure and deterministic: same item + same rulebook = same filing. */
export function classify(item: MemoryItem, book: Rulebook, extraRules: Rule[] = []): Filing {
  const raw = item.text ?? '';
  const tags = parseTags(raw);
  const body = stripTagLine(raw);
  const { text, ignored } = applyIgnore(body, book);
  const source = resolveSource(item);
  const shape = detectShape(body); // shape looks at the untouched text (a PR link is still a PR)
  // A save_memory notebook is "Shared Memory — <category or source>": match only the part after the
  // dash, so the words "Shared Memory" never file everything into the Shared Memory project.
  const conv = notebookLabel(item.conversationName) ?? item.conversationName ?? '';
  const ctx = { text, source, shape, tags, conv };

  // Matching in passes (rule chaining). Every rule fires at most once; tags only grow; passes are capped.
  const sorted = sortRules([...book.rules, ...extraRules]);
  const allRules = new Map(sorted.map((r) => [r.id, r]));
  const visibleTags = new Set<string>(tags);
  const tagAddedBy = new Map<string, string>();
  const fired = new Map<string, { hit: RuleHit; order: number }>();
  for (let pass = 1; pass <= MAX_CHAIN_PASSES; pass++) {
    const passCtx = { ...ctx, chainTags: [...visibleTags] };
    const newlyFired: Rule[] = [];
    sorted.forEach((rule, order) => {
      if (fired.has(rule.id)) return;
      const matched = evaluateRule(rule, passCtx);
      if (!matched) return;
      const hit: RuleHit = { ruleId: rule.id, layer: rule.layer, category: rule.category, priority: rule.priority, matched, description: rule.description };
      if (pass > 1) {
        hit.pass = pass;
        hit.via = (rule.when.tags ?? []).map(normalise).filter((t) => tagAddedBy.has(t)).map((t) => `${t} (from rule ${tagAddedBy.get(t)})`);
        if (hit.via.length) hit.matched = matched.map((m) => (m.startsWith('tag "') ? `${m} added by rule ${tagAddedBy.get(m.slice(5, -1))}` : m));
      }
      fired.set(rule.id, { hit, order });
      newlyFired.push(rule);
    });
    let grew = false;
    for (const rule of newlyFired) {
      for (const t of rule.addTags ?? []) {
        const n = normalise(t);
        if (!visibleTags.has(n)) { visibleTags.add(n); tagAddedBy.set(n, rule.id); grew = true; }
      }
    }
    if (!newlyFired.length || !grew) break;
  }
  const hits: RuleHit[] = [...fired.values()].sort((a, b) => a.order - b.order).map((x) => x.hit);

  const outTags = new Set<string>(tags);
  for (const h of hits) for (const t of allRules.get(h.ruleId)?.addTags ?? []) outTags.add(normalise(t));
  if (shape !== 'chat') outTags.add(shape);
  if (source) outTags.add(`from:${source}`);

  const winner = hits.find((h) => h.category);
  if (!winner) {
    return {
      itemId: item.id, category: UNSORTED, tags: [...outTags].sort(), rulebook: book.id, winningRule: null, hits, shape, source,
      explanation: 'No rule matched, so it went to the unsorted tray. Nothing is lost; move it and the Librarian can learn a rule.',
    };
  }
  const rule = allRules.get(winner.ruleId)!;
  const ignoredNote = ignored.length
    ? ` Ignored as infrastructure names, not topic: ${[...new Set(ignored)].slice(0, 3).map((x) => `"${x.trim().slice(0, 40)}"`).join(', ')}.`
    : '';
  return {
    itemId: item.id, category: winner.category!, tags: [...outTags].sort(), rulebook: book.id, winningRule: winner.ruleId, hits, shape, source,
    explanation: `Filed in "${winner.category}" by rule ${winner.ruleId} (${winner.layer} layer): ${rule.description} Matched ${winner.matched.join(', ')}.${ignoredNote}`,
  };
}

export function classifyAll(items: MemoryItem[], book: Rulebook, extraRules: Rule[] = []): Filing[] {
  return items.map((i) => classify(i, book, extraRules));
}

export function distribution(filings: Filing[]): { category: string; count: number; pct: number }[] {
  const counts = new Map<string, number>();
  for (const f of filings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const n = filings.length || 1;
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count, pct: Math.round((count / n) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Conversation context layer (batch). A chat turn like "yeah, do that" has no words of its own, but its
 * conversation does. After every item is filed on its own, an UNSORTED item inherits its conversation's
 * dominant shelf when that shelf holds at least `minCount` items and `minShare` of the conversation's
 * filed items. Deterministic, and the explanation names the conversation and the numbers.
 */
export const CONTEXT_RULE_ID = 'context.conversation';
export function classifyBatch(items: MemoryItem[], book: Rulebook, extraRules: Rule[] = [], opts = { minCount: 3, minShare: 0.4 }): Filing[] {
  const filings = items.map((i) => classify(i, book, extraRules));
  const byConv = new Map<string, number[]>();
  items.forEach((it, idx) => {
    const k = it.conversationName ?? '';
    if (!k) return;
    if (!byConv.has(k)) byConv.set(k, []);
    byConv.get(k)!.push(idx);
  });
  for (const [conv, idxs] of byConv) {
    const counts = new Map<string, number>();
    let filed = 0;
    for (const i of idxs) if (filings[i].category !== UNSORTED) { filed++; counts.set(filings[i].category, (counts.get(filings[i].category) ?? 0) + 1); }
    if (!filed) continue;
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (n < opts.minCount || n / filed < opts.minShare) continue;
    for (const i of idxs) {
      if (filings[i].category !== UNSORTED) continue;
      filings[i] = {
        ...filings[i],
        category: top,
        winningRule: CONTEXT_RULE_ID,
        hits: [...filings[i].hits, { ruleId: CONTEXT_RULE_ID, layer: 'content', category: top, priority: 0, matched: [`conversation "${conv.slice(0, 80)}"`] }],
        explanation: `Filed in "${top}" with the rest of its conversation "${conv.slice(0, 80)}" (${n} of ${filed} filed messages there are "${top}"). It had no trigger words of its own.`,
      };
    }
  }
  return filings;
}
