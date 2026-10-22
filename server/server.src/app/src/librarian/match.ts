const cache = new Map<string, RegExp>();

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word / whole-phrase, case-insensitive; a trailing plural "s"/"es" is allowed. */
export function wordRegex(word: string): RegExp {
  const key = word.toLowerCase();
  let r = cache.get(key);
  if (!r) {
    const body = key.trim().split(/\s+/).map(escape).join('[\\s_-]+');
    r = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu');
    cache.set(key, r);
  }
  return r;
}

export function findWords(text: string, words: string[] = []): string[] {
  return words.filter((w) => wordRegex(w).test(text));
}
