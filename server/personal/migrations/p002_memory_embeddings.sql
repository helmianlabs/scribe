-- p002_memory_embeddings.sql — PERSONAL single-user claude_memory database only. OPTIONAL, ADDITIVE, NOT APPLIED.
-- Storage for meaning-based search (src/embeddings.ts), which is OFF unless SCRIBE_EMBEDDINGS=local. Only needed if
-- that is turned on; without this table meaning search silently stays off and saving/searching work as before.
-- One new table; no existing row, column or table is changed. Idempotent. No tenant_id, no row-level security
-- (single user). Not for the hosted database (that one has 012_memory_embeddings.sql).
-- NEVER apply the hosted migrations 005, 011 or 012 to claude_memory.
--
-- Vectors are plain REAL[] (384 numbers per passage for all-MiniLM-L6-v2); similarity is computed in the app, so no
-- database extension is needed. A deleted memory takes its vectors with it (ON DELETE CASCADE).
-- Grants follow the server's two roles: memory_ro_hz (search pool) reads, memory_rw (save pool) inserts.
-- Run as the database owner:  psql "$OWNER_URL" -f p002_memory_embeddings.sql
-- Rollback: p002_memory_embeddings.down.sql (drops only this table, i.e. only the vectors; memories are untouched).
BEGIN;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id           BIGSERIAL PRIMARY KEY,
  message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  chunk_index  INT NOT NULL,
  chunk_start  INT NOT NULL DEFAULT 0,
  embedding    REAL[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_embeddings_once UNIQUE (message_id, model, chunk_index)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings (model, id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_ro_hz') THEN
    GRANT SELECT ON memory_embeddings TO memory_ro_hz;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_rw') THEN
    GRANT SELECT, INSERT ON memory_embeddings TO memory_rw;
    GRANT USAGE ON SEQUENCE memory_embeddings_id_seq TO memory_rw;
  END IF;
END $$;

COMMIT;
