-- 007_stripe_events_status.sql — Webhook apply tracking for stripe_events (B8).
-- ADDITIVE ONLY. 005 created stripe_events as a bare idempotency log: the old webhook
-- handler inserted the event row BEFORE applying it, so if applying threw, Stripe's
-- retry was answered "duplicate" and the entitlement change was lost forever. These
-- columns let the handler distinguish "seen" from "applied":
--   apply_status: 'received' (claimed, not yet applied) | 'applied' | 'failed'
--   apply_error:  the last apply failure's message (NULL once applied)
--   applied_at:   when the event was successfully applied
--   attempts:     how many deliveries have claimed the event
-- The DEFAULT for apply_status is 'applied' ON PURPOSE: rows written before this
-- migration were applied synchronously by the old handler before it answered, so
-- backfilling them as 'applied' preserves their duplicate suppression. The new
-- handler always writes the status explicitly on insert ('received'), so the
-- default never classifies a new event.
-- Idempotent. Rollback: 007_stripe_events_status.down.sql
BEGIN;

ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS apply_status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS apply_error TEXT;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

COMMIT;
