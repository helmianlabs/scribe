-- 005_saas.sql — Hosted multi-tenant mode (MEMORY_MODE=saas).
-- For the HOSTED SaaS database only (a new Neon project/branch). NOT for Sam's single-tenant
-- claude_memory database: it turns on FORCE ROW LEVEL SECURITY on the memory tables, which
-- the self-host server (no tenant context) would then see as empty.
-- Requires: base tables (conversations, messages, projects), 001_librarian.sql, 004_flags.sql.
-- Existing rows become tenant 'self' (so Sam's archive can be imported as one tenant).
-- Idempotent. Rollback: 005_saas.down.sql
BEGIN;

-- ---------------------------------------------------------------- control plane (no RLS)
CREATE TABLE IF NOT EXISTS tenants (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL UNIQUE,          -- used in the per-tenant MCP URL /t/<slug>/mcp
  name                   TEXT NOT NULL,
  plan                   TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team')),
  plan_status            TEXT NOT NULL DEFAULT 'active', -- mirrors the Stripe subscription status
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT,
  alert_email            TEXT,
  alert_webhook_url      TEXT,
  alert_min_severity     TEXT NOT NULL DEFAULT 'high' CHECK (alert_min_severity IN ('low','medium','high','critical')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO tenants (id, slug, name, plan) VALUES ('self', 'self', 'Self-hosted archive', 'team')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,                 -- sha256 of the emailed token; the token itself is never stored
  email      TEXT NOT NULL,
  return_to  TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id   TEXT PRIMARY KEY,
  client_json JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  state          TEXT,
  resource       TEXT,
  tenant_slug    TEXT,                         -- from the resource URL /t/<slug>/mcp, when present
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  resource       TEXT,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id  TEXT NOT NULL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes     TEXT[] NOT NULL DEFAULT '{}',
  resource   TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_tenant_idx ON oauth_tokens (tenant_id);

-- Service API keys (for the Flags API and other server-to-server callers, e.g. Helmian Guard).
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,           -- sha256 of the key; shown to the user once
  prefix       TEXT NOT NULL,                  -- first chars, for display
  scopes       TEXT[] NOT NULL DEFAULT '{flags.write,flags.read}',
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,                -- Stripe event id (idempotency)
  type        TEXT NOT NULL,
  tenant_id   TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- data plane (tenant scoped)
CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  day       DATE NOT NULL,
  calls     INT NOT NULL DEFAULT 0,
  saves     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE conversations     ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE messages          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE projects          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE librarian_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE librarian_rules   ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE memory_filings    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE memory_moves      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'self';
-- New rows default to the transaction's tenant (the app also always writes tenant_id explicitly).
ALTER TABLE conversations      ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE messages           ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE projects           ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE librarian_settings ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE librarian_rules    ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE memory_filings     ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE memory_moves       ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);
ALTER TABLE flags              ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true);

CREATE INDEX IF NOT EXISTS conversations_tenant_name_idx ON conversations (tenant_id, name);
CREATE INDEX IF NOT EXISTS messages_tenant_created_idx  ON messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_tenant_conv_idx     ON messages (tenant_id, conversation_uuid);
CREATE INDEX IF NOT EXISTS memory_filings_tenant_idx    ON memory_filings (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS librarian_rules_tenant_idx   ON librarian_rules (tenant_id, rule_key);

-- Views rebuilt so they carry tenant_id and respect RLS of the CALLER (security_invoker, PG15+).
DROP VIEW IF EXISTS memory_unsorted;
DROP VIEW IF EXISTS memory_current_filing;
DROP VIEW IF EXISTS librarian_active_rules;
CREATE VIEW memory_current_filing WITH (security_invoker = true) AS
  SELECT DISTINCT ON (message_id) *
  FROM memory_filings
  ORDER BY message_id, filed_at DESC, id DESC;
CREATE VIEW memory_unsorted WITH (security_invoker = true) AS
  SELECT m.tenant_id, m.id AS message_id, m.conversation_uuid, m.created_at, left(m.text, 300) AS preview,
         COALESCE(f.explanation, 'Not filed yet.') AS why
  FROM messages m
  LEFT JOIN memory_current_filing f ON f.message_id = m.id AND f.tenant_id = m.tenant_id
  WHERE f.message_id IS NULL OR f.category = 'unsorted';
CREATE VIEW librarian_active_rules WITH (security_invoker = true) AS
  SELECT * FROM (
    SELECT DISTINCT ON (tenant_id, rule_key) * FROM librarian_rules ORDER BY tenant_id, rule_key, created_at DESC, id DESC
  ) r WHERE r.enabled;

-- Row-level security: every data-plane row is visible only inside a transaction that ran
--   SELECT set_config('app.tenant_id', '<tenant id>', true)
-- No tenant set => no rows (default deny). FORCE applies it to the table owner too.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages','projects','librarian_settings','librarian_rules',
                           'memory_filings','memory_moves','flags','usage_daily']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = current_setting('app.tenant_id', true))
                      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;

-- The SaaS app role (create it out of band with a strong password; NOT a superuser, NO BYPASSRLS):
--   CREATE ROLE memory_app LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      tenants, users, memberships, magic_links, sessions, oauth_clients, oauth_pending, oauth_codes,
      oauth_tokens, api_keys, stripe_events, usage_daily,
      conversations, messages, projects, librarian_settings, librarian_rules, memory_filings, memory_moves,
      memory_categories, flags
      TO memory_app;
    GRANT SELECT ON memory_current_filing, memory_unsorted, librarian_active_rules TO memory_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO memory_app;
  END IF;
END $$;

COMMIT;
