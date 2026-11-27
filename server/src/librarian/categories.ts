import type { Rule, Rulebook } from './types.ts';
import { UNSORTED } from './types.ts';

/**
 * Category (shelf) name checks. A typo like "finnace" used to create a brand-new shelf silently. Now a
 * shelf name must already be known (in the rulebook, in an existing rule, already holding filings, or an
 * agent mailbox `for-<name>`), or the caller must confirm that a new shelf is really wanted.
 */
const MAILBOX = /^for-[a-z0-9][a-z0-9-]*$/;

export function normaliseCategory(raw: string): string {
  return raw.trim().toLowerCase().replace(/["']/g, '').replace(/\s+/g, '-');
}

/** Every shelf name already in use: rulebook, rules (preset + custom + learned) and shelves that hold filings. */
export function knownCategories(book: Rulebook, extra: Rule[] = [], filed: string[] = []): Set<string> {
  const out = new Set<string>([UNSORTED]);
  for (const c of book.categories) out.add(c.slug);
  for (const r of [...book.rules, ...extra]) if (r.category) out.add(r.category);
  for (const c of filed) if (c) out.add(c);
  return out;
}

/** Edit distance with adjacent swaps counted as one edit (so "finnace" is 1 away from "finance"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export type CategoryCheck =
  | { ok: true; slug: string; isNew: boolean }
  | { ok: false; slug: string; didYouMean: string[]; note: string };

/**
 * `confirmNew` = the caller said, on purpose, "yes, create a new shelf with this name".
 * Without it an unknown name is refused, with the closest known shelves as suggestions.
 */
export function checkCategory(raw: string, known: Set<string>, confirmNew = false): CategoryCheck {
  const slug = normaliseCategory(raw);
  if (!slug || !/^[a-z0-9][a-z0-9/_-]*$/.test(slug)) {
    return { ok: false, slug, didYouMean: [], note: `"${raw}" is not a usable shelf name (letters, numbers, - _ / only).` };
  }
  if (known.has(slug)) return { ok: true, slug, isNew: false };
  if (MAILBOX.test(slug)) return { ok: true, slug, isNew: false }; // for-<agent> mailboxes are addresses, not topics
  if (confirmNew) return { ok: true, slug, isNew: true };
  const near = [...known]
    .map((k) => ({ k, d: editDistance(slug, k) }))
    .filter((x) => x.d <= (slug.length >= 6 ? 2 : 1) || x.k.replace(/-/g, '') === slug.replace(/-/g, '') || x.k === `${slug}s` || `${x.k}s` === slug)
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k)).slice(0, 3).map((x) => x.k);
  const list = [...known].filter((k) => k !== UNSORTED).sort().slice(0, 25).join(', ');
  return {
    ok: false, slug, didYouMean: near,
    note: `"${slug}" is not an existing shelf, so nothing was changed.` + (near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : '')
      + ` If you really want a new shelf called "${slug}", repeat the request with confirm_new_category: true.`
      + (list ? ` Existing shelves: ${list}.` : ''),
  };
}
