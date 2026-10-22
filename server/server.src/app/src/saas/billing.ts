/**
 * Stripe billing, TEST MODE by default.
 *  - A live key (sk_live_/rk_live_) is REFUSED unless STRIPE_ALLOW_LIVE=yes-i-mean-live.
 *  - With no STRIPE_SECRET_KEY, checkout and portal return clearly-marked mock URLs.
 *  - Webhooks are accepted only with a valid Stripe-Signature (STRIPE_WEBHOOK_SECRET);
 *    with no secret configured the endpoint answers 503 and changes nothing.
 */
import Stripe from "stripe";
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";
import type { Accounts, Tenant } from "./accounts.js";
import { isPaidStatus, type PlanId } from "./plans.js";

export class BillingError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

export function assertTestKey(key: string, allowLive: boolean): void {
  if (/^(sk|rk)_live_/.test(key) && !allowLive) {
    throw new BillingError("Refusing to use a LIVE Stripe key. This build runs in test mode only.", 500);
  }
}

export class Billing {
  readonly stripe: Stripe | null;
  readonly mode: "test" | "live" | "mock";

  constructor(private db: Db, private cfg: SaasConfig, private accounts: Accounts, stripeOverride?: Stripe) {
    const key = cfg.stripe.secretKey;
    if (stripeOverride) { this.stripe = stripeOverride; this.mode = "test"; }
    else if (key) {
      assertTestKey(key, cfg.stripe.allowLive);
      this.stripe = new Stripe(key, { appInfo: { name: "shared-memory-saas" } });
      this.mode = /_live_/.test(key) ? "live" : "test";
    } else { this.stripe = null; this.mode = "mock"; }
  }

  priceFor(plan: PlanId): string | null {
    return plan === "pro" ? this.cfg.stripe.prices.pro : plan === "team" ? this.cfg.stripe.prices.team : null;
  }

  planForPrice(priceId: string | null | undefined): PlanId | null {
    if (!priceId) return null;
    if (priceId === this.cfg.stripe.prices.pro) return "pro";
    if (priceId === this.cfg.stripe.prices.team) return "team";
    return null;
  }

  async checkout(tenant: Tenant, plan: PlanId, email: string): Promise<{ url: string; mode: string; id?: string }> {
    if (plan !== "pro" && plan !== "team") throw new BillingError("Choose the pro or team plan.");
    const base = this.cfg.publicUrl;
    if (!this.stripe) {
      return { url: `${base}/billing/mock?plan=${plan}&tenant=${encodeURIComponent(tenant.slug)}`, mode: "mock" };
    }
    const price = this.priceFor(plan);
    if (!price) throw new BillingError(`No Stripe price configured for ${plan} (set STRIPE_PRICE_${plan.toUpperCase()}).`, 500);
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
      line_items: [{ price, quantity: 1 }],
      metadata: { tenant_id: tenant.id, plan },
      subscription_data: { metadata: { tenant_id: tenant.id, plan } },
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

    const seen = await this.db.control.query("INSERT INTO stripe_events (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id", [event.id, event.type]);
    if (!seen.rows.length) return { status: 200, body: { received: true, duplicate: true } };

    const tenantId = await this.applyEvent(event);
    if (tenantId) await this.db.control.query("UPDATE stripe_events SET tenant_id = $2 WHERE id = $1", [event.id, tenantId]);
    return { status: 200, body: { received: true, type: event.type, applied: Boolean(tenantId) } };
  }

  private async tenantFor(obj: { metadata?: Record<string, string> | null; customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null; client_reference_id?: string | null }): Promise<Tenant | null> {
    const id = obj.metadata?.tenant_id || obj.client_reference_id;
    if (id) { const t = await this.accounts.tenantById(id); if (t) return t; }
    const cust = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
    return cust ? this.accounts.tenantByCustomer(cust) : null;
  }

  private async setPlan(tenantId: string, plan: PlanId, status: string, customer?: string | null, subscription?: string | null) {
    await this.db.control.query(
      `UPDATE tenants SET plan = $2, plan_status = $3, stripe_customer_id = COALESCE($4, stripe_customer_id),
              stripe_subscription_id = COALESCE($5, stripe_subscription_id), updated_at = now() WHERE id = $1`,
      [tenantId, plan, status, customer ?? null, subscription ?? null]);
  }

  private async applyEvent(event: Stripe.Event): Promise<string | null> {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const t = await this.tenantFor(s);
        if (!t) return null;
        const plan = (s.metadata?.plan as PlanId) || "pro";
        if (plan !== "pro" && plan !== "team") return null;
        const sub = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        const cust = typeof s.customer === "string" ? s.customer : s.customer?.id;
        await this.setPlan(t.id, plan, "active", cust, sub);
        return t.id;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const t = await this.tenantFor(sub);
        if (!t) return null;
        const price = sub.items?.data?.[0]?.price?.id;
        const plan = this.planForPrice(price) ?? ((sub.metadata?.plan as PlanId) || null);
        const effective: PlanId = isPaidStatus(sub.status) && plan ? plan : "free";
        await this.setPlan(t.id, effective, sub.status, typeof sub.customer === "string" ? sub.customer : sub.customer.id, sub.id);
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
