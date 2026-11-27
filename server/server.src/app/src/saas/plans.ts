/**
 * Plans and limits. Prices live in the payment provider (Stripe or Paddle); this file is the source of truth for limits and features.
 *
 * Tiers (owner-approved 2026-11-26):
 *   Free      1,000 memories, 50 MB, every MCP connector, Librarian filing with the why-trail, 3 typed rules,
 *             search and recall, export.
 *   Personal  $8/month or $80/year. Adds learning, unlimited rules, people/places/companies shelves, the knowledge
 *             graph, unlimited memories, 5 GB, ChatGPT/Claude import, daily backups.
 *   Team      $15 per seat per month.
 * Daily call caps are separate (CALLS_PER_DAY below): Free 500, Personal 10,000, Team 10,000 per seat.
 */
export type PlanId = "free" | "personal" | "team";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/**
 * Daily call caps (abuse and runaway-agent protection, not a feature). Counted per tenant per UTC day in usage_daily, in the
 * database, so the cap holds across restarts and replicas. These are chosen numbers, not Troy's: change them here.
 * Every MCP tool call, flags-API call with an API key and history import counts as one call; search, read and export through
 * the dashboard session do not. A refused call is not counted.
 */
export const CALLS_PER_DAY = {
  free: 500,
  personal: 10_000,
  /** Team: per seat, times the seats on the subscription. */
  teamPerSeat: 10_000,
} as const;

/** Most seats a Team subscription can have (also the Paddle price's quantity maximum). */
export const TEAM_MAX_SEATS = 100;

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
  maxCallsPerDay: number;           // per UTC day; Team's is CALLS_PER_DAY.teamPerSeat x seats (see planFor)
  maxApiKeys: number;
  maxMembers: number;
  features: PlanFeatures;
}

const NONE: PlanFeatures = { learning: false, entityShelves: false, graph: false, importHistory: false, dailyBackups: false };
const ALL: PlanFeatures = { learning: true, entityShelves: true, graph: true, importHistory: true, dailyBackups: true };

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", priceUsdMonthly: 0, priceUsdYearly: null, perSeat: false,
    maxMemories: 1_000, maxBytes: 50 * MB, maxTypedRules: 3, maxCallsPerDay: CALLS_PER_DAY.free, maxApiKeys: 1, maxMembers: 1, features: NONE,
  },
  personal: {
    id: "personal", name: "Personal", priceUsdMonthly: 8, priceUsdYearly: 80, perSeat: false,
    maxMemories: null, maxBytes: 5 * GB, maxTypedRules: null, maxCallsPerDay: CALLS_PER_DAY.personal, maxApiKeys: 5, maxMembers: 1, features: ALL,
  },
  // The owner specified only the Team price. Storage and API keys below are placeholders (Personal's storage per account,
  // the pre-existing key count). Members and the daily call cap come from the seats on the subscription (see planFor);
  // there is no invite flow yet, so members are an allowance, not a feature.
  team: {
    id: "team", name: "Team", priceUsdMonthly: 15, priceUsdYearly: null, perSeat: true,
    maxMemories: null, maxBytes: 5 * GB, maxTypedRules: null, maxCallsPerDay: CALLS_PER_DAY.teamPerSeat, maxApiKeys: 25, maxMembers: 1, features: ALL,
  },
};

/**
 * Map a stored plan id to a plan. The retired id "pro" (migration 009 renames it) is read as Personal. `seats` is the
 * subscription's seat quantity: it sets Team's member allowance and scales its daily call cap. An override wins last.
 */
export function planFor(id: string | null | undefined, override?: Partial<Record<PlanId, Partial<Plan>>>, seats = 1): Plan {
  const key = id === "pro" ? "personal" : id;
  const base = PLANS[(key as PlanId) in PLANS ? (key as PlanId) : "free"];
  const n = Math.max(1, Math.min(TEAM_MAX_SEATS, Math.floor(Number(seats)) || 1));
  const seated: Plan = base.perSeat ? { ...base, maxMembers: n, maxCallsPerDay: CALLS_PER_DAY.teamPerSeat * n } : base;
  return { ...seated, ...(override?.[base.id] ?? {}) };
}

/** Subscription states that keep a paid plan active. */
export function isPaidStatus(status: string): boolean {
  return ["active", "trialing", "past_due"].includes(status);
}

export type LimitKind = "memories" | "bytes" | "rules" | "api_keys" | "feature" | "calls";

export class LimitError extends Error {
  constructor(message: string, public kind: LimitKind) { super(message); }
}

export const fmtBytes = (n: number): string => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);
