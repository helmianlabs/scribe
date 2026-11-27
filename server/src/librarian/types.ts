/** One memory row as the Librarian sees it (a row of `messages` joined to its conversation). */
export interface MemoryItem {
  id: number | string;
  text: string;
  sender?: string | null;            // 'human' | 'assistant' in the original schema
  conversationName?: string | null;  // e.g. "Shared Memory — muse"
  source?: string | null;            // which AI/app/tool wrote it (if known)
  createdAt?: string | null;
}

export type Shape = 'code' | 'pr' | 'commit' | 'error' | 'chat';

/** Trigger layers, in the order the spec lists them, plus custom and learned rules. */
export type Layer = 'source' | 'shape' | 'content' | 'custom' | 'learned' | 'manual';

export interface RuleWhen {
  /** Any of these source names (case-insensitive, exact after normalising). */
  source?: string[];
  /** Any of these shapes. */
  shape?: Shape[];
  /** Any of these words or phrases appear (whole word, case-insensitive, plural "s" allowed). */
  anyWords?: string[];
  /** All of these words or phrases appear. */
  allWords?: string[];
  /**
   * Any of these tags is present: on the item's leading [tags: ...] line OR added by another rule that
   * already matched (rule chaining; see MAX_CHAIN_PASSES in engine.ts).
   */
  tags?: string[];
  /** Any of these words appear in the notebook/conversation name. */
  conversationWords?: string[];
  /** None of these words may appear (guards against false hits). */
  noneWords?: string[];
  /**
   * Any of these regular expressions matches the text (case-sensitive, Unicode). Used by the built-in
   * entity rules (people, places, organisations). Only honoured on preset (`source`/`shape`/`content`)
   * rules: custom and learned rules come from the database and never run patterns.
   */
  patterns?: string[];
  /** None of these regular expressions may match (same limits as `patterns`). */
  nonePatterns?: string[];
  /** At least one of these must ALSO appear (context gate for weak trigger words). */
  withAny?: string[];
}

export interface Rule {
  id: string;
  layer: Layer;
  when: RuleWhen;
  /** Category slug this rule files into. Omit for a tag-only rule. */
  category?: string;
  /** Tags this rule adds (accumulate across every matching rule). */
  addTags?: string[];
  /** Higher wins. Ties broken by layer rank, then rule id. */
  priority: number;
  /** Plain words shown to the user: why this rule exists. */
  description: string;
  enabled?: boolean;
}

export interface Rulebook {
  id: string;            // e.g. "preset-d"
  name: string;
  description: string;
  categories: { slug: string; name: string; parent?: string }[];
  rules: Rule[];
  /**
   * Text spans blanked out before word rules look at the text: infrastructure names (URLs, hostnames,
   * file paths, database/cloud project ids) that contain a business name without being about it.
   */
  ignore?: { pattern: string; why: string }[];
}

export interface RuleHit {
  ruleId: string;
  layer: Layer;
  category?: string;
  priority: number;
  /** The exact thing that matched, e.g. 'word "invoice"' or 'shape code'. */
  matched: string[];
  /** Plain words: why the rule exists (so the whole trail can be read without the rulebook). */
  description?: string;
  /** Which chaining pass matched it: 1 = from the text itself, 2+ = needed a tag another rule added. */
  pass?: number;
  /** For pass 2+: the tags it needed and the rule that added each, e.g. `organization (from rule content.org-named)`. */
  via?: string[];
}

export interface Filing {
  itemId: MemoryItem['id'];
  category: string;      // UNSORTED when nothing filed it
  tags: string[];
  rulebook: string;
  winningRule: string | null;
  explanation: string;   // plain words
  hits: RuleHit[];
  shape: Shape;
  source: string | null;
}

export const UNSORTED = 'unsorted';
