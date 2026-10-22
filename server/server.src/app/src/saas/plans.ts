/** Plans and limits. Prices live in Stripe; this file is the source of truth for limits. */
export type PlanId = "free" | "pro" | "team";

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;   // display only; Stripe Price is authoritative
  maxMemories: number;
  callsPerDay: number;
  maxApiKeys: number;
  maxMembers: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", priceUsdMonthly: 0, maxMemories: 2_000, callsPerDay: 300, maxApiKeys: 1, maxMembers: 1 },
  pro: { id: "pro", name: "Pro", priceUsdMonthly: 15, maxMemories: 100_000, callsPerDay: 20_000, maxApiKeys: 5, maxMembers: 1 },
  team: { id: "team", name: "Team", priceUsdMonthly: 49, maxMemories: 1_000_000, callsPerDay: 100_000, maxApiKeys: 25, maxMembers: 10 },
};

export function planFor(id: string | null | undefined, override?: Partial<Record<PlanId, Partial<Plan>>>): Plan {
  const base = PLANS[(id as PlanId) in PLANS ? (id as PlanId) : "free"];
  return { ...base, ...(override?.[base.id] ?? {}) };
}

/** Subscription states that keep a paid plan active. */
export function isPaidStatus(status: string): boolean {
  return ["active", "trialing", "past_due"].includes(status);
}

export class LimitError extends Error {
  constructor(message: string, public kind: "memories" | "calls" | "api_keys") { super(message); }
}
