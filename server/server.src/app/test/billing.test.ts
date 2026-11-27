/**
 * Stripe hardening (B8): the two B1 caveats, pinned by tests.
 *  (a) checkout.session.completed activates ONLY on payment — an unpaid (or
 *      payment-status-less) session leaves the tenant on Free.
 *  (b) A webhook event whose APPLY fails is not poisoned: the stripe_events
 *      row stays 'failed' (migration 007), Stripe's redelivery reprocesses it,
 *      it applies exactly once, and only then do further deliveries read as
 *      duplicates.
 * Events are fabricated and locally signed, exactly like the pre-existing
 * webhook test — this proves the handler's logic, never Stripe's delivery.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { startSaas, signIn, api, type Saas } from "./helpers.ts";

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

async function postEvent(event: unknown): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify(event);
  const secret = s.cfg.stripe.webhookSecret!;
  const r = await fetch(`${s.base}/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload,
  });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}

const checkoutEvent = (id: string, tenantId: string, plan: string, paymentStatus?: string) => ({
  id, object: "event", type: "checkout.session.completed", livemode: false,
  data: {
    object: {
      id: `cs_${id}`, object: "checkout.session", client_reference_id: tenantId,
      customer: `cus_${id}`, subscription: `sub_${id}`,
      ...(paymentStatus === undefined ? {} : { payment_status: paymentStatus }),
      metadata: { tenant_id: tenantId, plan },
    },
  },
});

const eventRow = async (id: string) =>
  (await s.pg.query<any>("SELECT id, type, tenant_id, apply_status, apply_error, applied_at, attempts FROM stripe_events WHERE id = $1", [id])).rows[0];

const planOf = async (cookie: string) => (await api(s, cookie)("/api/me")).body.plan.id;

test("unpaid (and payment-status-less) checkout.session.completed activates nothing", async () => {
  const cookie = await signIn(s, "unpaid@example.com");
  const me = (await api(s, cookie)("/api/me")).body;
  assert.equal(me.plan.id, "free");

  const unpaid = await postEvent(checkoutEvent("evt_b8_unpaid", me.tenant.id, "personal", "unpaid"));
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.body.applied, false, "unpaid session must not report an apply");
  assert.equal(await planOf(cookie), "free", "unpaid session leaves the tenant on Free");
  const row1 = await eventRow("evt_b8_unpaid");
  assert.equal(row1.apply_status, "applied", "the event was handled deterministically — redelivery cannot change its payment_status");
  assert.equal(row1.attempts, 1);

  const noStatus = await postEvent(checkoutEvent("evt_b8_nostatus", me.tenant.id, "personal"));
  assert.equal(noStatus.status, 200);
  assert.equal(noStatus.body.applied, false, "a missing payment_status proves nothing and must not activate");
  assert.equal(await planOf(cookie), "free");
});

test("paid checkout.session.completed activates; no_payment_required (trial/discounted) activates too", async () => {
  const paidCookie = await signIn(s, "paid@example.com");
  const paidMe = (await api(s, paidCookie)("/api/me")).body;
  const paid = await postEvent(checkoutEvent("evt_b8_paid", paidMe.tenant.id, "team", "paid"));
  assert.equal(paid.status, 200);
  assert.equal(paid.body.applied, true);
  assert.equal(await planOf(paidCookie), "team");
  const row = await eventRow("evt_b8_paid");
  assert.equal(row.apply_status, "applied");
  assert.equal(row.tenant_id, paidMe.tenant.id);
  assert.ok(row.applied_at, "applied_at is stamped");

  const trialCookie = await signIn(s, "trial@example.com");
  const trialMe = (await api(s, trialCookie)("/api/me")).body;
  const trial = await postEvent(checkoutEvent("evt_b8_trial", trialMe.tenant.id, "personal", "no_payment_required"));
  assert.equal(trial.body.applied, true);
  assert.equal(await planOf(trialCookie), "personal");
});

test("apply failure -> 500 + 'failed' row; redelivery applies exactly once; third delivery is a duplicate", async () => {
  const cookie = await signIn(s, "retry@example.com");
  const me = (await api(s, cookie)("/api/me")).body;
  const event = {
    id: "evt_b8_retry", object: "event", type: "customer.subscription.updated", livemode: false,
    data: {
      object: {
        id: "sub_b8_retry", object: "subscription", customer: "cus_b8_retry", status: "active",
        metadata: { tenant_id: me.tenant.id, plan: "personal" },
        items: { data: [{ price: { id: "price_pro_test" } }] },
      },
    },
  };

  // Sabotage the apply: the app role loses UPDATE on tenants, so setPlan throws
  // mid-apply — after the event has been claimed. Restore in finally so no
  // later test inherits the sabotage.
  await s.pg.query("REVOKE UPDATE ON tenants FROM memory_app");
  let first: { status: number; body: any } = { status: 0, body: null };
  try {
    first = await postEvent(event);
  } finally {
    await s.pg.query("GRANT UPDATE ON tenants TO memory_app");
  }
  assert.equal(first.status, 500, "an apply failure must surface as 500 so Stripe retries");
  const failed = await eventRow("evt_b8_retry");
  assert.equal(failed.apply_status, "failed");
  assert.equal(failed.attempts, 1);
  assert.match(failed.apply_error ?? "", /permission denied/i);
  assert.equal(await planOf(cookie), "free", "the failed apply changed nothing");

  // Stripe redelivers the SAME event: it is reprocessed, not swallowed.
  const second = await postEvent(event);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, undefined);
  assert.equal(second.body.applied, true);
  assert.equal(await planOf(cookie), "personal", "the redelivery applied the entitlement");
  const applied = await eventRow("evt_b8_retry");
  assert.equal(applied.apply_status, "applied");
  assert.equal(applied.attempts, 2, "exactly two claims: the failed delivery and the successful redelivery");
  assert.equal(applied.apply_error, null);
  assert.ok(applied.applied_at);

  // A further delivery of the now-applied event is a true duplicate: no
  // re-apply, no extra claim.
  const third = await postEvent(event);
  assert.equal(third.status, 200);
  assert.equal(third.body.duplicate, true);
  assert.equal((await eventRow("evt_b8_retry")).attempts, 2);
  assert.equal(await planOf(cookie), "personal");
});

test("mock mode end-to-end still works without a Stripe key (checkout + portal)", async () => {
  const cookie = await signIn(s, "mocky@example.com");
  const co = await api(s, cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "personal" }) });
  assert.equal(co.status, 200);
  assert.equal(co.body.mode, "mock");
  assert.match(co.body.url, /\/billing\/mock/);
  const po = await api(s, cookie)("/api/billing/portal", { method: "POST", body: JSON.stringify({}) });
  assert.equal(po.status, 200);
  assert.equal(po.body.mode, "mock");
  assert.match(po.body.url, /\/billing\/mock/);
});

test("Stripe Team: the seat quantity is recorded from the subscription, scales the plan, and drops to one seat on cancel", async () => {
  const cookie = await signIn(s, "stripe-seats@example.com");
  const me = (await api(s, cookie)("/api/me")).body;
  const subEvent = (id: string, type: string, status: string, qty: number) => ({
    id, object: "event", type, livemode: false,
    data: { object: { id: "sub_seats", object: "subscription", customer: "cus_seats", status, metadata: { tenant_id: me.tenant.id, plan: "team" }, items: { data: [{ quantity: qty, price: { id: "price_team_test" } }] } } },
  });
  await postEvent(subEvent("evt_seats_1", "customer.subscription.created", "active", 4));
  let now = (await api(s, cookie)("/api/me")).body;
  assert.deepEqual([now.plan.id, now.tenant.seats, now.plan.maxMembers, now.plan.maxCallsPerDay, now.payment_provider], ["team", 4, 4, 40_000, "stripe"]);
  await postEvent(subEvent("evt_seats_2", "customer.subscription.updated", "active", 9));
  assert.equal((await api(s, cookie)("/api/me")).body.tenant.seats, 9);
  await postEvent(subEvent("evt_seats_3", "customer.subscription.deleted", "canceled", 9));
  now = (await api(s, cookie)("/api/me")).body;
  assert.deepEqual([now.plan.id, now.tenant.seats], ["free", 1]);
  // checkout validates seats before it reaches Stripe
  const bad = await api(s, cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "team", seats: 0 }) });
  assert.equal(bad.status, 400);
});
