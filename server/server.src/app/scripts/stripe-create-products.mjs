#!/usr/bin/env node
// Creates the Scribe Memory products and prices in Stripe (Personal monthly + yearly, Team per seat). TEST MODE ONLY by default.
//
//   node scripts/stripe-create-products.mjs            # dry run: prints what it would create
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-create-products.mjs --apply
//
// Idempotent: prices are found by lookup_key and reused. A live key (sk_live_/rk_live_) is
// refused unless BOTH --live is passed and STRIPE_ALLOW_LIVE=yes-i-mean-live is set — that
// step is Sam's call and has not been run.
// Prints the env lines (STRIPE_PRICE_PERSONAL / STRIPE_PRICE_PERSONAL_YEARLY / STRIPE_PRICE_TEAM) to paste into the server env.
import Stripe from "stripe";

// One product per plan; Personal has a monthly and a yearly price, Team is per seat per month.
const PRICES = [
  { lookup: "helmian_scribe_personal_monthly", product: "Scribe Memory Personal", plan: "personal", interval: "month", cents: 800, env: "STRIPE_PRICE_PERSONAL", desc: "One shared memory for every AI you use: learning, unlimited rules, people/places/companies shelves, knowledge graph, unlimited memories, 5 GB, ChatGPT/Claude import, daily backups." },
  { lookup: "helmian_scribe_personal_yearly", product: "Scribe Memory Personal", plan: "personal", interval: "year", cents: 8000, env: "STRIPE_PRICE_PERSONAL_YEARLY", desc: null },
  { lookup: "helmian_scribe_team_monthly", product: "Scribe Memory Team", plan: "team", interval: "month", cents: 1500, env: "STRIPE_PRICE_TEAM", desc: "Scribe Memory for a team: everything in Personal, per seat." },
];

const apply = process.argv.includes("--apply");
const live = process.argv.includes("--live");
const key = process.env.STRIPE_SECRET_KEY || "";

if (!apply) {
  console.log("Dry run (pass --apply to create). Would create/reuse:");
  for (const p of PRICES) console.log(`  ${p.product}: $${(p.cents / 100).toFixed(2)}/${p.interval}, lookup_key=${p.lookup}, metadata.plan=${p.plan}`);
  process.exit(0);
}
if (!key) { console.error("Set STRIPE_SECRET_KEY to a TEST key (sk_test_...)."); process.exit(1); }
if (/^(sk|rk)_live_/.test(key) && !(live && process.env.STRIPE_ALLOW_LIVE === "yes-i-mean-live")) {
  console.error("Refusing to use a LIVE Stripe key. This script creates test-mode products only.");
  process.exit(1);
}
const stripe = new Stripe(key);
const out = {};
const products = {}; // one product per plan, shared by that plan's prices
for (const p of PRICES) {
  const found = await stripe.prices.list({ lookup_keys: [p.lookup], limit: 1 });
  let price = found.data[0];
  if (!price) {
    products[p.plan] ??= await stripe.products.create({ name: p.product, description: p.desc ?? undefined, metadata: { plan: p.plan, app: "helmian-scribe" } });
    price = await stripe.prices.create({ product: products[p.plan].id, currency: "usd", unit_amount: p.cents, recurring: { interval: p.interval }, lookup_key: p.lookup, metadata: { plan: p.plan } });
    console.log(`created ${p.product} ${p.interval}ly -> ${price.id}`);
  } else console.log(`reused ${p.product} ${p.interval}ly -> ${price.id}`);
  out[p.env] = price.id;
}
console.log("\n" + Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n"));
console.log("Then add a webhook endpoint <PUBLIC_URL>/webhooks/stripe for: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted — and put its signing secret in STRIPE_WEBHOOK_SECRET.");
