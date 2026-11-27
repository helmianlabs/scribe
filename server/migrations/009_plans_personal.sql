-- 009_plans_personal.sql — Plan rename (pro -> personal) and the per-tenant stored-bytes counter. HOSTED SaaS database only.
-- Requires 005_saas.sql (tenants, usage_daily, the tenant_isolation convention).
--
--  * tenants.plan: 'pro' is retired. Existing 'pro' rows become 'personal'. (Only test-mode subscriptions exist as of
--    2026-11-26; the Stripe prices for the new plans are created with scripts/stripe-create-products.mjs.)
--  * tenant_storage: bytes of saved memory text per tenant, kept by saveMemory in the same transaction as the insert and
--    checked against the plan's maxBytes. Backfilled here from the existing rows. Same row-level security as the data tables.
-- Idempotent. Rollback: 009_plans_personal.down.sql
BEGIN;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
UPDATE tenants SET plan = 'personal' WHERE plan = 'pro';
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check CHECK (plan IN ('free','personal','team'));

CREATE TABLE IF NOT EXISTS tenant_storage (
  tenant_id  TEXT PRIMARY KEY DEFAULT current_setting('app.tenant_id', true) REFERENCES tenants(id) ON DELETE CASCADE,
  bytes      BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenant_storage (tenant_id, bytes)
  SELECT tenant_id, COALESCE(sum(octet_length(text)), 0) FROM messages GROUP BY tenant_id
  ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE tenant_storage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_storage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_storage;
CREATE POLICY tenant_isolation ON tenant_storage
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_storage TO memory_app;
  END IF;
END $$;

COMMIT;
