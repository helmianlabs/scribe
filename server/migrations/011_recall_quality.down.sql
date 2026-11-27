-- 011_recall_quality.down.sql — reverses 011_recall_quality.sql (drops only what 011 added).
BEGIN;
DROP TABLE IF EXISTS memory_recalls;
DROP TABLE IF EXISTS memory_supersessions;
DROP INDEX IF EXISTS messages_text_fts;
COMMIT;
