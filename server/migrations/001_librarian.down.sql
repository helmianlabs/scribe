-- Reverses 001_librarian.sql. Drops ONLY Librarian objects. Never touches conversations/messages/projects.
BEGIN;
DROP VIEW IF EXISTS librarian_active_rules;
DROP VIEW IF EXISTS memory_unsorted;
DROP VIEW IF EXISTS memory_current_filing;
DROP TABLE IF EXISTS memory_moves;
DROP TABLE IF EXISTS memory_filings;
DROP TABLE IF EXISTS librarian_rules;
DROP TABLE IF EXISTS memory_categories;
DROP TABLE IF EXISTS librarian_settings;
COMMIT;
