import type { Filing, MemoryItem, Rule, Rulebook } from './types.js';
import { UNSORTED } from './types.js';
import { classifyBatch } from './engine.js';

/** Postgres "undefined table": the Librarian migration is not installed. Never retried. */
export function isMissingTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

/** Constraint, syntax and permission errors will fail the same way every time; connection hiccups will not. */
function isPermanent(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? String((err as { code?: string }).code ?? '') : '';
  return isMissingTable(err) || /^(22|23|28|42)/.test(code);
}

export interface RetryOptions {
  attempts?: number;                         // total tries, default 3
  baseDelayMs?: number;                      // 150, 300, ... (doubles)
  sleep?: (ms: number) => Promise<void>;     // injectable for tests
  onRetry?: (err: unknown, attempt: number) => void;
}

/** Run `fn`, retrying transient failures a few times with a short, growing pause. Throws the last error. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let n = 1; n <= attempts; n++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (isPermanent(err) || n === attempts) break;
      opts.onRetry?.(err, n);
      await sleep((opts.baseDelayMs ?? 150) * 2 ** (n - 1));
    }
  }
  throw lastErr;
}

export interface BackfillPlan {
  toWrite: Filing[];
  examined: number;
  newlyFiled: number;      // never filed before
  refiledUnsorted: number; // were in the unsorted tray, now have a shelf
  forced: number;          // re-filed because the caller listed the id
  skipped: number;         // already on a real shelf, left alone
  stillUnsorted: number;   // examined but no rule matched
}

/**
 * Decide which messages the backfill/repair should append a filing for, using the SAME rules the live
 * server uses (preset + custom + learned) plus the conversation-context layer.
 *  - never filed                         -> file it
 *  - currently in the unsorted tray      -> file it only if a rule now puts it on a real shelf
 *  - already on a real shelf             -> leave it (unless its id is in `forceIds`)
 * Pure: no database access, so it is easy to test and safe to dry-run.
 */
export function planBackfill(
  items: MemoryItem[],
  current: Map<string, string>,
  book: Rulebook,
  extraRules: Rule[] = [],
  forceIds: Set<string> = new Set(),
): BackfillPlan {
  const plan: BackfillPlan = { toWrite: [], examined: items.length, newlyFiled: 0, refiledUnsorted: 0, forced: 0, skipped: 0, stillUnsorted: 0 };
  const filings = classifyBatch(items, book, extraRules);
  for (const f of filings) {
    const id = String(f.itemId);
    const cur = current.get(id);
    if (forceIds.has(id)) { plan.toWrite.push(f); plan.forced++; continue; }
    if (cur === undefined) { plan.toWrite.push(f); plan.newlyFiled++; if (f.category === UNSORTED) plan.stillUnsorted++; continue; }
    if (cur === UNSORTED) {
      if (f.category !== UNSORTED) { plan.toWrite.push(f); plan.refiledUnsorted++; } else plan.stillUnsorted++;
      continue;
    }
    plan.skipped++;
  }
  return plan;
}
