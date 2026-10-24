-- 006_post_office.sql — Post office: AIs message each other through the memory server.
-- ADDITIVE ONLY. Kept separate from memories: these rows are never filed by the Librarian
-- and never returned by search_memory. Append-only (INSERT + SELECT), so the self-host
-- memory_rw role is enough. Self-host rows carry tenant_id 'self'.
-- In a SaaS database (005 applied) it also turns on row-level security for the new tables.
-- Do NOT run on Sam's production database without Sam's go-ahead.
-- Rollback: 006_post_office.down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS agent_messages (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), 'self'),
  thread_id      BIGINT,                      -- id of the first message in the thread (NULL = this one starts it)
  reply_to       BIGINT,                      -- message this one answers
  from_agent     TEXT NOT NULL,               -- normalized agent name, e.g. 'paul', 'muse', 'claude.ai'
  from_client_id TEXT,                        -- OAuth client that actually sent it (server-recorded, not self-declared)
  from_client_name TEXT,
  to_agent       TEXT NOT NULL,               -- agent name or 'all'
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,               -- secrets/PII redacted before storage
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_inbox_idx ON agent_messages (tenant_id, to_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_messages_thread_idx ON agent_messages (tenant_id, thread_id);

-- Read receipts, one row per (message, reader). Needed because a message to 'all' is read separately by each agent.
CREATE TABLE IF NOT EXISTS agent_message_reads (
  tenant_id  TEXT NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), 'self'),
  message_id BIGINT NOT NULL,
  agent      TEXT NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, agent)
);

-- Agent directory: first time a name is seen (and from which OAuth client). Insert-only.
CREATE TABLE IF NOT EXISTS agent_directory (
  tenant_id   TEXT NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), 'self'),
  name        TEXT NOT NULL,
  client_id   TEXT NOT NULL DEFAULT '',       -- '' = self-declared without a known client
  client_name TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name, client_id)
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_rw') THEN
    GRANT SELECT, INSERT ON agent_messages, agent_message_reads, agent_directory TO memory_rw;
    GRANT USAGE ON SEQUENCE agent_messages_id_seq TO memory_rw;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_ro_hz') THEN
    GRANT SELECT ON agent_messages, agent_message_reads, agent_directory TO memory_ro_hz;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, DELETE ON agent_messages, agent_message_reads, agent_directory TO memory_app;
    GRANT USAGE ON SEQUENCE agent_messages_id_seq TO memory_app;
  END IF;
END $$;

-- SaaS database (005 applied): tenant isolation by row-level security, like the other data tables.
DO $$
DECLARE t TEXT;
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    FOREACH t IN ARRAY ARRAY['agent_messages','agent_message_reads','agent_directory'] LOOP
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                        USING (tenant_id = current_setting('app.tenant_id', true))
                        WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
    END LOOP;
  END IF;
END $$;

COMMIT;
