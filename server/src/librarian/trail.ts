import type { Filing, RuleHit } from './types.ts';

/** One matched rule, in plain words, as shown by explain_filing. */
export interface TrailStep {
  step: number;
  rule_key: string;
  layer: string;
  priority: number;
  files_in: string | null;       // the shelf this rule votes for (null = tag-only rule)
  matched: string[];
  why: string | null;
  pass: number;
  needed_tags?: string[];
  decided: boolean;              // true for the rule that actually filed it
}

/** The complete list of rules that matched (not only the winner), highest priority first. */
export function trailOf(hits: RuleHit[] | null | undefined, winningRule: string | null, category?: string): TrailStep[] {
  const list = Array.isArray(hits) ? hits : [];
  const winnerKey = winningRule ?? list.find((h) => h.category && (!category || h.category === category))?.ruleId ?? null;
  return list.map((h, i) => ({
    step: i + 1,
    rule_key: h.ruleId,
    layer: h.layer,
    priority: h.priority,
    files_in: h.category ?? null,
    matched: Array.isArray(h.matched) ? h.matched : [],
    why: h.description ?? null,
    pass: h.pass ?? 1,
    ...(h.via?.length ? { needed_tags: h.via } : {}),
    decided: h.ruleId === winnerKey,
  }));
}

export const trailOfFiling = (f: Pick<Filing, 'hits' | 'winningRule' | 'category'>): TrailStep[] => trailOf(f.hits, f.winningRule, f.category);

/** "How the rules were weighed" in one plain sentence, for the top of an explanation. */
export function trailSummary(steps: TrailStep[]): string {
  if (!steps.length) return 'No rule matched.';
  const voters = steps.filter((s) => s.files_in);
  const tagOnly = steps.length - voters.length;
  const chained = steps.filter((s) => s.pass > 1).length;
  return `${steps.length} rule${steps.length === 1 ? '' : 's'} matched (${voters.length} voted for a shelf, ${tagOnly} only added tags` + (chained ? `, ${chained} fired because another rule added a tag` : '') + '); the highest priority vote won.';
}
