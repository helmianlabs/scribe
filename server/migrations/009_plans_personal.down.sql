-- Rollback for 009_plans_personal.sql. Personal tenants go back to 'pro' (the retired id); the byte counter is dropped.
BEGIN;
DROP TABLE IF EXISTS tenant_storage;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
UPDATE tenants SET plan = 'pro' WHERE plan = 'personal';
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check CHECK (plan IN ('free','pro','team'));
COMMIT;
