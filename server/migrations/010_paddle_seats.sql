-- 010_paddle_seats.sql — Seats and Paddle billing columns. HOSTED SaaS database only.
-- Requires 005_saas.sql (tenants) and 009_plans_personal.sql. ADDITIVE ONLY.
--
--  * tenants.seats: seat quantity on the subscription (Team is $15 per seat). Team's member allowance and daily call cap
--    scale with it. Free and Personal stay at 1.
--  * tenants.payment_provider: which provider holds the subscription ('stripe' | 'paddle'); NULL while on Free.
--  * tenants.paddle_customer_id / paddle_subscription_id: Paddle's ids (ctm_..., sub_...).
--  * tenants.paddle_event_at: occurred_at of the last Paddle subscription event applied. Paddle does not promise delivery
--    order, so an older event never overwrites a newer one.
--  * paddle_events: webhook idempotency and apply tracking, the same shape as stripe_events after 007. Paddle and Stripe
--    event ids are both 'evt_...', so they do not share a table. Control plane, no row-level security (like stripe_events).
-- The daily call cap needs no schema: it uses usage_daily, which already exists.
-- Idempotent. Rollback: 010_paddle_seats.down.sql
BEGIN;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seats INT NOT NULL DEFAULT 1;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_seats_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_seats_check CHECK (seats BETWEEN 1 AND 1000);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_payment_provider_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_payment_provider_check CHECK (payment_provider IS NULL OR payment_provider IN ('stripe','paddle'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_event_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_paddle_customer_idx ON tenants (paddle_customer_id) WHERE paddle_customer_id IS NOT NULL;

-- Tenants already paying through Stripe are recorded as such.
UPDATE tenants SET payment_provider = 'stripe' WHERE payment_provider IS NULL AND stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS paddle_events (
  id           TEXT PRIMARY KEY,                -- Paddle event_id (idempotency)
  type         TEXT NOT NULL,
  tenant_id    TEXT,
  occurred_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  apply_status TEXT NOT NULL DEFAULT 'received',  -- 'received' | 'applied' | 'failed'
  apply_error  TEXT,
  applied_at   TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON paddle_events TO memory_app;
  END IF;
END $$;

COMMIT;
