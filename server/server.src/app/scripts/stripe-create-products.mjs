#!/usr/bin/env node
// Creates the Helmian Scribe products and monthly prices in Stripe. TEST MODE ONLY by default.
//
//   node scripts/stripe-create-products.mjs            # dry run: prints what it would create
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-create-products.mjs --apply
//
// Idempotent: prices are found by lookup_key and reused. A live key (sk_live_/rk_live_) is
// refused unless BOTH --live is passed and STRIPE_ALLOW_LIVE=yes-i-mean-live is set — that
// step is Sam's call and has not been run.
// Prints the env lines (STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM) to paste into the server env.
import Stripe from "stripe";

const PLANS = [
  { lookup: "helmian_scribe_pro_monthly", product: "Helmian Scribe Pro", plan: "pro", cents: 1500, desc: "One hosted memory for every AI you use: 100k memories, 20k calls/day, the Librarian, Flags and the Courier." },
  { lookup: "helmian_scribe_team_monthly", product: "Helmian Scribe Team", plan: "team", cents: 4900, desc: "Helmian Scribe for a team and its agents: 1M memories, 100k calls/day, 10 members." },
];

const apply = process.argv.includes("--apply");
const live = process.argv.includes("--live");
const key = process.env.STRIPE_SECRET_KEY || "";

if (!apply) {
  console.log("Dry run (pass --apply to create). Would create/reuse:");
  for (const p of PLANS) console.log(`  ${p.product}: $${(p.cents / 100).toFixed(2)}/month, lookup_key=${p.lookup}, metadata.plan=${p.plan}`);
  process.exit(0);
}
if (!key) { console.error("Set STRIPE_SECRET_KEY to a TEST key (sk_test_...)."); process.exit(1); }
if (/^(sk|rk)_live_/.test(key) && !(live && process.env.STRIPE_ALLOW_LIVE === "yes-i-mean-live")) {
  console.error("Refusing to use a LIVE Stripe key. This script creates test-mode products only.");
  process.exit(1);
}
const stripe = new Stripe(key);
const out = {};
for (const p of PLANS) {
  const found = await stripe.prices.list({ lookup_keys: [p.lookup], limit: 1 });
  let price = found.data[0];
  if (!price) {
    const product = await stripe.products.create({ name: p.product, description: p.desc, metadata: { plan: p.plan, app: "helmian-scribe" } });
    price = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: p.cents, recurring: { interval: "month" }, lookup_key: p.lookup, metadata: { plan: p.plan } });
    console.log(`created ${p.product} -> ${price.id}`);
  } else console.log(`reused ${p.product} -> ${price.id}`);
  out[p.plan] = price.id;
}
console.log(`\nSTRIPE_PRICE_PRO=${out.pro}\nSTRIPE_PRICE_TEAM=${out.team}`);
console.log("Then add a webhook endpoint <PUBLIC_URL>/webhooks/stripe for: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted — and put its signing secret in STRIPE_WEBHOOK_SECRET.");
