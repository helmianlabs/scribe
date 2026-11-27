-- 012_memory_embeddings.down.sql — reverses 012_memory_embeddings.sql (drops only what 012 added; vectors are derived data).
BEGIN;
DROP TABLE IF EXISTS memory_embeddings;
COMMIT;
