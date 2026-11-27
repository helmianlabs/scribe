/**
 * Stripe billing, TEST MODE by default.
 *  - A live key (sk_live_/rk_live_) is REFUSED unless STRIPE_ALLOW_LIVE=yes-i-mean-live.
 *  - With no STRIPE_SECRET_KEY, checkout and portal return clearly-marked mock URLs.
 *  - Webhooks are accepted only with a valid Stripe-Signature (STRIPE_WEBHOOK_SECRET);
 *    with no secret configured the endpoint answers 503 and changes nothing.
 *  - checkout.session.completed activates a plan only when the session was actually
 *    PAID (payment_status "paid", or "no_payment_required" for trials / fully
 *    discounted checkouts). A completed-but-unpaid session activates nothing.
 *  - Webhook idempotency tracks the APPLY, not just the sighting (migration 007):
 *    an event whose apply failed stays 'failed' in stripe_events and Stripe's
 *    redelivery reprocesses it; only successfully applied events suppress duplicates.
 */
import Stripe from "stripe";
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";
import type { Accounts, Tenant } from "./accounts.js";
import { isPaidStatus, TEAM_MAX_SEATS, type PlanId } from "./plans.js";

/** What app.ts needs from a payment provider (Stripe or Paddle). */
export interface BillingProvider {
  readonly name: "stripe" | "paddle";
  readonly mode: "test" | "live" | "mock";
  checkout(tenant: Tenant, plan: PlanId, email: string, interval?: "month" | "year", seats?: number): Promise<{ url: string; mode: string; id?: string }>;
  portal(tenant: Tenant): Promise<{ url: string; mode: string }>;
  /** Change the seat count on an existing Team subscription. */
  setSeats(tenant: Tenant, seats: number): Promise<{ requested: number; mode: string }>;
}

/** Validate a seat count from a request. Team only; Free and Personal are one seat. */
export function parseSeats(plan: PlanId, v: unknown): number {
  if (plan !== "team") return 1;
  const n = v === undefined || v === null || v === "" ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > TEAM_MAX_SEATS) throw new BillingError(`Choose between 1 and ${TEAM_MAX_SEATS} seats.`);
  return n;
}

/** Stripe metadata written before the plan rename says "pro"; it means Personal. Anything unknown is no paid plan. */
function paidPlanFromMetadata(v: unknown): PlanId | null {
  if (v === "pro" || v === "personal") return "personal";
  return v === "team" ? "team" : null;
}

export class BillingError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

export function assertTestKey(key: string, allowLive: boolean): void {
  if (/^(sk|rk)_live_/.test(key) && !allowLive) {
    throw new BillingError("Refusing to use a LIVE Stripe key. This build runs in test mode only.", 500);
  }
}

export class Billing implements BillingProvider {
  readonly name = "stripe" as const;
  readonly stripe: Stripe | null;
  readonly mode: "test" | "live" | "mock";

  constructor(private db: Db, private cfg: SaasConfig, private accounts: Accounts, stripeOverride?: Stripe) {
    const key = cfg.stripe.secretKey;
    if (stripeOverride) { this.stripe = stripeOverride; this.mode = "test"; }
    else if (key) {
      assertTestKey(key, cfg.stripe.allowLive);
      this.stripe = new Stripe(key, { appInfo: { name: "helmian-scribe" } });
      this.mode = /_live_/.test(key) ? "live" : "test";
    } else { this.stripe = null; this.mode = "mock"; }
  }

  /** Personal has a monthly and a yearly Stripe price; Team has one (per seat). */
  priceFor(plan: PlanId, interval: "month" | "year" = "month"): string | null {
    const p = this.cfg.stripe.prices;
    if (plan === "personal") return interval === "year" ? p.personalYearly : p.personal;
    return plan === "team" ? p.team : null;
  }

  planForPrice(priceId: string | null | undefined): PlanId | null {
    if (!priceId) return null;
    const p = this.cfg.stripe.prices;
    if (priceId === p.personal || priceId === p.personalYearly) return "personal";
    if (priceId === p.team) return "team";
    return null;
  }

  async checkout(tenant: Tenant, plan: PlanId, email: string, interval: "month" | "year" = "month", seats = 1): Promise<{ url: string; mode: string; id?: string }> {
    if (plan !== "personal" && plan !== "team") throw new BillingError("Choose the personal or team plan.");
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly billing.");
    if (plan === "team" && interval === "year") throw new BillingError("Team is billed monthly.");
    seats = parseSeats(plan, seats);
    const base = this.cfg.publicUrl;
    if (!this.stripe) {
      return { url: `${base}/billing/mock?plan=${plan}&interval=${interval}&seats=${seats}&tenant=${encodeURIComponent(tenant.slug)}`, mode: "mock" };
    }
    const price = this.priceFor(plan, interval);
    if (!price) throw new BillingError(`No Stripe price configured for ${plan} ${interval === "year" ? "yearly" : "monthly"} (set ${plan === "personal" ? (interval === "year" ? "STRIPE_PRICE_PERSONAL_YEARLY" : "STRIPE_PRICE_PERSONAL") : "STRIPE_PRICE_TEAM"}).`, 500);
    let customer = tenant.stripe_customer_id;
    if (!customer) {
      const c = await this.stripe.customers.create({ email, metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug } });
      customer = c.id;
      await this.db.control.query("UPDATE tenants SET stripe_customer_id = $2, updated_at = now() WHERE id = $1", [tenant.id, customer]);
    }
    const s = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: tenant.id,
      line_items: [{ price, quantity: plan === "team" ? seats : 1, ...(plan === "team" ? { adjustable_quantity: { enabled: true, minimum: 1, maximum: TEAM_MAX_SEATS } } : {}) }],
      metadata: { tenant_id: tenant.id, plan, interval, seats: String(seats) },
      subscription_data: { metadata: { tenant_id: tenant.id, plan, seats: String(seats) } },
      allow_promotion_codes: true,
      success_url: `${base}/dashboard?billing=success`,
      cancel_url: `${base}/dashboard?billing=cancelled`,
    });
    return { url: s.url!, mode: this.mode, id: s.id };
  }

  async portal(tenant: Tenant): Promise<{ url: string; mode: string }> {
    if (!this.stripe) return { url: `${this.cfg.publicUrl}/billing/mock?portal=1`, mode: "mock" };
    if (!tenant.stripe_customer_id) throw new BillingError("No billing account yet. Upgrade first.");
    const s = await this.stripe.billingPortal.sessions.create({ customer: tenant.stripe_customer_id, return_url: `${this.cfg.publicUrl}/dashboard` });
    return { url: s.url, mode: this.mode };
  }

  /** Change the seat quantity on the tenant's Team subscription. The webhook then records it (customer.subscription.updated). */
  async setSeats(tenant: Tenant, seats: number): Promise<{ requested: number; mode: string }> {
    seats = parseSeats("team", seats);
    if (tenant.plan !== "team") throw new BillingError("Seats apply to the Team plan.");
    if (!this.stripe) return { requested: seats, mode: "mock" };
    if (!tenant.stripe_subscription_id) throw new BillingError("No subscription to change.");
    const sub = await this.stripe.subscriptions.retrieve(tenant.stripe_subscription_id);
    const item = sub.items.data[0];
    if (!item) throw new BillingError("The subscription has no items.", 500);
    await this.stripe.subscriptions.update(sub.id, { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" });
    return { requested: seats, mode: this.mode };
  }

  /** Verify + apply a webhook. Returns a short status for the response body. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = this.cfg.stripe.webhookSecret;
    if (!secret) return { status: 503, body: { error: "Webhook secret not configured." } };
    if (!signature) return { status: 400, body: { error: "Missing Stripe-Signature." } };
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      return { status: 400, body: { error: "Bad signature." } };
    }
    if (event.livemode && !this.cfg.stripe.allowLive) return { status: 400, body: { error: "Live-mode events are not accepted by this build." } };

    // Claim the event (apply tracking: migration 007). A row already marked
    // 'applied' is a true duplicate and is suppressed below. A row in
    // 'received'/'failed' is a redelivery of an event whose apply never
    // finished — claim it again and reprocess, instead of swallowing it as a
    // duplicate (the pre-007 handler inserted the row BEFORE applying, so a
    // single apply failure poisoned the event forever). The claim and the
    // attempts counter move together; only the 'applied' mark at the end
    // suppresses future deliveries. (Two deliveries racing the same event can
    // both claim; applyEvent only writes tenant state via setPlan, so a double
    // apply of the same event converges to the same state.)
    const claim = await this.db.control.query(
      `INSERT INTO stripe_events (id, type, apply_status, attempts) VALUES ($1, $2, 'received', 1)
       ON CONFLICT (id) DO UPDATE SET attempts = stripe_events.attempts + 1
       WHERE stripe_events.apply_status <> 'applied'
       RETURNING id`,
      [event.id, event.type]);
    if (!claim.rows.length) return { status: 200, body: { received: true, duplicate: true } };

    let tenantId: string | null;
    try {
      tenantId = await this.applyEvent(event);
    } catch (e) {
      // Record the failure, then rethrow: the route answers 500 and Stripe
      // retries with backoff. The row stays 'failed', so the retry reprocesses
      // the event (claim above) instead of reporting it as a duplicate.
      await this.db.control.query(
        "UPDATE stripe_events SET apply_status = 'failed', apply_error = $2 WHERE id = $1",
        [event.id, (e as Error).message.slice(0, 500)]).catch(() => { /* the original error is the one that matters */ });
      throw e;
    }
    await this.db.control.query(
      "UPDATE stripe_events SET apply_status = 'applied', applied_at = now(), apply_error = NULL, tenant_id = COALESCE($2, tenant_id) WHERE id = $1",
      [event.id, tenantId]);
    return { status: 200, body: { received: true, type: event.type, applied: Boolean(tenantId) } };
  }

  private async tenantFor(obj: { metadata?: Record<string, string> | null; customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null; client_reference_id?: string | null }): Promise<Tenant | null> {
    const id = obj.metadata?.tenant_id || obj.client_reference_id;
    if (id) { const t = await this.accounts.tenantById(id); if (t) return t; }
    const cust = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
    return cust ? this.accounts.tenantByCustomer(cust) : null;
  }

  private async setPlan(tenantId: string, plan: PlanId, status: string, customer?: string | null, subscription?: string | null, seats = 1) {
    await this.db.control.query(
      `UPDATE tenants SET plan = $2, plan_status = $3, stripe_customer_id = COALESCE($4, stripe_customer_id),
              stripe_subscription_id = COALESCE($5, stripe_subscription_id), seats = $6,
              payment_provider = CASE WHEN $2 = 'free' THEN payment_provider ELSE 'stripe' END, updated_at = now() WHERE id = $1`,
      [tenantId, plan, status, customer ?? null, subscription ?? null, plan === "team" ? Math.min(TEAM_MAX_SEATS, Math.max(1, Math.floor(seats) || 1)) : 1]);
  }

  private async applyEvent(event: Stripe.Event): Promise<string | null> {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const t = await this.tenantFor(s);
        if (!t) return null;
        const plan = paidPlanFromMetadata(s.metadata?.plan) ?? "personal";
        if (plan !== "personal" && plan !== "team") return null;
        // Payment gate: completing a session is not the same as being paid.
        // An async or failing payment method can complete the session with
        // payment_status "unpaid"; activating on metadata alone (the pre-B8
        // behavior) would hand out a paid plan that was never paid for.
        // "no_payment_required" is a genuinely settled session (trial or
        // fully discounted checkout) and activates; the subscription events
        // below carry the subscription's true status from then on. A missing
        // payment_status proves nothing — Stripe has sent the field on every
        // checkout.session.completed for years — so it is refused the same
        // way. When an unpaid session is later paid, Stripe sends
        // checkout.session.async_payment_succeeded plus subscription/invoice
        // events; those set the plan then.
        if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
          console.error(`[billing] checkout.session.completed session=${s.id} tenant=${t.id} payment_status=${JSON.stringify(s.payment_status ?? null)} — NOT activating plan=${plan} (session completed without payment).`);
          return null;
        }
        const sub = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        const cust = typeof s.customer === "string" ? s.customer : s.customer?.id;
        await this.setPlan(t.id, plan, "active", cust, sub, Number(s.metadata?.seats) || 1);
        return t.id;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const t = await this.tenantFor(sub);
        if (!t) return null;
        const price = sub.items?.data?.[0]?.price?.id;
        const plan = this.planForPrice(price) ?? paidPlanFromMetadata(sub.metadata?.plan);
        const effective: PlanId = isPaidStatus(sub.status) && plan ? plan : "free";
        await this.setPlan(t.id, effective, sub.status, typeof sub.customer === "string" ? sub.customer : sub.customer.id, sub.id, sub.items?.data?.[0]?.quantity ?? 1);
        return t.id;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const t = await this.tenantFor(sub);
        if (!t) return null;
        await this.setPlan(t.id, "free", "canceled");
        return t.id;
      }
      default:
        return null;
    }
  }
}
