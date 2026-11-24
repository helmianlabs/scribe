import type { Rule, Shape } from './types.ts';

/**
 * Plain-word custom rules. Supported sentences (case-insensitive):
 *   anything mentioning X goes in Y
 *   anything mentioning X or Z goes in Y            (any of them)
 *   anything mentioning X and Z goes in Y           (all of them)
 *   anything from SOURCE goes in Y                  (source layer)
 *   anything tagged T goes in Y
 *   code | PRs | commits | errors | chat go(es) in Y   (shape layer)
 *   ... and tag it T1, T2                           (optional tail)
 * Returns null when the sentence is not understood, so the UI can say so instead of guessing.
 */
const SHAPES: Record<string, Shape> = {
  code: 'code', pr: 'pr', prs: 'pr', 'pull requests': 'pr', commit: 'commit', commits: 'commit',
  error: 'error', errors: 'error', chat: 'chat', chats: 'chat',
};

const slug = (s: string) => s.trim().toLowerCase().replace(/["']/g, '').replace(/\s+/g, '-');
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();

export function parsePlainRule(sentence: string, id: string, priority = 900): Rule | null {
  let s = sentence.trim().replace(/\.$/, '');
  let addTags: string[] | undefined;
  const tail = /\s+and tag (?:it|them)\s+(.+)$/i.exec(s);
  if (tail) { addTags = tail[1].split(/\s*,\s*|\s+and\s+/).map(unquote).filter(Boolean); s = s.slice(0, tail.index); }

  const target = /\s+(?:goes|go|should go|gets filed|get filed)\s+(?:in|into|to|under)\s+(?:the\s+)?(.+?)(?:\s+(?:table|shelf|folder|category))?$/i.exec(s);
  if (!target) return null;
  const category = slug(unquote(target[1]));
  const lhs = s.slice(0, target.index).trim();
  const base = { id, layer: 'custom' as const, category, priority, addTags, description: `Your rule: "${sentence.trim()}"` };

  let m = /^anything (?:mentioning|about|that mentions|with)\s+(.+)$/i.exec(lhs);
  if (m) {
    const body = m[1];
    if (/\s+and\s+/i.test(body)) return { ...base, when: { allWords: body.split(/\s+and\s+/i).map(unquote) } };
    return { ...base, when: { anyWords: body.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean) } };
  }
  m = /^anything (?:from|written by|saved by)\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { source: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  m = /^anything tagged\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { tags: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  const shapes = lhs.toLowerCase().replace(/^(all|any)\s+/, '').split(/\s*,\s*|\s+(?:and|or)\s+/).map((x) => SHAPES[x.trim()]);
  if (shapes.length && shapes.every(Boolean)) return { ...base, layer: 'custom', when: { shape: shapes as Shape[] } };
  return null;
}
