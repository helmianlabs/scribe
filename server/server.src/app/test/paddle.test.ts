/**
 * Paddle Billing (PAYMENT_PROVIDER=paddle): checkout, webhook signature verification, subscription mapping, seats, the
 * product-creation script. The Paddle API is a fake that records the requests it receives; webhooks are fabricated and signed
 * locally with the documented algorithm (HMAC-SHA256 of "<ts>:<raw body>"). That proves this code's logic against Paddle's
 * documented contract. It does NOT prove Paddle's real delivery: that needs a sandbox account (docs/PADDLE-GO-LIVE.md).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startSaas, signIn, upgrade, api, type Saas } from "./helpers.ts";
import { verifyPaddleSignature, PaddleBilling, PADDLE_EVENTS } from "../src/saas/paddle.ts";
import { assessConfig } from "../src/saas/validate.ts";
import { loadSaasConfig } from "../src/saas/config.ts";
import { BillingError } from "../src/saas/billing.ts";

const SECRET = "pdl_ntfset_test_secret_value";
const KEY = "pdl_sdbx_apikey_test_key_value";
const PRICES = { personal: "pri_personal", personalYearly: "pri_personal_y", team: "pri_team" };
const sign = (body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex")}`;

// ------------------------------------------------------------------ signature verification (pure)
test("signature: valid, wrong secret, tampered body, stale or future timestamp, malformed headers", () => {
  const body = '{"event_id":"evt_1"}';
  const now = 1_800_000_000_000;
  const ts = now / 1000;
  const good = sign(body, SECRET, ts);
  assert.equal(verifyPaddleSignature(body, good, SECRET, now), true);
  assert.equal(verifyPaddleSignature(Buffer.from(body), good, SECRET, now), true, "raw Buffer body");
  assert.equal(verifyPaddleSignature(body, good, "other", now), false);
  assert.equal(verifyPaddleSignature(body + " ", good, SECRET, now), false, "one extra byte");
  assert.equal(verifyPaddleSignature(body, good, SECRET, now + 6_000), false, "older than 5 seconds");
  assert.equal(verifyPaddleSignature(body, good, SECRET, now - 6_000), false, "from the future");
  assert.equal(verifyPaddleSignature(body, good, SECRET, now + 4_000), true, "within 5 seconds");
  for (const bad of ["", "ts=1", `ts=${ts}`, "h1=abcd", `ts=${ts};h1=zz`, `ts=${ts};h1=${"0".repeat(64)}`, `ts=abc;h1=${"0".repeat(64)}`, "garbage"]) {
    assert.equal(verifyPaddleSignature(body, bad, SECRET, now), false, bad);
  }
  assert.equal(verifyPaddleSignature(body, undefined, SECRET, now), false);
  assert.equal(verifyPaddleSignature(body, good, "", now), false, "no secret never verifies");
  // While a secret rotates the header carries two h1 values; either one is enough.
  const h1 = good.split("h1=")[1];
  assert.equal(verifyPaddleSignature(body, `ts=${ts};h1=${"1".repeat(64)};h1=${h1}`, SECRET, now), true);
});

// ------------------------------------------------------------------ a server on Paddle with a fake Paddle API
interface Seen { method: string; url: string; headers: Record<string, string>; body: any }
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; json: unknown } = () => ({ status: 500, json: {} });
const fakePaddle = async (url: string, init: RequestInit = {}) => {
  const s: Seen = { method: String(init.method), url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
  seen.push(s);
  const r = reply(s);
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
};

let s: Saas;
before(async () => {
  s = await startSaas(
    { paymentProvider: "paddle", paddle: { apiKey: KEY, webhookSecret: SECRET, clientToken: "test_clienttoken_123", prices: PRICES, allowLive: false } },
    { paddleFetch: fakePaddle });
});
after(async () => { await s.close(); });

const me = async (cookie: string) => (await api(s, cookie)("/api/me")).body;
async function owner(email: string) { const cookie = await signIn(s, email); return { cookie, me: await me(cookie) }; }
async function post(event: object, header?: string | null) {
  const body = JSON.stringify(event);
  const r = await fetch(`${s.base}/webhooks/paddle`, { method: "POST", headers: { "Content-Type": "application/json", ...(header === null ? {} : { "Paddle-Signature": header ?? sign(body) }) }, body });
  return { status: r.status, body: await r.json() as any };
}
let n = 0;
const sub = (tenantId: string, over: Record<string, any> = {}) => ({
  id: `sub_auto_${tenantId}`, status: "active", customer_id: `ctm_auto_${tenantId}`,
  custom_data: { tenant_id: tenantId },
  items: [{ status: "active", quantity: 1, price: { id: PRICES.personal } }],
  scheduled_change: null, ...over,
});
const evt = (type: string, data: object, occurredAt = new Date()) => ({ event_id: `evt_${String(++n).padStart(26, "0")}`, event_type: type, occurred_at: occurredAt.toISOString(), notification_id: "ntf_x", data });
const T = (sec: number) => new Date(Date.UTC(2026, 10, 26, 12, 0, sec));

test("checkout: Personal monthly and yearly, Team with seats, sent to Paddle's transactions API with the tenant in custom_data", async () => {
  const a = await owner("pd-co@example.com");
  reply = () => ({ status: 201, json: { data: { id: "txn_01abc", checkout: { url: "https://scribemem.helmian.cloud/billing/pay?_ptxn=txn_01abc" } } } });
  const co = (b: object) => api(s, a.cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify(b) });

  seen.length = 0;
  const m = await co({ plan: "personal" });
  assert.equal(m.status, 200);
  assert.equal(m.body.url, "https://scribemem.helmian.cloud/billing/pay?_ptxn=txn_01abc");
  assert.equal(m.body.mode, "test");
  const req = seen[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://sandbox-api.paddle.com/transactions", "a sandbox key goes to the sandbox API");
  assert.equal(req.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(req.headers["Paddle-Version"], "1");
  assert.deepEqual(req.body.items, [{ price_id: "pri_personal", quantity: 1 }]);
  assert.equal(req.body.collection_mode, "automatic");
  assert.equal(req.body.custom_data.tenant_id, a.me.tenant.id);
  assert.equal(req.body.custom_data.plan, "personal");
  assert.equal(req.body.checkout.url, `${s.base}/billing/pay`);
  assert.ok(!JSON.stringify(m.body).includes(KEY), "the API key is never returned");

  seen.length = 0;
  await co({ plan: "personal", interval: "year" });
  assert.deepEqual(seen[0].body.items, [{ price_id: "pri_personal_y", quantity: 1 }]);

  seen.length = 0;
  const t = await co({ plan: "team", seats: 5 });
  assert.equal(t.status, 200);
  assert.deepEqual(seen[0].body.items, [{ price_id: "pri_team", quantity: 5 }]);
  assert.equal(seen[0].body.custom_data.seats, "5");

  seen.length = 0;
  await co({ plan: "personal", seats: 9 });
  assert.equal(seen[0].body.items[0].quantity, 1, "seats only apply to Team");
});

test("checkout: bad requests are refused before Paddle is called", async () => {
  const a = await owner("pd-bad@example.com");
  seen.length = 0;
  const co = (b: object) => api(s, a.cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify(b) });
  for (const [body, why] of [
    [{ plan: "team", interval: "year" }, "team yearly"], [{ plan: "team", seats: 0 }, "0 seats"], [{ plan: "team", seats: 101 }, "101 seats"],
    [{ plan: "team", seats: 2.5 }, "fractional seats"], [{ plan: "team", seats: "lots" }, "text seats"], [{ plan: "pro" }, "retired plan"], [{ plan: "free" }, "free"],
  ] as const) {
    const r = await co(body);
    assert.equal(r.status, 400, why);
  }
  assert.equal(seen.length, 0);
});

test("checkout: a Paddle error comes back as a plain 502 without leaking anything", async () => {
  const a = await owner("pd-err@example.com");
  reply = () => ({ status: 403, json: { error: { type: "request_error", code: "forbidden", detail: "Default payment link is not set." } } });
  const r = await api(s, a.cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "personal" }) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Default payment link is not set/);
  assert.ok(!JSON.stringify(r.body).includes(KEY));
  reply = () => ({ status: 201, json: { data: { id: "txn_x", checkout: { url: null } } } });
  const r2 = await api(s, a.cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "personal" }) });
  assert.equal(r2.status, 502);
  assert.match(r2.body.error, /default payment link/i);
});

test("webhook: missing or bad signature is refused and changes nothing; a missing secret is 503", async () => {
  const a = await owner("pd-sig@example.com");
  const ev = evt("subscription.created", sub(a.me.tenant.id, { items: [{ quantity: 1, price: { id: PRICES.team } }] }));
  assert.equal((await post(ev, null)).status, 400);
  assert.equal((await post(ev, "ts=1;h1=deadbeef")).status, 400);
  assert.equal((await post(ev, sign(JSON.stringify(ev), "wrong-secret"))).status, 400);
  assert.equal((await post(ev, sign(JSON.stringify(ev), SECRET, Math.floor(Date.now() / 1000) - 60))).status, 400, "replayed old signature");
  assert.equal((await me(a.cookie)).plan.id, "free");
  assert.equal((await s.pg.query("SELECT 1 FROM paddle_events WHERE id = $1", [ev.event_id])).rows.length, 0, "a refused event is not even recorded");
  const noSecret = new PaddleBilling(s.db, { ...s.cfg, paddle: { ...s.cfg.paddle, webhookSecret: null } }, s.accounts);
  assert.equal((await noSecret.handleWebhook(Buffer.from("{}"), "ts=1;h1=x")).status, 503);
});

test("subscription.created maps the price to the plan, records seats, and replays are idempotent", async () => {
  const a = await owner("pd-team@example.com");
  const ev = evt("subscription.created", sub(a.me.tenant.id, { id: "sub_team1", items: [{ status: "active", quantity: 3, price: { id: PRICES.team } }] }), T(1));
  const r = await post(ev);
  assert.deepEqual([r.status, r.body.applied], [200, true]);
  const m = await me(a.cookie);
  assert.equal(m.plan.id, "team");
  assert.equal(m.tenant.plan_status, "active");
  assert.equal(m.tenant.seats, 3);
  assert.equal(m.plan.maxMembers, 3);
  assert.equal(m.plan.maxCallsPerDay, 30_000);
  assert.equal(m.payment_provider, "paddle");
  assert.equal(m.tenant.paddle_customer_id, undefined, "provider ids are not exposed");
  assert.equal(m.tenant.paddle_subscription_id, undefined);
  const row = (await s.pg.query<any>("SELECT payment_provider, paddle_customer_id, paddle_subscription_id FROM tenants WHERE id = $1", [a.me.tenant.id])).rows[0];
  assert.deepEqual(row, { payment_provider: "paddle", paddle_customer_id: `ctm_auto_${a.me.tenant.id}`, paddle_subscription_id: "sub_team1" });
  assert.equal((await post(ev)).body.duplicate, true);
  const ledger = (await s.pg.query<any>("SELECT apply_status, attempts FROM paddle_events WHERE id = $1", [ev.event_id])).rows[0];
  assert.deepEqual(ledger, { apply_status: "applied", attempts: 1 });
});

test("each Personal price (monthly, yearly) maps to Personal; unknown price falls back to custom_data, then to Free", async () => {
  const y = await owner("pd-yearly@example.com");
  await post(evt("subscription.created", sub(y.me.tenant.id, { id: "sub_y", items: [{ quantity: 1, price: { id: PRICES.personalYearly } }] })));
  assert.equal((await me(y.cookie)).plan.id, "personal");
  const c = await owner("pd-custom@example.com");
  await post(evt("subscription.created", sub(c.me.tenant.id, { id: "sub_c", custom_data: { tenant_id: c.me.tenant.id, plan: "personal" }, items: [{ quantity: 1, price: { id: "pri_unknown" } }] })));
  assert.equal((await me(c.cookie)).plan.id, "personal");
  const u = await owner("pd-unknown@example.com");
  await post(evt("subscription.created", sub(u.me.tenant.id, { id: "sub_u", custom_data: { tenant_id: u.me.tenant.id }, items: [{ quantity: 1, price: { id: "pri_unknown" } }] })));
  assert.equal((await me(u.cookie)).plan.id, "free", "a price we do not recognise never grants a plan");
});

test("subscription.updated changes seats; the tenant is also found by customer id; a seat count is clamped", async () => {
  const a = await owner("pd-seats@example.com");
  await post(evt("subscription.created", sub(a.me.tenant.id, { id: "sub_s", customer_id: "ctm_seats", items: [{ quantity: 2, price: { id: PRICES.team } }] }), T(1)));
  assert.equal((await me(a.cookie)).tenant.seats, 2);
  // No custom_data now: the customer id finds the tenant.
  await post(evt("subscription.updated", { ...sub(a.me.tenant.id, { id: "sub_s", customer_id: "ctm_seats", custom_data: null, items: [{ quantity: 6, price: { id: PRICES.team } }] }) }, T(2)));
  assert.equal((await me(a.cookie)).tenant.seats, 6);
  assert.equal((await me(a.cookie)).plan.maxCallsPerDay, 60_000);
  await post(evt("subscription.updated", sub(a.me.tenant.id, { id: "sub_s", customer_id: "ctm_seats", items: [{ quantity: 5000, price: { id: PRICES.team } }] }), T(3)));
  assert.equal((await me(a.cookie)).tenant.seats, 100);
});

test("cancellation: a scheduled cancel keeps the plan, past_due keeps it, paused and canceled drop to Free", async () => {
  const a = await owner("pd-cancel@example.com");
  const id = a.me.tenant.id;
  const s1 = (over: object) => sub(id, { id: "sub_cx", customer_id: "ctm_cx", items: [{ quantity: 1, price: { id: PRICES.personal } }], ...over });
  await post(evt("subscription.activated", s1({}), T(1)));
  assert.equal((await me(a.cookie)).plan.id, "personal");
  await post(evt("subscription.updated", s1({ scheduled_change: { action: "cancel", effective_at: "2026-12-26T00:00:00Z" } }), T(2)));
  assert.equal((await me(a.cookie)).plan.id, "personal", "cancel at the end of the period: still paid until then");
  await post(evt("subscription.past_due", s1({ status: "past_due" }), T(3)));
  const pd = await me(a.cookie);
  assert.deepEqual([pd.plan.id, pd.tenant.plan_status], ["personal", "past_due"]);
  await post(evt("subscription.paused", s1({ status: "paused" }), T(4)));
  assert.equal((await me(a.cookie)).plan.id, "free");
  await post(evt("subscription.resumed", s1({ status: "active" }), T(5)));
  assert.equal((await me(a.cookie)).plan.id, "personal");
  await post(evt("subscription.canceled", s1({ status: "canceled" }), T(6)));
  const done = await me(a.cookie);
  assert.deepEqual([done.plan.id, done.tenant.plan_status, done.tenant.seats], ["free", "canceled", 1]);
  assert.equal(done.plan.maxMemories, 1000, "back on Free's limits");
});

test("events can arrive out of order: an older event never overwrites a newer one", async () => {
  const a = await owner("pd-order@example.com");
  const mk = (qty: number) => sub(a.me.tenant.id, { id: "sub_o", customer_id: "ctm_o", items: [{ quantity: qty, price: { id: PRICES.team } }] });
  await post(evt("subscription.created", mk(2), T(1)));
  await post(evt("subscription.updated", mk(8), T(20)));
  await post(evt("subscription.updated", mk(4), T(10)));        // older, arrives late
  assert.equal((await me(a.cookie)).tenant.seats, 8);
  await post(evt("subscription.canceled", { ...mk(8), status: "canceled" }, T(5))); // an old cancel arriving late
  assert.equal((await me(a.cookie)).plan.id, "team");
  await post(evt("subscription.canceled", { ...mk(8), status: "canceled" }, T(30)));
  assert.equal((await me(a.cookie)).plan.id, "free");
});

test("a late cancel of an OLD subscription does not downgrade a tenant who subscribed again", async () => {
  const a = await owner("pd-resub@example.com");
  const id = a.me.tenant.id;
  await post(evt("subscription.created", sub(id, { id: "sub_old", customer_id: "ctm_r", items: [{ quantity: 1, price: { id: PRICES.personal } }] }), T(1)));
  await post(evt("subscription.created", sub(id, { id: "sub_new", customer_id: "ctm_r", items: [{ quantity: 2, price: { id: PRICES.team } }] }), T(10)));
  assert.equal((await me(a.cookie)).plan.id, "team");
  await post(evt("subscription.canceled", sub(id, { id: "sub_old", status: "canceled", customer_id: "ctm_r" }), T(20)));
  const m = await me(a.cookie);
  assert.deepEqual([m.plan.id, m.tenant.seats], ["team", 2]);
  const row = (await s.pg.query<any>("SELECT paddle_subscription_id FROM tenants WHERE id = $1", [id])).rows[0];
  assert.equal(row.paddle_subscription_id, "sub_new");
});

test("events that cannot change a plan are acknowledged and ignored", async () => {
  const a = await owner("pd-ignore@example.com");
  const tx = await post(evt("transaction.completed", { id: "txn_1", custom_data: { tenant_id: a.me.tenant.id }, status: "completed" }));
  assert.deepEqual([tx.status, tx.body.applied], [200, false]);
  assert.equal((await me(a.cookie)).plan.id, "free", "a transaction alone never grants a plan; the subscription event does");
  const nobody = await post(evt("subscription.created", sub("no-such-tenant", { customer_id: "ctm_nobody" })));
  assert.deepEqual([nobody.status, nobody.body.applied], [200, false]);
  assert.equal((await post({ event_id: 5 })).status, 400);
  const body = "not json";
  const r = await fetch(`${s.base}/webhooks/paddle`, { method: "POST", body, headers: { "Paddle-Signature": sign(body) } });
  assert.equal(r.status, 400);
});

test("a failed apply answers 500, is recorded as failed, and is reprocessed on redelivery", async () => {
  const a = await owner("pd-fail-a@example.com");
  const b = await owner("pd-fail-b@example.com");
  await post(evt("subscription.created", sub(a.me.tenant.id, { id: "sub_fa", customer_id: "ctm_clash" }), T(1)));
  const clash = evt("subscription.created", sub(b.me.tenant.id, { id: "sub_fb", customer_id: "ctm_clash" }), T(2));
  assert.equal((await post(clash)).status, 500, "the same Paddle customer cannot belong to two tenants");
  assert.deepEqual((await s.pg.query<any>("SELECT apply_status, attempts FROM paddle_events WHERE id = $1", [clash.event_id])).rows[0], { apply_status: "failed", attempts: 1 });
  assert.equal((await me(b.cookie)).plan.id, "free");
  await s.pg.query("UPDATE tenants SET paddle_customer_id = NULL WHERE id = $1", [a.me.tenant.id]); // the data problem is fixed
  const again = await post(clash);
  assert.deepEqual([again.status, again.body.applied], [200, true]);
  assert.equal((await me(b.cookie)).plan.id, "personal");
  assert.deepEqual((await s.pg.query<any>("SELECT apply_status, attempts FROM paddle_events WHERE id = $1", [clash.event_id])).rows[0], { apply_status: "applied", attempts: 2 });
  assert.equal((await post(clash)).body.duplicate, true);
});

test("portal: needs a customer; returns Paddle's customer-portal link", async () => {
  const a = await owner("pd-portal@example.com");
  const none = await api(s, a.cookie)("/api/billing/portal", { method: "POST" });
  assert.equal(none.status, 400);
  await post(evt("subscription.created", sub(a.me.tenant.id, { id: "sub_p", customer_id: "ctm_portal" }), T(1)));
  seen.length = 0;
  reply = () => ({ status: 201, json: { data: { urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_1?action=overview&token=t" } } } } });
  const r = await api(s, a.cookie)("/api/billing/portal", { method: "POST" });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/sandbox-customer-portal\.paddle\.com\//);
  assert.equal(seen[0].url, "https://sandbox-api.paddle.com/customers/ctm_portal/portal-sessions");
  assert.deepEqual(seen[0].body, { subscription_ids: ["sub_p"] });
});

test("seats: only a Team owner can change them; Paddle gets the new quantity on the Team price, prorated", async () => {
  const a = await owner("pd-chg@example.com");
  const set = (seats: unknown) => api(s, a.cookie)("/api/billing/seats", { method: "POST", body: JSON.stringify({ seats }) });
  assert.equal((await set(3)).status, 400, "Free tenant");
  await post(evt("subscription.created", sub(a.me.tenant.id, { id: "sub_chg", customer_id: "ctm_chg", items: [{ quantity: 2, price: { id: PRICES.team } }] }), T(1)));
  assert.equal((await set(0)).status, 400);
  assert.equal((await set(1000)).status, 400);
  seen.length = 0;
  reply = () => ({ status: 200, json: { data: { id: "sub_chg" } } });
  const r = await set(7);
  assert.deepEqual([r.status, r.body.requested], [200, 7]);
  assert.equal(seen[0].method, "PATCH");
  assert.equal(seen[0].url, "https://sandbox-api.paddle.com/subscriptions/sub_chg");
  assert.deepEqual(seen[0].body, { items: [{ price_id: "pri_team", quantity: 7 }], proration_billing_mode: "prorated_immediately" });
  assert.equal((await me(a.cookie)).tenant.seats, 2, "seats change only when Paddle's subscription.updated says so");
});

test("checkout is refused while a subscription is active (no double charging); Manage billing is the path", async () => {
  const a = await owner("pd-dup@example.com");
  await post(evt("subscription.created", sub(a.me.tenant.id, { id: "sub_d", customer_id: "ctm_d" }), T(1)));
  seen.length = 0;
  const r = await api(s, a.cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "team", seats: 2 }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Manage billing/);
  assert.equal(seen.length, 0);
});

test("/billing/pay serves Paddle.js with the client token and a CSP that allows paddle.com only on that page", async () => {
  const r = await fetch(`${s.base}/billing/pay?_ptxn=txn_01abc`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /https:\/\/cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
  assert.match(html, /data-token="test_clienttoken_123"/);
  assert.match(html, /data-env="sandbox"/);
  assert.ok(!html.includes(KEY) && !html.includes(SECRET), "no secret reaches the page");
  const csp = r.headers.get("content-security-policy")!;
  assert.match(csp, /script-src 'self' https:\/\/cdn\.paddle\.com/);
  assert.match(csp, /frame-src https:\/\/\*\.paddle\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  const other = await fetch(`${s.base}/dashboard`);
  assert.doesNotMatch(other.headers.get("content-security-policy")!, /paddle/, "every other page keeps the strict CSP");
  const js = await (await fetch(`${s.base}/static/paddle-pay.js`)).text();
  assert.match(js, /Paddle\.Initialize/);
  assert.match(js, /Environment\.set\('sandbox'\)/);
});

// ------------------------------------------------------------------ the switch, guards, validation
test("PAYMENT_PROVIDER: default is Stripe, and a Stripe-mode server has no checkout page", async () => {
  const stripeSide = await startSaas();
  try {
    const cookie = await signIn(stripeSide, "pd-sw@example.com");
    const m = (await api(stripeSide, cookie)("/api/me")).body;
    assert.equal(m.payment_provider, "stripe");
    assert.equal((await fetch(`${stripeSide.base}/billing/pay`)).status, 404);
    const co = await api(stripeSide, cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "team", seats: 4 }) });
    assert.equal(co.body.mode, "mock");
    assert.match(co.body.url, /seats=4/);
    // Its Paddle webhook exists but is unconfigured: 503 and nothing changes.
    const body = "{}";
    assert.equal((await fetch(`${stripeSide.base}/webhooks/paddle`, { method: "POST", body, headers: { "Paddle-Signature": sign(body) } })).status, 503);
  } finally { await stripeSide.close(); }
  assert.equal(loadSaasConfig({}).paymentProvider, "stripe");
});

test("Paddle with no API key is a clearly-marked mock; a LIVE key is refused without PADDLE_ALLOW_LIVE", async () => {
  const mock = await startSaas({ paymentProvider: "paddle", paddle: { apiKey: null, webhookSecret: null, clientToken: null, prices: { personal: null, personalYearly: null, team: null }, allowLive: false } });
  try {
    const cookie = await signIn(mock, "pd-mock@example.com");
    const co = await api(mock, cookie)("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "personal" }) });
    assert.equal(co.body.mode, "mock");
    assert.match(co.body.url, /\/billing\/mock/);
    assert.equal((await api(mock, cookie)("/api/me")).body.billing_mode, "mock");
  } finally { await mock.close(); }
  const live = { ...s.cfg.paddle, apiKey: "pdl_live_apikey_abc" };
  assert.throws(() => new PaddleBilling(s.db, { ...s.cfg, paddle: live }, s.accounts), (e: any) => e instanceof BillingError && /LIVE Paddle key/.test(e.message));
  const allowed = new PaddleBilling(s.db, { ...s.cfg, paddle: { ...live, allowLive: true } }, s.accounts);
  assert.equal(allowed.mode, "live");
});

test("startup validation: half-configured Paddle, mixed sandbox/live credentials, a live key, a mistyped provider", () => {
  const base = loadSaasConfig({ publicUrl: "https://scribemem.helmian.cloud", databaseUrl: "postgres://x", mail: { provider: "resend", from: "a@b.co", outboxFile: "/tmp/x" } });
  const paddle = (o: object) => ({ ...base, paymentProvider: "paddle" as const, paddle: { apiKey: KEY, webhookSecret: SECRET, clientToken: "test_tok", prices: PRICES, allowLive: false, ...o } });
  assert.deepEqual(assessConfig(paddle({}), true).problems.filter((p) => /Paddle|PADDLE/.test(p)), []);
  assert.match(assessConfig(paddle({ webhookSecret: null, prices: { personal: "p", personalYearly: null, team: null } }), true).problems.join("\n"), /Paddle is half-configured.*PADDLE_WEBHOOK_SECRET, PADDLE_PRICE_PERSONAL_YEARLY, PADDLE_PRICE_TEAM/);
  assert.match(assessConfig(paddle({ clientToken: null }), true).problems.join("\n"), /PADDLE_CLIENT_TOKEN/);
  assert.match(assessConfig(paddle({ clientToken: "live_tok" }), true).problems.join("\n"), /sandbox key but PADDLE_CLIENT_TOKEN is not a sandbox token/);
  assert.match(assessConfig(paddle({ apiKey: "pdl_live_apikey_x", clientToken: "test_tok" }), true).problems.join("\n"), /LIVE key but PADDLE_ALLOW_LIVE/);
  assert.match(assessConfig(paddle({ apiKey: "pdl_live_apikey_x", clientToken: "test_tok" }), true).problems.join("\n"), /live key but PADDLE_CLIENT_TOKEN is not a live token/);
  assert.deepEqual(assessConfig(paddle({ apiKey: "pdl_live_apikey_x", clientToken: "live_tok", allowLive: true }), true).problems.filter((p) => /Paddle|PADDLE/.test(p)), []);
  assert.match(assessConfig(paddle({ apiKey: null }), false).warnings.join("\n"), /PAYMENT_PROVIDER is paddle but PADDLE_API_KEY is not set/);
  const was = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = "paddel";
  try { assert.match(assessConfig(loadSaasConfig({ databaseUrl: "x" }), false).problems.join("\n"), /PAYMENT_PROVIDER is "paddel"/); }
  finally { if (was === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = was; }
  // Stripe off is expected when Paddle is the provider: no "Stripe is not configured" noise.
  assert.doesNotMatch(assessConfig(paddle({}), false).warnings.join("\n"), /Stripe is not configured/);
});

test("the events the destination must subscribe to are exactly the ones the handler maps", () => {
  assert.deepEqual([...PADDLE_EVENTS].sort(), ["subscription.activated", "subscription.canceled", "subscription.created", "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.trialing", "subscription.updated"]);
});

// ------------------------------------------------------------------ scripts/paddle-create-products.mjs against a local fake
const run = promisify(execFile);
test("paddle-create-products: dry run, refuses a live key, creates once and reuses on the second run", async () => {
  const products: any[] = [], prices: any[] = [];
  const reqs: string[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      reqs.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${KEY}`);
      assert.equal(req.headers["paddle-version"], "1");
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      const j = b ? JSON.parse(b) : null;
      if (req.method === "GET" && req.url!.startsWith("/products")) return send(200, { data: products, meta: { pagination: { has_more: false } } });
      if (req.method === "GET" && req.url!.startsWith("/prices")) { const pid = new URL(req.url!, "http://x").searchParams.get("product_id"); return send(200, { data: prices.filter((p) => p.product_id === pid), meta: { pagination: { has_more: false } } }); }
      if (req.method === "POST" && req.url === "/products") { const p = { id: `pro_${products.length + 1}`, ...j }; products.push(p); return send(201, { data: p }); }
      if (req.method === "POST" && req.url === "/prices") { const p = { id: `pri_${prices.length + 1}`, ...j }; prices.push(p); return send(201, { data: p }); }
      send(404, { error: { code: "not_found" } });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  const script = new URL("../scripts/paddle-create-products.mjs", import.meta.url).pathname;
  const env = { ...process.env, PADDLE_API_KEY: KEY, PADDLE_API_URL: url };
  try {
    const dry = await run("node", [script], { env: { ...env, PADDLE_API_KEY: "" } });
    assert.match(dry.stdout, /Dry run/);
    assert.match(dry.stdout, /\$15\.00\/month per seat/);
    assert.equal(reqs.length, 0, "a dry run calls nothing");
    await assert.rejects(run("node", [script, "--apply"], { env: { ...env, PADDLE_API_KEY: "pdl_live_apikey_x" } }), /LIVE Paddle key/);
    assert.equal(reqs.length, 0);

    const first = await run("node", [script, "--apply"], { env });
    assert.equal(products.length, 2);
    assert.equal(prices.length, 3);
    assert.deepEqual(products.map((p) => p.tax_category), ["saas", "saas"]);
    const byKey = Object.fromEntries(prices.map((p) => [p.custom_data.helmian_key, p]));
    assert.deepEqual(byKey.helmian_scribe_personal_monthly.unit_price, { amount: "800", currency_code: "USD" });
    assert.deepEqual(byKey.helmian_scribe_personal_monthly.billing_cycle, { interval: "month", frequency: 1 });
    assert.deepEqual(byKey.helmian_scribe_personal_yearly.unit_price, { amount: "8000", currency_code: "USD" });
    assert.deepEqual(byKey.helmian_scribe_personal_yearly.billing_cycle, { interval: "year", frequency: 1 });
    assert.deepEqual(byKey.helmian_scribe_team_monthly.unit_price, { amount: "1500", currency_code: "USD" });
    assert.deepEqual(byKey.helmian_scribe_team_monthly.quantity, { minimum: 1, maximum: 100 });
    assert.deepEqual(byKey.helmian_scribe_personal_monthly.quantity, { minimum: 1, maximum: 1 });
    assert.match(first.stdout, /PADDLE_PRICE_PERSONAL=pri_1/);
    assert.match(first.stdout, /PADDLE_PRICE_PERSONAL_YEARLY=pri_2/);
    assert.match(first.stdout, /PADDLE_PRICE_TEAM=pri_3/);
    assert.ok(!first.stdout.includes(KEY) && !first.stderr.includes(KEY), "the key is never printed");

    const second = await run("node", [script, "--apply"], { env });
    assert.equal(products.length, 2, "no duplicate products");
    assert.equal(prices.length, 3, "no duplicate prices");
    assert.match(second.stdout, /reused price/);
    assert.match(second.stdout, /PADDLE_PRICE_TEAM=pri_3/);
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});
