/**
 * Paddle Billing (Paddle is the merchant of record), selected with PAYMENT_PROVIDER=paddle. Written against Paddle's
 * current documentation (developer.paddle.com): API version 1, bearer API key, notification destinations signed with the
 * Paddle-Signature header. Talks to the REST API with fetch; no SDK dependency.
 *
 *  - SANDBOX by default. An API key that is not a sandbox key (sandbox keys contain "_sdbx") is refused unless
 *    PADDLE_ALLOW_LIVE=yes-i-mean-live, the same posture as the Stripe path.
 *  - With no PADDLE_API_KEY, checkout and portal return clearly-marked mock URLs and nothing is charged.
 *  - Checkout: POST /transactions with the price and quantity (seats for Team) and our tenant id in custom_data. The response's
 *    checkout.url is our own /billing/pay page (Paddle has no hosted checkout; Paddle.js opens it there) with ?_ptxn=<txn>.
 *    Paddle copies the transaction's custom_data onto the subscription it creates, so every later event names the tenant.
 *  - Webhooks are accepted only with a valid Paddle-Signature (PADDLE_WEBHOOK_SECRET): HMAC-SHA256 of "<ts>:<raw body>",
 *    timestamp within 5 seconds, constant-time comparison. With no secret the endpoint answers 503 and changes nothing.
 *  - Only subscription.* events change a plan. Their status is authoritative (Paddle creates a subscription only when the
 *    transaction is paid): active, trialing and past_due keep the paid plan; canceled and paused drop to Free. A cancellation
 *    scheduled for the end of the period leaves the plan in place until Paddle sends the canceled event.
 *  - Paddle does not promise delivery order. Each subscription event carries occurred_at; an older event never overwrites a
 *    newer one, and a late event for an old subscription never downgrades a tenant who has since subscribed again.
 *  - Idempotency tracks the apply (paddle_events, migration 010), exactly as stripe_events does after migration 007.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";
import type { Accounts, Tenant } from "./accounts.js";
import { isPaidStatus, TEAM_MAX_SEATS, type PlanId } from "./plans.js";
import { BillingError, parseSeats, type BillingProvider } from "./billing.js";

export const PADDLE_API = { sandbox: "https://sandbox-api.paddle.com", live: "https://api.paddle.com" } as const;
/** Paddle's guidance: reject a signature whose timestamp is more than 5 seconds from now. */
export const PADDLE_SIGNATURE_TOLERANCE_SEC = 5;

/** The events the notification destination must subscribe to (docs/PADDLE-GO-LIVE.md lists the same). */
export const PADDLE_EVENTS = [
  "subscription.created", "subscription.activated", "subscription.updated", "subscription.canceled",
  "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.trialing",
] as const;

export function isSandboxKey(key: string): boolean { return key.includes("_sdbx"); }

/**
 * Verify a Paddle-Signature header ("ts=<unix seconds>;h1=<hex hmac>") against the raw request body.
 * Never throws; any malformed input is simply invalid. The header can carry several h1 values while a secret is rotating:
 * any one matching is enough.
 */
export function verifyPaddleSignature(rawBody: Buffer | string, header: string | undefined, secret: string, nowMs = Date.now()): boolean {
  if (!header || !secret) return false;
  let ts = "";
  const h1s: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "ts") ts = v; else if (k === "h1") h1s.push(v);
  }
  if (!/^\d{1,12}$/.test(ts) || !h1s.length) return false;
  if (Math.abs(nowMs - Number(ts) * 1000) > PADDLE_SIGNATURE_TOLERANCE_SEC * 1000) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${ts}:${body}`).digest();
  return h1s.some((h) => {
    if (!/^[0-9a-f]{64}$/i.test(h)) return false;
    return timingSafeEqual(expected, Buffer.from(h, "hex"));
  });
}

/** custom_data written by checkout() before the plan rename may say "pro"; it means Personal. */
function paidPlanFromCustomData(v: unknown): PlanId | null {
  if (v === "pro" || v === "personal") return "personal";
  return v === "team" ? "team" : null;
}

export type PaddleFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface PaddleSubscription {
  id: string; status: string; customer_id?: string;
  custom_data?: Record<string, unknown> | null;
  items?: Array<{ quantity?: number; price?: { id?: string } }>;
  scheduled_change?: { action?: string; effective_at?: string } | null;
}
interface PaddleEvent { event_id: string; event_type: string; occurred_at: string; data: unknown }

export class PaddleBilling implements BillingProvider {
  readonly name = "paddle" as const;
  readonly mode: "test" | "live" | "mock";
  private readonly base: string | null;

  constructor(private db: Db, private cfg: SaasConfig, private accounts: Accounts, private fetchFn: PaddleFetch = (u, i) => fetch(u, i)) {
    const key = cfg.paddle.apiKey;
    if (key) {
      if (!isSandboxKey(key) && !cfg.paddle.allowLive) {
        throw new BillingError("Refusing to use a LIVE Paddle key. This build runs in sandbox mode only.", 500);
      }
      this.base = isSandboxKey(key) ? PADDLE_API.sandbox : PADDLE_API.live;
      this.mode = isSandboxKey(key) ? "test" : "live";
    } else { this.base = null; this.mode = "mock"; }
  }

  priceFor(plan: PlanId, interval: "month" | "year" = "month"): string | null {
    const p = this.cfg.paddle.prices;
    if (plan === "personal") return interval === "year" ? p.personalYearly : p.personal;
    return plan === "team" ? p.team : null;
  }

  planForPrice(priceId: string | null | undefined): PlanId | null {
    if (!priceId) return null;
    const p = this.cfg.paddle.prices;
    if (priceId === p.personal || priceId === p.personalYearly) return "personal";
    if (priceId === p.team) return "team";
    return null;
  }

  /** One authenticated call to the Paddle API. The key is never logged or echoed; Paddle's own error detail is passed on. */
  private async api(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any> {
    if (!this.base || !this.cfg.paddle.apiKey) throw new BillingError("Paddle is not configured.", 500);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.paddle.apiKey}`, "Content-Type": "application/json", "Paddle-Version": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BillingError("Could not reach the payment provider. Try again in a moment.", 502);
    }
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = String(json?.error?.detail || json?.error?.code || `HTTP ${res.status}`).slice(0, 300);
      console.error(`[paddle] ${method} ${path} -> ${res.status} ${json?.error?.code ?? ""}`);
      throw new BillingError(`The payment provider refused the request: ${detail}`, 502);
    }
    return json;
  }

  async checkout(tenant: Tenant, plan: PlanId, _email: string, interval: "month" | "year" = "month", seats = 1): Promise<{ url: string; mode: string; id?: string }> {
    if (plan !== "personal" && plan !== "team") throw new BillingError("Choose the personal or team plan.");
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly billing.");
    if (plan === "team" && interval === "year") throw new BillingError("Team is billed monthly.");
    seats = parseSeats(plan, seats);
    if (tenant.plan !== "free" && tenant.paddle_subscription_id) {
      throw new BillingError("You already have a subscription. Use Manage billing to change or cancel it.");
    }
    const base = this.cfg.publicUrl;
    if (!this.base) return { url: `${base}/billing/mock?plan=${plan}&interval=${interval}&seats=${seats}&tenant=${encodeURIComponent(tenant.slug)}`, mode: "mock" };
    const price = this.priceFor(plan, interval);
    if (!price) throw new BillingError(`No Paddle price configured for ${plan} ${interval === "year" ? "yearly" : "monthly"} (set ${plan === "personal" ? (interval === "year" ? "PADDLE_PRICE_PERSONAL_YEARLY" : "PADDLE_PRICE_PERSONAL") : "PADDLE_PRICE_TEAM"}).`, 500);
    const r = await this.api("POST", "/transactions", {
      items: [{ price_id: price, quantity: plan === "team" ? seats : 1 }],
      collection_mode: "automatic",
      ...(tenant.paddle_customer_id ? { customer_id: tenant.paddle_customer_id } : {}),
      custom_data: { tenant_id: tenant.id, tenant_slug: tenant.slug, plan, interval, seats: String(seats) },
      checkout: { url: `${base}/billing/pay` },
    });
    const url = r?.data?.checkout?.url;
    if (typeof url !== "string" || !url.startsWith("https://") && !url.startsWith("http://localhost")) {
      throw new BillingError("The payment provider did not return a checkout link. Check that the default payment link is set and the domain is approved.", 502);
    }
    return { url, mode: this.mode, id: r.data.id };
  }

  async portal(tenant: Tenant): Promise<{ url: string; mode: string }> {
    if (!this.base) return { url: `${this.cfg.publicUrl}/billing/mock?portal=1`, mode: "mock" };
    if (!tenant.paddle_customer_id) throw new BillingError("No billing account yet. Upgrade first.");
    const r = await this.api("POST", `/customers/${encodeURIComponent(tenant.paddle_customer_id)}/portal-sessions`,
      tenant.paddle_subscription_id ? { subscription_ids: [tenant.paddle_subscription_id] } : {});
    const url = r?.data?.urls?.general?.overview;
    if (typeof url !== "string") throw new BillingError("The payment provider did not return a billing link.", 502);
    return { url, mode: this.mode };
  }

  /** Change the seat quantity. The subscription.updated webhook then records it; nothing is changed locally here. */
  async setSeats(tenant: Tenant, seats: number): Promise<{ requested: number; mode: string }> {
    seats = parseSeats("team", seats);
    if (tenant.plan !== "team") throw new BillingError("Seats apply to the Team plan.");
    if (!this.base) return { requested: seats, mode: "mock" };
    if (!tenant.paddle_subscription_id) throw new BillingError("No subscription to change.");
    const price = this.priceFor("team");
    if (!price) throw new BillingError("No Paddle price configured for team (set PADDLE_PRICE_TEAM).", 500);
    await this.api("PATCH", `/subscriptions/${encodeURIComponent(tenant.paddle_subscription_id)}`, {
      items: [{ price_id: price, quantity: seats }],
      proration_billing_mode: "prorated_immediately",
    });
    return { requested: seats, mode: this.mode };
  }

  /** Verify + apply a webhook. Returns a short status for the response body. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined, nowMs = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = this.cfg.paddle.webhookSecret;
    if (!secret) return { status: 503, body: { error: "Webhook secret not configured." } };
    if (!signature) return { status: 400, body: { error: "Missing Paddle-Signature." } };
    if (!verifyPaddleSignature(rawBody, signature, secret, nowMs)) return { status: 400, body: { error: "Bad signature." } };
    let event: PaddleEvent;
    try { event = JSON.parse(rawBody.toString("utf8")); } catch { return { status: 400, body: { error: "Bad payload." } }; }
    if (!event || typeof event.event_id !== "string" || typeof event.event_type !== "string") return { status: 400, body: { error: "Bad payload." } };
    const occurredAt = new Date(event.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) return { status: 400, body: { error: "Bad payload." } };

    // Claim the event. A row already 'applied' is a true duplicate. A 'received'/'failed' row is a redelivery of an event whose
    // apply never finished: claim it again and reprocess (same scheme as stripe_events, migration 007).
    const claim = await this.db.control.query(
      `INSERT INTO paddle_events (id, type, occurred_at, apply_status, attempts) VALUES ($1, $2, $3, 'received', 1)
       ON CONFLICT (id) DO UPDATE SET attempts = paddle_events.attempts + 1
       WHERE paddle_events.apply_status <> 'applied'
       RETURNING id`,
      [event.event_id, event.event_type, occurredAt.toISOString()]);
    if (!claim.rows.length) return { status: 200, body: { received: true, duplicate: true } };

    let tenantId: string | null;
    try {
      tenantId = await this.applyEvent(event, occurredAt);
    } catch (e) {
      await this.db.control.query(
        "UPDATE paddle_events SET apply_status = 'failed', apply_error = $2 WHERE id = $1",
        [event.event_id, (e as Error).message.slice(0, 500)]).catch(() => { /* the original error is the one that matters */ });
      throw e;
    }
    await this.db.control.query(
      "UPDATE paddle_events SET apply_status = 'applied', applied_at = now(), apply_error = NULL, tenant_id = COALESCE($2, tenant_id) WHERE id = $1",
      [event.event_id, tenantId]);
    return { status: 200, body: { received: true, type: event.event_type, applied: Boolean(tenantId) } };
  }

  private async tenantFor(sub: PaddleSubscription): Promise<Tenant | null> {
    const id = sub.custom_data?.tenant_id;
    if (typeof id === "string" && id) { const t = await this.accounts.tenantById(id); if (t) return t; }
    return sub.customer_id ? this.accounts.tenantByPaddleCustomer(sub.customer_id) : null;
  }

  private async applyEvent(event: PaddleEvent, occurredAt: Date): Promise<string | null> {
    if (!event.event_type.startsWith("subscription.")) return null;
    const sub = event.data as PaddleSubscription;
    if (!sub || typeof sub.id !== "string" || typeof sub.status !== "string") return null;
    const t = await this.tenantFor(sub);
    if (!t) return null;

    const item = sub.items?.[0];
    const plan = this.planForPrice(item?.price?.id) ?? paidPlanFromCustomData(sub.custom_data?.plan);
    const paid = Boolean(plan) && isPaidStatus(sub.status);
    // A late "canceled" for an older subscription must not downgrade a tenant who has since subscribed again.
    if (!paid && t.plan !== "free" && t.paddle_subscription_id && t.paddle_subscription_id !== sub.id) return t.id;

    const effective: PlanId = paid ? plan! : "free";
    const seats = effective === "team" ? Math.min(TEAM_MAX_SEATS, Math.max(1, Math.floor(Number(item?.quantity)) || 1)) : 1;
    // The occurred_at guard is in the statement itself, so two events racing cannot apply out of order.
    await this.db.control.query(
      `UPDATE tenants SET plan = $2, plan_status = $3, seats = $4,
              paddle_customer_id = COALESCE($5, paddle_customer_id),
              paddle_subscription_id = CASE WHEN $6 THEN $7 ELSE COALESCE(paddle_subscription_id, $7) END,
              payment_provider = CASE WHEN $2 = 'free' THEN payment_provider ELSE 'paddle' END,
              paddle_event_at = $8, updated_at = now()
       WHERE id = $1 AND (paddle_event_at IS NULL OR paddle_event_at <= $8)`,
      [t.id, effective, sub.status, seats, sub.customer_id ?? null, paid, sub.id, occurredAt.toISOString()]);
    return t.id;
  }
}
