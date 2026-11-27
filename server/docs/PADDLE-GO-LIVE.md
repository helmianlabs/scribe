# Paddle Billing: from sandbox to live

Paddle is the payment provider option for Scribe Memory (`PAYMENT_PROVIDER=paddle`). Paddle is the **merchant of record**: it
sells to the customer, collects and files sales tax and VAT, and pays you out. Stripe stays available behind the same switch
([STRIPE-GO-LIVE.md](STRIPE-GO-LIVE.md)); the default is still `stripe`, so nothing changes until the variable is set.

This document says what the code does, then lists **exactly what only the account owner can do**. Written against Paddle's
documentation as read on 2026-11-26 (developer.paddle.com). Nothing here has been run against a Paddle account: the code is
tested against a fake Paddle API and locally signed webhooks (`test/paddle.test.ts`), which proves this repo's logic against
Paddle's documented contract, not Paddle's real behaviour. The sandbox test pass (Part 1, step 8) is how that gets proven.

## What is built

| Piece | Where | Behaviour |
|---|---|---|
| Switch | `PAYMENT_PROVIDER=stripe\|paddle` (`saas/config.ts`) | Default `stripe`. A mistyped value refuses to boot. Both webhook routes stay mounted; each answers 503 until its own secret is set. |
| Plans | `PADDLE_PRICE_PERSONAL`, `PADDLE_PRICE_PERSONAL_YEARLY`, `PADDLE_PRICE_TEAM` | Personal $8/month or $80/year. Team $15 per seat per month; the **quantity is the seat count** (1 to 100). |
| Checkout | `POST /api/billing/checkout {plan, interval, seats}` → Paddle `POST /transactions` | Our tenant id goes in `custom_data`; Paddle copies it onto the subscription it creates. Returns Paddle's checkout link. |
| Checkout page | `GET /billing/pay` | Paddle has no hosted checkout. Its links point at a page you serve that loads Paddle.js (`cdn.paddle.com`); this is that page. It is the only page whose CSP allows `*.paddle.com`. |
| Webhook | `POST /webhooks/paddle` | `Paddle-Signature` verified (HMAC-SHA256 of `ts:rawBody`, timestamp within 5 s, constant-time compare, secret rotation tolerated). Bad or missing signature: 400, nothing recorded. No secret configured: 503. |
| Mapping | `subscription.created / activated / updated / resumed / trialing / past_due / paused / canceled` | Status `active`, `trialing`, `past_due` keep the paid plan. `paused` and `canceled` drop to Free. A cancel scheduled for period end keeps the plan until Paddle sends `canceled`. The plan comes from the subscription item's price id; seats from its quantity. |
| Safety | `paddle_events` (migration 010) | Idempotent by `event_id`; a failed apply answers 500 and is reprocessed on redelivery; an older event never overwrites a newer one (`occurred_at`); a late cancel of an old subscription never downgrades a tenant who subscribed again. |
| Customer portal | `POST /api/billing/portal` | Paddle customer-portal link (update card, view invoices, cancel). |
| Seat changes | `POST /api/billing/seats {seats}` | `PATCH /subscriptions/{id}` with the new quantity, prorated immediately. Seats change here only when Paddle's `subscription.updated` arrives. |
| Catalog script | `node server.src/app/scripts/paddle-create-products.mjs [--apply]` | Dry run by default. Creates the two products and three prices, idempotently (matched by `custom_data.helmian_key`). Refuses a non-sandbox key. Never prints the key. |
| Guards | startup validation | Half-configured Paddle refuses to boot; a live key needs `PADDLE_ALLOW_LIVE=yes-i-mean-live`; sandbox key with a `live_` client token (or the reverse) refuses to boot. |

Only `subscription.*` events change a plan. A transaction alone never grants one: Paddle creates the subscription when the
transaction is paid, and that event is what the code trusts.

### Environment variables

| Variable | Secret? | What |
|---|---|---|
| `PAYMENT_PROVIDER` | no | `paddle` |
| `PADDLE_API_KEY` | **yes** | Server-side API key. Sandbox keys contain `_sdbx`. Write permission for transactions, subscriptions and customer portal sessions (the dashboard lists them by name when the key is created), and read plus write on products and prices for the catalog script. Permission names were not verified for every one; grant what the dashboard shows for those areas. |
| `PADDLE_WEBHOOK_SECRET` | **yes** | The notification destination's endpoint secret key. |
| `PADDLE_CLIENT_TOKEN` | no (public by design) | Client-side token. `test_...` is sandbox, `live_...` is live. |
| `PADDLE_PRICE_PERSONAL`, `PADDLE_PRICE_PERSONAL_YEARLY`, `PADDLE_PRICE_TEAM` | no | `pri_...` ids printed by the catalog script. |
| `PADDLE_ALLOW_LIVE` | no | `yes-i-mean-live`. Leave unset until Part 4. |

## What only the account owner can do

Nothing below can be done by the assistant or by CI: each step needs the owner's identity, legal details, bank account, DNS or
secrets. **Keys and secrets go into the server's environment file or the host's secret store, never into chat, email, a ticket or
a screenshot.** If one is ever pasted somewhere it should not be, rotate it in the dashboard.

### Part 1: sandbox (no real money, no verification)

1. **Create a Paddle sandbox account** at https://sandbox-login.paddle.com/signup, in the owner's name, with a Helmian address
   (for example the Helmian Labs mailbox). A sandbox account is separate from the live one.
2. **Create a sandbox API key**: Paddle > My account > Settings > Authentication > API keys. Give it the permissions listed in the
   environment-variable table below. Copy it once into `PADDLE_API_KEY`. It contains `_sdbx`.
3. **Create a sandbox client-side token** on the same page (Client-side tokens tab). It starts with `test_`. Put it in
   `PADDLE_CLIENT_TOKEN`.
4. **Create the catalog**:
   `PADDLE_API_KEY=... node server.src/app/scripts/paddle-create-products.mjs --apply`
   Paste the three printed `PADDLE_PRICE_*` lines into the environment. Re-running is safe. (Or create the products and prices by
   hand in Paddle > Catalog; Team must allow quantity 1 to 100, Personal exactly 1.)
5. **Set the default payment link** to `https://scribemem.helmian.cloud/billing/pay` (Paddle > Checkout > Checkout configuration;
   the docs page "Set your default payment link" shows the screen). Paddle cannot create transactions without it. Sandbox checkout
   works on any domain, including a staging host.
6. **Create the notification destination**: Paddle > Events > Notifications > New destination. Type `url`, destination
   `https://scribemem.helmian.cloud/webhooks/paddle`, and subscribe to exactly:
   `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`,
   `subscription.paused`, `subscription.resumed`, `subscription.trialing`. Open the destination, copy its **secret key** into
   `PADDLE_WEBHOOK_SECRET`.
7. **Turn it on in a staging or test environment**: `PAYMENT_PROVIDER=paddle`, restart, and check the log shows no startup
   validation errors. (The host must be reachable from the internet for Paddle to deliver webhooks; Paddle's simulator in the
   dashboard can also send test events.)
8. **Run the sandbox test pass** (card `4242 4242 4242 4242`, any future date and CVC):
   - Dashboard > Personal monthly: checkout opens, pay, land on `/dashboard?billing=success`, plan shows Personal within seconds.
   - Same for Personal yearly and for Team with 3 seats (plan shows Team, 3 seats, 30,000 calls a day).
   - Change seats to 5 on the dashboard: Paddle updates, `subscription.updated` arrives, the dashboard shows 5.
   - Manage billing: the portal opens; cancel there; plan stays until the period ends (a sandbox subscription can be canceled
     immediately from the Paddle dashboard to see the drop to Free).
   - **Watch the browser console on `/billing/pay`.** The page's Content-Security-Policy allows `*.paddle.com` only; Paddle's
     own CSP list could not be retrieved, so this is **not verified**. If the console reports a blocked resource, widen
     `PADDLE_PAY_CSP` in `saas/pages.ts` for exactly what is named.
   - In Paddle > Events > Notifications > the destination, every delivery should show `200`.

### Part 2: what the live account needs before it can take money

Paddle's own checklist (https://developer.paddle.com/build/go-live-checklist) says a live account needs all of these. They are
the owner's, not the code's.

1. **A website that Paddle can review**, on `scribemem.helmian.cloud`, with **publicly accessible terms of service, privacy
   policy and refund policy pages**, prices that match the catalog (Personal $8/$80, Team $15 per seat), and a contact email
   address or form reachable from the home page. **These pages do not exist yet** (`docs/SAAS.md` lists terms and privacy as not
   built). They must be written, ideally read by a lawyer, and published first. Paddle's review also checks the site is a real
   product with real content.
2. **DNS for `scribemem.helmian.cloud`** and a proxy block for it on the host (see HOSTING.md). The record and the proxy are the
   owner's; nothing in this repo creates them.
3. **Sign up for a live Paddle account** at https://vendors.paddle.com/signup in the owner's name, and confirm the email.
4. **Submit the domain for approval**: Paddle > My account > Settings > Website approval. There is no API for this. **Live
   checkout will not open on an unapproved domain** (sandbox approves automatically).
5. **Complete account verification** (Paddle > Get started > Verify your account): the owner's personal details (date of birth,
   home address), the business's legal name and address, the website link, and a description of what is sold. Paddle's review
   usually takes about a day but can take several, and Paddle may ask for documents. An automated review also waits until a
   domain is approved.
6. **Set up payouts**: add the bank account in the Paddle dashboard when prompted. Also check the sales-tax mode and balance
   currency (My account > Settings > Sales tax and Currencies) and which payment methods are on (Checkout > Checkout
   configuration). Live settings are separate from sandbox.
7. **Decide the legal seller entity.** Paddle asks for the business that is selling. Which entity that is (for example DairyForge
   LLC, which is the licensor in `LICENSE`, or a Helmian entity) is the owner's decision, and it decides whose name is on the
   account, the terms and the payout.

### Part 3: switch to live (a separate, deliberate step)

1. In the **live** account: create a live API key and a live client-side token (My account > Settings > Authentication). The token
   starts with `live_`. Create the live catalog: run the script with the live key and
   `--live` plus `PADDLE_ALLOW_LIVE=yes-i-mean-live`, or recreate it by hand. **Sandbox ids do not carry over**: the three
   `pri_` ids differ.
2. In the live account: set the **default payment link** to `https://scribemem.helmian.cloud/billing/pay` (the domain must be
   approved first) and create the live **notification destination** with the same eight events. Copy its secret key.
3. In the server environment, replace all five Paddle values with the live ones and add `PADDLE_ALLOW_LIVE=yes-i-mean-live`.
   Startup refuses to boot if the key and token do not match (a live key with a `test_` token, or the reverse).
4. Restart. Make one real purchase with a real card, check the plan switches, then refund it from the Paddle dashboard.
5. Remove any leftover sandbox values. Do not leave `PADDLE_ALLOW_LIVE` set on a staging host.

## Operating notes

- **Webhook timing.** The signature check rejects a timestamp more than 5 seconds from the server clock, as Paddle recommends.
  Keep the host's clock on NTP. A rejected delivery is retried by Paddle.
- **Seats are an allowance.** Team's member allowance and daily call cap scale with seats, but there is no invite flow yet, so
  seats are not assigned to people.
- **Moving a tenant from Personal to Team** (or the reverse) is not done by a second checkout: checkout is refused while a
  subscription is active, to prevent double billing. Use the customer portal, or cancel and re-subscribe. A direct in-app
  plan-switch is not built.
- **Existing Stripe subscribers** stay on Stripe; their events still arrive at `/webhooks/stripe`. The switch only decides where
  *new* checkouts go.
- **Rollback.** Set `PAYMENT_PROVIDER=stripe` (or unset it) and restart. Paddle subscriptions already created keep working through
  `/webhooks/paddle` as long as its secret stays set. Migration 010 has a down file.
