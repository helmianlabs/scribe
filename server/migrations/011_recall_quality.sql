-- 011_recall_quality.sql — Ranked recall, supersede and the recall log. HOSTED SaaS database only.
-- Requires 005_saas.sql (tenant_id on messages, row-level security, memory_app). ADDITIVE ONLY: no existing row,
-- column or table is changed. Idempotent. Rollback: 011_recall_quality.down.sql
--
--  * messages_text_fts: full-text index (english) behind ranked search_memory. An expression index, so the
--    messages table is not rewritten. The substring (pg_trgm, 003) path stays as the fallback tier.
--  * memory_supersessions: "B replaces A". A correction never deletes or edits A: search hides A by default
--    (include_history shows it), read_memory says which memory replaced it and when. Append-only.
--  * memory_recalls: one row each time a memory is read in full or confirmed ("still true"). Search ranking uses it:
--    memories that are used rank higher (strengthening); memories nobody has used in a long time rank lower (fading).
--    Nothing is ever deleted by fading.
BEGIN;

CREATE INDEX IF NOT EXISTS messages_text_fts ON messages USING GIN (to_tsvector('english', coalesce(text, '')));

CREATE TABLE IF NOT EXISTS memory_supersessions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  old_message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  new_message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reason          TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_supersessions_not_self CHECK (old_message_id <> new_message_id),
  CONSTRAINT memory_supersessions_once UNIQUE (tenant_id, old_message_id, new_message_id)
);
CREATE INDEX IF NOT EXISTS memory_supersessions_old_idx ON memory_supersessions (tenant_id, old_message_id);
CREATE INDEX IF NOT EXISTS memory_supersessions_new_idx ON memory_supersessions (tenant_id, new_message_id);

CREATE TABLE IF NOT EXISTS memory_recalls (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('read', 'confirm')),
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_recalls_msg_idx ON memory_recalls (tenant_id, message_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['memory_supersessions','memory_recalls']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = current_setting('app.tenant_id', true))
                      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    -- DELETE only so "delete all my data" can clear them; the app never edits these rows.
    GRANT SELECT, INSERT, DELETE ON memory_supersessions, memory_recalls TO memory_app;
    GRANT USAGE ON SEQUENCE memory_supersessions_id_seq, memory_recalls_id_seq TO memory_app;
  END IF;
END $$;

COMMIT;
