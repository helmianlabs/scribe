-- 003_search_index.sql (optional, additive): speeds up search_memory's ILIKE '%term%' scans.
-- Run as neondb_owner. Undo: DROP INDEX IF EXISTS messages_text_trgm; (extension can stay).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS messages_text_trgm ON messages USING GIN (text gin_trgm_ops);
