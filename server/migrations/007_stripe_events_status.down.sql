-- Rollback for 007_stripe_events_status.sql: drop the apply-tracking columns.
-- (The webhook handler from B8 requires them; roll the code back first.)
BEGIN;

ALTER TABLE stripe_events DROP COLUMN IF EXISTS apply_status;
ALTER TABLE stripe_events DROP COLUMN IF EXISTS apply_error;
ALTER TABLE stripe_events DROP COLUMN IF EXISTS applied_at;
ALTER TABLE stripe_events DROP COLUMN IF EXISTS attempts;

COMMIT;
