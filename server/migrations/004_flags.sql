-- 004_flags.sql — Flags module (works in BOTH self-host single-tenant mode and SaaS mode).
-- ADDITIVE ONLY. Creates one table. Self-host rows carry tenant_id 'self'.
-- Do NOT run on Sam's production database without Sam's go-ahead.
-- Rollback: 004_flags.down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS flags (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), 'self'),
  severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  category    TEXT NOT NULL,                  -- secret | pii | harmful_code | hedging | moderation | privacy | other
  rule        TEXT,                           -- scanner rule id, e.g. 'secret.github_token'
  origin      TEXT NOT NULL CHECK (origin IN ('scanner','moderation','report','api')),
  source_ai   TEXT,                           -- which AI/app the content came from (caller-declared)
  reporter    TEXT,                           -- who filed it (tool caller, API key name, 'server')
  reason      TEXT NOT NULL,                  -- plain words
  excerpt     TEXT,                           -- ALWAYS redacted before storage
  message_id  BIGINT,                         -- messages.id when the flag came from a save
  context     JSONB NOT NULL DEFAULT '{}',    -- url, page, extra (redacted)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_tenant_created_idx ON flags (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS flags_tenant_sev_idx ON flags (tenant_id, severity);

-- Self-host roles (only if they exist): write role inserts + reads, read role reads.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_rw') THEN
    GRANT SELECT, INSERT ON flags TO memory_rw;
    GRANT USAGE ON SEQUENCE flags_id_seq TO memory_rw;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_ro_hz') THEN
    GRANT SELECT ON flags TO memory_ro_hz;
  END IF;
END $$;

COMMIT;
