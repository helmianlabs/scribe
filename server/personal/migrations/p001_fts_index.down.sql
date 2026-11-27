-- Rollback of p001_fts_index.sql. Drops only the index; no data is touched. Ranked search keeps working (slower).
DROP INDEX CONCURRENTLY IF EXISTS messages_text_fts;
