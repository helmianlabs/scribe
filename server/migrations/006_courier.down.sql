-- Reverses 006_courier.sql (drops the Courier tables and every message and receipt in them).
-- Memories, Librarian filings and legacy for-<x> letters are NOT touched.
BEGIN;
DROP TABLE IF EXISTS agent_message_receipts, agent_message_reads, agent_directory, agent_messages;
COMMIT;
