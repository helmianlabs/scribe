import type { Rule, Shape } from './types.ts';

/**
 * Plain-word custom rules. Supported sentences (case-insensitive):
 *   anything mentioning X goes in Y
 *   anything mentioning X or Z goes in Y            (any of them)
 *   anything mentioning X and Z goes in Y           (all of them)
 *   anything from SOURCE goes in Y                  (source layer)
 *   anything tagged T goes in Y
 *   code | PRs | commits | errors | chat go(es) in Y   (shape layer)
 *   X goes in Y / X or Z go in Y / X and Z go in Y   (bare words, same as "anything mentioning")
 *   put X in Y / file X under Y                      (same thing, other order)
 *   Brendan is a person | Jerome is a place | Banyan is a customer (teaches people / places / organizations)
 *   ... and tag it T1, T2                           (optional tail)
 * Returns null when the sentence is not understood, so the UI can say so instead of guessing.
 */
const SHAPES: Record<string, Shape> = {
  code: 'code', pr: 'pr', prs: 'pr', 'pull requests': 'pr', commit: 'commit', commits: 'commit',
  error: 'error', errors: 'error', chat: 'chat', chats: 'chat',
};

const slug = (s: string) => s.trim().toLowerCase().replace(/["']/g, '').replace(/\s+/g, '-');
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();

/** What to show someone whose sentence was not understood. */
export const PLAIN_RULE_HELP =
  'Try: "anything mentioning X goes in Y", "X goes in Y", "anything from SOURCE goes in Y", "anything tagged T goes in Y", or "X is a person / place / customer".';

const ENTITY_KINDS: Record<string, string> = {
  person: 'people', people: 'people', place: 'places', city: 'places', town: 'places',
  company: 'organizations', customer: 'organizations', client: 'organizations', business: 'organizations',
  organization: 'organizations', organisation: 'organizations', org: 'organizations', vendor: 'organizations', supplier: 'organizations',
};
const NOT_A_SUBJECT = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'things', 'thing', 'stuff', 'everything', 'anything', 'all', 'any']);

export function parsePlainRule(sentence: string, id: string, priority = 900): Rule | null {
  let s = sentence.trim().replace(/\.$/, '');
  // "put X in Y" / "file X under Y"  ->  "X goes in Y"
  const reorder = /^(?:put|file|move|send)\s+(.+?)\s+(?:in|into|to|under)\s+(?:the\s+)?(.+)$/i.exec(s);
  if (reorder && !/\s(?:goes|go|should go)\s/i.test(s)) s = `${reorder[1]} goes in ${reorder[2]}`;
  // "Banyan is a customer"  ->  a people / places / organizations rule
  const entity = /^(.+?)\s+(?:is|are)\s+(?:a|an|the)?\s*([a-z]+)$/i.exec(s);
  if (entity && ENTITY_KINDS[entity[2].toLowerCase()] && !NOT_A_SUBJECT.has(entity[1].trim().toLowerCase())) {
    const names = entity[1].split(/\s*,\s*|\s+(?:or|and)\s+/i).map(unquote).filter(Boolean);
    if (names.length) {
      const category = ENTITY_KINDS[entity[2].toLowerCase()];
      return { id, layer: 'custom', when: { anyWords: names }, category, priority, addTags: [category === 'people' ? 'person' : category === 'places' ? 'place' : 'organization'], description: `Your rule: "${sentence.trim()}"` };
    }
  }
  let addTags: string[] | undefined;
  const tail = /\s+and tag (?:it|them)\s+(.+)$/i.exec(s);
  if (tail) { addTags = tail[1].split(/\s*,\s*|\s+and\s+/).map(unquote).filter(Boolean); s = s.slice(0, tail.index); }

  const target = /\s+(?:goes|go|should go|gets filed|get filed)\s+(?:in|into|to|under)\s+(?:the\s+)?(.+?)(?:\s+(?:table|shelf|folder|category))?$/i.exec(s);
  if (!target) return null;
  const category = slug(unquote(target[1]));
  const lhs = s.slice(0, target.index).trim();
  const base = { id, layer: 'custom' as const, category, priority, addTags, description: `Your rule: "${sentence.trim()}"` };

  let m = /^(?:anything|everything|all|any)\s+(?:that\s+)?(?:mentioning|mentions|about|with|containing|related to|regarding|concerning)\s+(.+)$/i.exec(lhs);
  if (m) {
    const body = m[1];
    if (/\s+and\s+/i.test(body)) return { ...base, when: { allWords: body.split(/\s+and\s+/i).map(unquote) } };
    return { ...base, when: { anyWords: body.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean) } };
  }
  m = /^(?:anything|everything|all)\s+(?:from|written by|saved by)\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { source: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  m = /^(?:anything|everything|all)\s+tagged\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { tags: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  const shapes = lhs.toLowerCase().replace(/^(all|any)\s+/, '').split(/\s*,\s*|\s+(?:and|or)\s+/).map((x) => SHAPES[x.trim()]);
  if (shapes.length && shapes.every(Boolean)) return { ...base, layer: 'custom', when: { shape: shapes as Shape[] } };
  // Bare words: "invoices go in finance", "banyan or giltner go in customers", "brendan and banyan go in people".
  const bare = unquote(lhs);
  if (bare && bare.split(/\s+/).length <= 8 && !/^(?:anything|everything|all|any)\b/i.test(bare) && !NOT_A_SUBJECT.has(bare.toLowerCase())) {
    if (/\s+and\s+/i.test(bare)) return { ...base, when: { allWords: bare.split(/\s+and\s+/i).map(unquote).filter(Boolean) } };
    const words = bare.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean);
    if (words.length) return { ...base, when: { anyWords: words } };
  }
  return null;
}
