-- Reverses 008_graph.sql (drops the knowledge-graph tables and every entity, alias and link in them).
-- Memories and Librarian filings are NOT touched. Data-destroying for the graph only.
BEGIN;
DROP TABLE IF EXISTS links, entity_aliases, entities;
COMMIT;
