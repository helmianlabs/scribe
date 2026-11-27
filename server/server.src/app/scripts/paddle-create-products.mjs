#!/usr/bin/env node
// Creates the Scribe Memory products and prices in Paddle Billing (Personal monthly + yearly, Team per seat). SANDBOX ONLY by default.
//
//   node scripts/paddle-create-products.mjs            # dry run: prints what it would create
//   PADDLE_API_KEY=pdl_sdbx_apikey_... node scripts/paddle-create-products.mjs --apply
//
// Paddle has no lookup keys, so each product and price carries custom_data.helmian_key and is found again by it:
// the script is idempotent and never creates a duplicate. It never updates an existing price (amounts are fixed once
// customers subscribe; change a price in the Paddle dashboard instead). A live key (one that is not a sandbox key, i.e. does
// not contain "_sdbx") is refused unless BOTH --live is passed and PADDLE_ALLOW_LIVE=yes-i-mean-live is set.
// The API key is read from the environment only. It is never printed, and nothing here prints a webhook secret.
// Prints the env lines (PADDLE_PRICE_PERSONAL / PADDLE_PRICE_PERSONAL_YEARLY / PADDLE_PRICE_TEAM) to paste into the server env.
//
// Endpoints used (developer.paddle.com): GET/POST /products, GET/POST /prices; header "Paddle-Version: 1"; amounts are strings in
// the lowest denomination (cents). tax_category "saas" is available on every Paddle account by default.

const PRODUCTS = {
  personal: { key: "helmian_scribe_personal", name: "Scribe Memory Personal", description: "One shared memory for every AI you use: learning, unlimited rules, people/places/companies shelves, knowledge graph, unlimited memories, 5 GB, ChatGPT/Claude import, daily backups." },
  team: { key: "helmian_scribe_team", name: "Scribe Memory Team", description: "Scribe Memory for a team: everything in Personal, per seat." },
};
// Team is per seat: quantity is the seat count (the app allows 1 to 100).
const PRICES = [
  { key: "helmian_scribe_personal_monthly", product: "personal", name: "Personal monthly", cents: 800, interval: "month", quantity: { minimum: 1, maximum: 1 }, env: "PADDLE_PRICE_PERSONAL" },
  { key: "helmian_scribe_personal_yearly", product: "personal", name: "Personal yearly", cents: 8000, interval: "year", quantity: { minimum: 1, maximum: 1 }, env: "PADDLE_PRICE_PERSONAL_YEARLY" },
  { key: "helmian_scribe_team_monthly", product: "team", name: "Team per seat, monthly", cents: 1500, interval: "month", quantity: { minimum: 1, maximum: 100 }, env: "PADDLE_PRICE_TEAM" },
];

const apply = process.argv.includes("--apply");
const live = process.argv.includes("--live");
const key = process.env.PADDLE_API_KEY || "";
const sandbox = key.includes("_sdbx");

if (!apply) {
  console.log("Dry run (pass --apply to create). Would create/reuse:");
  for (const p of PRICES) console.log(`  ${PRODUCTS[p.product].name}: $${(p.cents / 100).toFixed(2)}/${p.interval}${p.product === "team" ? " per seat" : ""}, custom_data.helmian_key=${p.key}`);
  process.exit(0);
}
if (!key) { console.error("Set PADDLE_API_KEY to a SANDBOX key (it contains _sdbx)."); process.exit(1); }
if (!sandbox && !(live && process.env.PADDLE_ALLOW_LIVE === "yes-i-mean-live")) {
  console.error("Refusing to use a LIVE Paddle key. This script creates sandbox products only.");
  process.exit(1);
}
// PADDLE_API_URL exists only so the tests can point the script at a local fake; it is honored for loopback addresses only.
const override = process.env.PADDLE_API_URL || "";
const BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override) ? override : sandbox ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Paddle-Version": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    console.error(`Paddle ${method} ${path} failed: HTTP ${res.status} ${json?.error?.code ?? ""} ${json?.error?.detail ?? ""}`);
    process.exit(1);
  }
  return json;
}

/** Every page of a list endpoint. Paddle returns meta.pagination.next (a full URL) while has_more is true. */
async function listAll(path) {
  const out = [];
  let next = path;
  for (let page = 0; next && page < 50; page++) {
    const r = await call("GET", next);
    out.push(...(r.data ?? []));
    const p = r.meta?.pagination;
    next = p?.has_more && p.next ? p.next.replace(/^https?:\/\/[^/]+/, "") : null;
  }
  return out;
}

const productIds = {};
for (const [plan, p] of Object.entries(PRODUCTS)) {
  const found = (await listAll("/products?status=active&per_page=200")).find((x) => x.custom_data?.helmian_key === p.key);
  if (found) { productIds[plan] = found.id; console.log(`reused product ${p.name} -> ${found.id}`); continue; }
  const r = await call("POST", "/products", { name: p.name, description: p.description, tax_category: "saas", custom_data: { helmian_key: p.key, app: "helmian-scribe" } });
  productIds[plan] = r.data.id;
  console.log(`created product ${p.name} -> ${r.data.id}`);
}

const out = {};
for (const p of PRICES) {
  const found = (await listAll(`/prices?product_id=${productIds[p.product]}&status=active&per_page=200`)).find((x) => x.custom_data?.helmian_key === p.key);
  if (found) { console.log(`reused price ${p.name} -> ${found.id}`); out[p.env] = found.id; continue; }
  const r = await call("POST", "/prices", {
    product_id: productIds[p.product],
    description: p.name,
    name: p.name,
    unit_price: { amount: String(p.cents), currency_code: "USD" },
    billing_cycle: { interval: p.interval, frequency: 1 },
    quantity: p.quantity,
    custom_data: { helmian_key: p.key, app: "helmian-scribe" },
  });
  console.log(`created price ${p.name} -> ${r.data.id}`);
  out[p.env] = r.data.id;
}

console.log("\n" + Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n"));
console.log("\nNext (see docs/PADDLE-GO-LIVE.md): a notification destination for <PUBLIC_URL>/webhooks/paddle subscribed to subscription.created, .activated, .updated, .canceled, .past_due, .paused, .resumed, .trialing, and a default payment link of <PUBLIC_URL>/billing/pay. The webhook secret comes from the Paddle dashboard and goes straight into the server env.");
