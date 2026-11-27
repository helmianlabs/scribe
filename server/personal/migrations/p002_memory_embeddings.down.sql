-- Rollback of p002_memory_embeddings.sql. Drops only the vectors table; no memory is touched.
DROP TABLE IF EXISTS memory_embeddings;
