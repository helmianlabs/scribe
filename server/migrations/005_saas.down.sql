-- Reverses 005_saas.sql. Memory rows are kept (tenant_id columns are dropped, so every
-- tenant's rows merge back into one archive — export tenants first if that matters).
BEGIN;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages','projects','librarian_settings','librarian_rules',
                           'memory_filings','memory_moves','flags','usage_daily']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP VIEW IF EXISTS memory_unsorted;
DROP VIEW IF EXISTS memory_current_filing;
DROP VIEW IF EXISTS librarian_active_rules;
ALTER TABLE flags ALTER COLUMN tenant_id SET DEFAULT 'self';
ALTER TABLE conversations      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE messages           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE projects           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE librarian_settings DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE librarian_rules    DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE memory_filings     DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE memory_moves       DROP COLUMN IF EXISTS tenant_id;
-- Restore the 001 views.
CREATE VIEW memory_current_filing AS
  SELECT DISTINCT ON (message_id) * FROM memory_filings ORDER BY message_id, filed_at DESC, id DESC;
CREATE VIEW memory_unsorted AS
  SELECT m.id AS message_id, m.conversation_uuid, m.created_at, left(m.text, 300) AS preview,
         COALESCE(f.explanation, 'Not filed yet.') AS why
  FROM messages m LEFT JOIN memory_current_filing f ON f.message_id = m.id
  WHERE f.message_id IS NULL OR f.category = 'unsorted';
CREATE VIEW librarian_active_rules AS
  SELECT * FROM (SELECT DISTINCT ON (rule_key) * FROM librarian_rules ORDER BY rule_key, created_at DESC, id DESC) r WHERE r.enabled;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_rw') THEN
    GRANT SELECT ON memory_current_filing, memory_unsorted, librarian_active_rules TO memory_rw; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_ro_hz') THEN
    GRANT SELECT ON memory_current_filing, memory_unsorted, librarian_active_rules TO memory_ro_hz; END IF;
END $$;
DROP TABLE IF EXISTS usage_daily, stripe_events, api_keys, oauth_tokens, oauth_codes, oauth_pending,
  oauth_clients, sessions, magic_links, memberships, users, tenants;
COMMIT;
