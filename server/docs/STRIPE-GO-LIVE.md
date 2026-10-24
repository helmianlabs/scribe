# Stripe go-live — Helmian Scribe (SaaS mode)

Everything provable without live keys is done and tested (B8: payment-gated
checkout activation, retryable webhook applies, product script dry-run). What
remains is a short list of account-side steps that only Sam can do, because
they need the **"Helmian labs" Stripe account** and its keys. Do them in
order; each step names exactly where the value goes.

> **Account warning.** Use the Stripe account named **"Helmian labs"**.
> Muse's Stripe connector reaches a *different* account (Faith and Light) —
> never take keys, prices, or webhook secrets from there. Prices, products
> and webhooks created in the wrong account will silently do nothing here.

Placeholders decided so far: **Pro $15/mo, Team $49/mo** (`plans.ts` display
values + the product script). If the final prices differ, change the script's
`PLANS` amounts *before* step 2 — the script is idempotent by `lookup_key`,
but it reuses an existing price as-is and does not update amounts.

## Step 1 — Test-mode keys into the server env

In the Helmian labs Stripe dashboard (test mode ON), Developers → API keys.
Put these in the SaaS server's env (the same env file the hosting setup uses —
see HOSTING.md / `.env.example`):

```
STRIPE_SECRET_KEY=sk_test_...        # Helmian labs TEST secret key
```

Do **not** set `STRIPE_ALLOW_LIVE` yet (step 5). With a test key and no live
flag the server runs billing in test mode; a live key in this state is
refused at boot on purpose.

## Step 2 — Create the products/prices (one command)

From `server.src/app`, with the test key in the environment:

```
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-create-products.mjs --apply
```

Idempotent: it finds prices by `lookup_key` (`helmian_scribe_pro_monthly`,
`helmian_scribe_team_monthly`) and creates product + monthly price only when
missing. It prints the two lines to paste into the server env:

```
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_TEAM=price_...
```

## Step 3 — Webhook endpoint + signing secret

In the Helmian labs dashboard (test mode), Developers → Webhooks → Add
endpoint:

- URL: `<PUBLIC_URL>/webhooks/stripe` (e.g. `https://connect.helmian.cloud/webhooks/stripe`)
- Events — exactly these four:
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Then reveal the endpoint's signing secret and put it in the server env:

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

Until this is set, the webhook route answers 503 and changes nothing — by
design. Also enable the **Customer Portal** in the dashboard (Settings →
Billing → Customer portal) or the portal button will fail for customers.

## Step 4 — Restart + prove one test checkout

Restart the SaaS server (boot validation now requires the Stripe config to
be complete: secret key + webhook secret + both prices, or it refuses).
Then, signed in as a tenant owner: Dashboard → upgrade to Pro → pay with
the test card `4242 4242 4242 4242` (any future date/CVC). Confirm:

- the tenant shows plan **pro** afterwards;
- `stripe_events` has the `checkout.session.completed` row with
  `apply_status = 'applied'`;
- cancel from the portal and confirm the plan returns to **free**
  (`customer.subscription.deleted`).

If an event ever lands with `apply_status = 'failed'`, read its
`apply_error`, fix the cause, and use the dashboard's **Resend** on that
event — redelivery now reprocesses it (pre-B8 it would have been swallowed
as a duplicate).

## Step 5 — Live mode (separate, deliberate)

Only when test mode is proven end to end and final prices are set:

1. Repeat steps 1–3 in the Helmian labs account with test mode OFF,
   using the live secret key and a **separate live webhook endpoint**
   (its own `whsec_...`). The product script needs both guards for live:
   `node scripts/stripe-create-products.mjs --apply --live` with
   `STRIPE_ALLOW_LIVE=yes-i-mean-live` in its environment.
2. In the server env, swap in the live `STRIPE_SECRET_KEY`, live
   `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM`, live `STRIPE_WEBHOOK_SECRET`,
   and add the one flag:

   ```
   STRIPE_ALLOW_LIVE=yes-i-mean-live
   ```

   Without that exact flag the server refuses the live key at boot and
   refuses live webhook events — that refusal is the safety working, not
   a bug.
3. Restart and repeat the step-4 proof with a real card at the final
   prices.
