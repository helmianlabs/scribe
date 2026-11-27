import type { MemoryItem, Rule, Rulebook } from './types.ts';
import { UNSORTED } from './types.ts';
import { classify } from './engine.ts';
import { parseTags, stripTagLine } from './parse.ts';
import { findWords } from './match.ts';

const STOP = new Set(('the a an and or but if then of to in on at for with from by is are was were be been it this that these those ' +
  'i you he she we they me my your our their not no yes so as do did does done have has had just can will would should could ' +
  'about into over also more most some any all what when where which who how than there here out up down get got make made ' +
  'like okay ok yeah hey please thanks thank need want going let lets now today tomorrow yesterday one two three').split(' '));

/** Candidate trigger words for an item, most distinctive first. Deterministic. */
export function candidateTriggers(item: MemoryItem): string[] {
  const tags = parseTags(item.text);
  const text = stripTagLine(item.text);
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  // Capitalised words in the original text (names, products) rank above common words.
  const proper = new Set((text.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)));
  const ranked = [...counts.entries()]
    .sort((a, b) => Number(proper.has(b[0])) - Number(proper.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w);
  return [...tags, ...ranked];
}

export interface LearnResult {
  rule: Rule | null;
  /** Plain words for the UI. */
  note: string;
}

/**
 * The user moved an item to `toCategory`. Learn ONE trigger word that would have filed it there,
 * choosing the most distinctive word that does not already push the reference items elsewhere.
 * `reference` is a sample of already-filed items used to reject words that would cause wrong filings.
 */
export function learnFromMove(item: MemoryItem, toCategory: string, book: Rulebook, existing: Rule[] = [], reference: MemoryItem[] = []): LearnResult {
  const current = classify(item, book, existing);
  if (current.category === toCategory) return { rule: null, note: `Already files into "${toCategory}"; nothing to learn.` };
  const taken = new Set(existing.flatMap((r) => r.when.anyWords ?? []));
  for (const word of candidateTriggers(item).slice(0, 15)) {
    if (taken.has(word)) continue;
    // Reject a word only when it would pull a memory OFF a shelf it is really on. A reference memory that is
    // still in the unsorted tray is not a conflict: the new rule would file it, which is the point of learning.
    // (Before this fix, one unsorted memory sharing the word blocked the whole lesson.)
    const collisions = reference.filter((r) => {
      if (r.id === item.id || !findWords(stripTagLine(r.text), [word]).length) return false;
      const cat = classify(r, book, existing).category;
      return cat !== UNSORTED && cat !== toCategory;
    }).length;
    if (collisions > 0) continue;
    const rule: Rule = {
      id: `learned.${toCategory}.${word}`.replace(/[^a-z0-9._/-]/gi, '_'),
      layer: 'learned',
      when: { anyWords: [word] },
      category: toCategory,
      priority: 950,
      description: `Learned when you moved item ${item.id} to "${toCategory}": anything mentioning "${word}" goes there.`,
    };
    const after = classify(item, book, [...existing, rule]);
    if (after.category === toCategory) return { rule, note: rule.description };
  }
  return { rule: null, note: 'Moved, but no safe trigger word was found, so no rule was learned (the move itself is kept).' };
}
