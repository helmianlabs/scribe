/**
 * Per-source passphrase lockout (same behaviour as door/src/lockout.mjs). A guesser is keyed by client address
 * (the app sets `trust proxy`), locked for `lockMs` after `max` wrong tries, and cleared on success. Memory is
 * bounded; in-memory only, so a restart clears it.
 */
export interface Lockout {
  lockedFor(key: string): number;
  fail(key: string): boolean;
  succeed(key: string): void;
  size(): number;
}

export function createLockout(opts: { max?: number; lockMs?: number; maxEntries?: number; now?: () => number } = {}): Lockout {
  const max = opts.max ?? 5;
  const lockMs = opts.lockMs ?? 15 * 60 * 1000;
  const maxEntries = opts.maxEntries ?? 5000;
  const now = opts.now ?? (() => Date.now());
  const sources = new Map<string, { count: number; lockedUntil: number; touched: number }>();
  function sweep(): void {
    const t = now();
    for (const [k, v] of sources) if (v.lockedUntil <= t && t - v.touched > lockMs) sources.delete(k);
    while (sources.size > maxEntries) sources.delete(sources.keys().next().value as string);
  }
  return {
    lockedFor(key) {
      const v = sources.get(key);
      return v ? Math.max(0, v.lockedUntil - now()) : 0;
    },
    fail(key) {
      sweep();
      const v = sources.get(key) ?? { count: 0, lockedUntil: 0, touched: 0 };
      v.count += 1;
      v.touched = now();
      if (v.count >= max) { v.lockedUntil = now() + lockMs; v.count = 0; }
      sources.delete(key);
      sources.set(key, v);
      return v.lockedUntil > now();
    },
    succeed(key) { sources.delete(key); },
    size: () => sources.size,
  };
}
