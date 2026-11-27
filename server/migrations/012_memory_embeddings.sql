-- 012_memory_embeddings.sql — Meaning-based (embedding) search. HOSTED SaaS database only. The table is always created;
-- filling and using it is off unless the server runs with SCRIBE_EMBEDDINGS=local.
-- Requires 005_saas.sql and 011_recall_quality.sql. ADDITIVE ONLY. Idempotent. Rollback: 012_memory_embeddings.down.sql
--
--  * memory_embeddings: one row per passage (~500 characters) of a memory: the embedding vector from a small local
--    model (default Xenova/all-MiniLM-L6-v2, 384 numbers, no paid key) stored as REAL[], so plain Postgres works
--    with no extension. search_memory blends these with full-text ranking when the server runs with
--    SCRIBE_EMBEDDINGS=local. Without this table, or with embeddings off, search is full-text/literal only.
--  * Scale note: similarity is computed in the app over the tenant's vectors. For very large tenants, move the
--    column to pgvector (vector(384) + HNSW index); the app code keeps the same interface.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  chunk_index  INT NOT NULL,
  chunk_start  INT NOT NULL,
  embedding    REAL[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_embeddings_once UNIQUE (tenant_id, message_id, model, chunk_index)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_tenant_model_idx ON memory_embeddings (tenant_id, model);

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_embeddings;
CREATE POLICY tenant_isolation ON memory_embeddings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    -- DELETE so "delete all my data" can clear them; vectors are derived data and can always be rebuilt.
    GRANT SELECT, INSERT, DELETE ON memory_embeddings TO memory_app;
    GRANT USAGE ON SEQUENCE memory_embeddings_id_seq TO memory_app;
  END IF;
END $$;

COMMIT;
