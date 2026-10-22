import type { Filing, Layer, MemoryItem, Rule, RuleHit, Rulebook } from './types.ts';
import { UNSORTED } from './types.ts';
import { normalise, notebookLabel, parseTags, resolveSource, stripTagLine } from './parse.ts';
import { detectShape } from './shape.ts';
import { findWords } from './match.ts';

/** Tie-break when priorities are equal: the more specific layer wins. */
const LAYER_RANK: Record<Layer, number> = { learned: 5, custom: 4, content: 3, shape: 2, source: 1 };

/** Returns what matched, or null when the rule does not fire. Every condition given must hold. */
export function evaluateRule(
  rule: Rule,
  ctx: { text: string; source: string | null; shape: ReturnType<typeof detectShape>; tags: string[]; conv: string },
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
    const hit = w.tags.find((t) => ctx.tags.includes(normalise(t)));
    if (!hit) return null;
    matched.push(`tag "${normalise(hit)}"`);
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
  if (w.noneWords?.length) {
    if (findWords(ctx.text, w.noneWords).length) return null;
  }
  return conditions > 0 ? matched : null; // a rule with no conditions never fires
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || a.id.localeCompare(b.id),
  );
}

/** File one memory. Pure and deterministic: same item + same rulebook = same filing. */
export function classify(item: MemoryItem, book: Rulebook, extraRules: Rule[] = []): Filing {
  const raw = item.text ?? '';
  const tags = parseTags(raw);
  const text = stripTagLine(raw);
  const source = resolveSource(item);
  const shape = detectShape(text);
  // A save_memory notebook is "Shared Memory — <category or source>": match only the part after the
  // dash, so the words "Shared Memory" never file everything into the Shared Memory project.
  const conv = notebookLabel(item.conversationName) ?? item.conversationName ?? '';
  const ctx = { text, source, shape, tags, conv };

  const hits: RuleHit[] = [];
  for (const rule of sortRules([...book.rules, ...extraRules])) {
    const matched = evaluateRule(rule, ctx);
    if (matched) hits.push({ ruleId: rule.id, layer: rule.layer, category: rule.category, priority: rule.priority, matched });
  }

  const allRules = new Map([...book.rules, ...extraRules].map((r) => [r.id, r]));
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
  return {
    itemId: item.id, category: winner.category!, tags: [...outTags].sort(), rulebook: book.id, winningRule: winner.ruleId, hits, shape, source,
    explanation: `Filed in "${winner.category}" by rule ${winner.ruleId} (${winner.layer} layer): ${rule.description} Matched ${winner.matched.join(', ')}.`,
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
