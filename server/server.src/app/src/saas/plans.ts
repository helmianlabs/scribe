/**
 * Plans and limits. Prices live in Stripe; this file is the source of truth for limits and features.
 *
 * Tiers (owner-approved 2026-11-26):
 *   Free      1,000 memories, 50 MB, every MCP connector, Librarian filing with the why-trail, 3 typed rules,
 *             search and recall, export.
 *   Personal  $8/month or $80/year. Adds learning, unlimited rules, people/places/companies shelves, the knowledge
 *             graph, unlimited memories, 5 GB, ChatGPT/Claude import, daily backups.
 *   Team      $15 per seat per month.
 */
export type PlanId = "free" | "personal" | "team";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export interface PlanFeatures {
  /** Moving a memory teaches the Librarian a rule (the learning flywheel). */
  learning: boolean;
  /** The people / places / organizations shelves and the rules that feed them. */
  entityShelves: boolean;
  /** graph_neighbors and the knowledge graph. (The hosted server does not build the graph yet; the flag is the entitlement.) */
  graph: boolean;
  /** Upload a Claude or ChatGPT export (POST /api/import). */
  importHistory: boolean;
  /** Daily backups. (No backup job exists in this repo yet; the flag is the entitlement.) */
  dailyBackups: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;          // display only; Stripe Price is authoritative
  priceUsdYearly: number | null;    // display only
  perSeat: boolean;
  maxMemories: number | null;       // null = unlimited
  maxBytes: number;                 // stored memory text, in bytes
  maxTypedRules: number | null;     // rules typed with add_rule; null = unlimited
  maxApiKeys: number;
  maxMembers: number;
  features: PlanFeatures;
}

const NONE: PlanFeatures = { learning: false, entityShelves: false, graph: false, importHistory: false, dailyBackups: false };
const ALL: PlanFeatures = { learning: true, entityShelves: true, graph: true, importHistory: true, dailyBackups: true };

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", priceUsdMonthly: 0, priceUsdYearly: null, perSeat: false,
    maxMemories: 1_000, maxBytes: 50 * MB, maxTypedRules: 3, maxApiKeys: 1, maxMembers: 1, features: NONE,
  },
  personal: {
    id: "personal", name: "Personal", priceUsdMonthly: 8, priceUsdYearly: 80, perSeat: false,
    maxMemories: null, maxBytes: 5 * GB, maxTypedRules: null, maxApiKeys: 5, maxMembers: 1, features: ALL,
  },
  // The owner specified only the Team price. Storage, API keys and members below are placeholders: Personal's storage
  // per account, and the pre-existing key and member counts. Seats are not enforced (there is no invite flow yet).
  team: {
    id: "team", name: "Team", priceUsdMonthly: 15, priceUsdYearly: null, perSeat: true,
    maxMemories: null, maxBytes: 5 * GB, maxTypedRules: null, maxApiKeys: 25, maxMembers: 10, features: ALL,
  },
};

/** Map a stored plan id to a plan. The retired id "pro" (migration 009 renames it) is read as Personal. */
export function planFor(id: string | null | undefined, override?: Partial<Record<PlanId, Partial<Plan>>>): Plan {
  const key = id === "pro" ? "personal" : id;
  const base = PLANS[(key as PlanId) in PLANS ? (key as PlanId) : "free"];
  return { ...base, ...(override?.[base.id] ?? {}) };
}

/** Subscription states that keep a paid plan active. */
export function isPaidStatus(status: string): boolean {
  return ["active", "trialing", "past_due"].includes(status);
}

export type LimitKind = "memories" | "bytes" | "rules" | "api_keys" | "feature";

export class LimitError extends Error {
  constructor(message: string, public kind: LimitKind) { super(message); }
}

export const fmtBytes = (n: number): string => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);
