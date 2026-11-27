-- Rollback for 010_paddle_seats.sql. Drops the Paddle columns and the event log; Team tenants fall back to one seat.
BEGIN;
DROP TABLE IF EXISTS paddle_events;
DROP INDEX IF EXISTS tenants_paddle_customer_idx;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_payment_provider_check;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_seats_check;
ALTER TABLE tenants DROP COLUMN IF EXISTS paddle_event_at;
ALTER TABLE tenants DROP COLUMN IF EXISTS paddle_subscription_id;
ALTER TABLE tenants DROP COLUMN IF EXISTS paddle_customer_id;
ALTER TABLE tenants DROP COLUMN IF EXISTS payment_provider;
ALTER TABLE tenants DROP COLUMN IF EXISTS seats;
COMMIT;
