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
export type Layer = 'source' | 'shape' | 'content' | 'custom' | 'learned';

export interface RuleWhen {
  /** Any of these source names (case-insensitive, exact after normalising). */
  source?: string[];
  /** Any of these shapes. */
  shape?: Shape[];
  /** Any of these words or phrases appear (whole word, case-insensitive, plural "s" allowed). */
  anyWords?: string[];
  /** All of these words or phrases appear. */
  allWords?: string[];
  /** Any of these tags is on the item's leading [tags: ...] line. */
  tags?: string[];
  /** Any of these words appear in the notebook/conversation name. */
  conversationWords?: string[];
  /** None of these words may appear (guards against false hits). */
  noneWords?: string[];
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
}

export interface RuleHit {
  ruleId: string;
  layer: Layer;
  category?: string;
  priority: number;
  /** The exact thing that matched, e.g. 'word "invoice"' or 'shape code'. */
  matched: string[];
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
