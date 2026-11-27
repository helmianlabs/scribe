// Per-source passphrase lockout. One bad guesser (keyed by client address, honouring the app's `trust proxy`
// setting) is locked out without locking the owner out: the old door-wide counter let anyone who could reach the
// page lock the real owner out for 15 minutes with five wrong guesses.
//
// Bounded memory: at most `maxEntries` sources are tracked; expired entries are swept on use and the oldest
// are dropped when full. In-memory only: a restart clears it (same as before).

export function createLockout({ max = 5, lockMs = 15 * 60 * 1000, maxEntries = 5000, now = () => Date.now() } = {}) {
  const sources = new Map(); // key -> { count, lockedUntil, touched }
  function sweep() {
    const t = now();
    for (const [k, v] of sources) if (v.lockedUntil <= t && t - v.touched > lockMs) sources.delete(k);
    while (sources.size > maxEntries) sources.delete(sources.keys().next().value);
  }
  return {
    /** Milliseconds this source must still wait; 0 when it may try. */
    lockedFor(key) {
      const v = sources.get(key);
      if (!v) return 0;
      return Math.max(0, v.lockedUntil - now());
    },
    fail(key) {
      sweep();
      const v = sources.get(key) ?? { count: 0, lockedUntil: 0, touched: 0 };
      v.count += 1; v.touched = now();
      if (v.count >= max) { v.lockedUntil = now() + lockMs; v.count = 0; }
      sources.delete(key); sources.set(key, v);
      return v.lockedUntil > now();
    },
    succeed(key) { sources.delete(key); },
    size: () => sources.size,
  };
}

/** The address used as the lockout key. */
export const sourceKey = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');
