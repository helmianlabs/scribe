-- 000_base.sql — Base memory tables (projects, conversations, messages).
-- FIRST step of fresh-database provisioning (see docs/PROVISIONING.md and
-- server.src/app/scripts/provision-saas-db.mjs). Until now this schema existed only
-- implicitly: in Sam's live claude_memory database, in the throwaway staging
-- approximation (staging/initdb/00_base.sql) and in the test-suite BASE strings.
-- It matches that live schema: no FKs, no CHECKs, no defaults except the id sequence.
-- ADDITIVE ONLY + idempotent (IF NOT EXISTS): safe to re-run, and a no-op on a
-- database that already has the base tables (e.g. an import of the live archive).
-- Roles are NOT created here: the provisioning script creates memory_rw /
-- memory_ro_hz / memory_app before 001 runs (001 grants to the first two
-- unconditionally; 005/006 grant to memory_app when it exists).
-- Rollback: DROP TABLE IF EXISTS messages, conversations, projects; (data-destroying;
-- only ever on a database you provisioned and have not put into service.)

BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  raw  JSONB
);

CREATE TABLE IF NOT EXISTS conversations (
  uuid          TEXT PRIMARY KEY,
  name          TEXT,
  project_uuid  TEXT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  message_count INT
);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_uuid TEXT,
  turn_index       INT,
  sender           TEXT,
  text             TEXT,
  created_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv    ON messages (conversation_uuid);

COMMIT;
