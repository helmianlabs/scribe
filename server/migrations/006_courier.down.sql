-- Reverses 006_post_office.sql (drops the post office tables and every message in them).
BEGIN;
DROP TABLE IF EXISTS agent_message_reads, agent_directory, agent_messages;
COMMIT;
