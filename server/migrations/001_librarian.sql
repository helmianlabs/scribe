-- 001_librarian.sql — Shared Memory: Librarian tables (ADDITIVE ONLY).
-- Creates new tables/views/indexes. Does NOT alter, drop, or rewrite conversations, messages, or projects.
-- Append-only design: memory_rw keeps SELECT + INSERT only (no UPDATE/DELETE needed).
-- Run as the table owner (neondb_owner) inside database claude_memory. Idempotent (IF NOT EXISTS).
-- Rollback: migrations/001_librarian.down.sql (drops only the objects created here).

BEGIN;

CREATE TABLE IF NOT EXISTS librarian_settings (
  id           BIGSERIAL PRIMARY KEY,
  rulebook     TEXT NOT NULL,                 -- 'preset-a' | 'preset-b' | 'preset-c' | 'preset-d'
  chosen_by    TEXT NOT NULL,
  chosen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);  -- latest row wins (append-only)

CREATE TABLE IF NOT EXISTS memory_categories (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  parent_slug  TEXT,
  rulebook     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom (plain-word) and learned rules. Preset rules live in code, versioned in git.
CREATE TABLE IF NOT EXISTS librarian_rules (
  id           BIGSERIAL PRIMARY KEY,
  rule_key     TEXT NOT NULL,                 -- e.g. 'custom.1', 'learned.helmian.kokoro'
  layer        TEXT NOT NULL CHECK (layer IN ('custom','learned')),
  rule_json    JSONB NOT NULL,                -- the Rule object (when/category/addTags/priority/description)
  plain_text   TEXT,                          -- the sentence the user typed, if any
  enabled      BOOLEAN NOT NULL DEFAULT true, -- to disable: insert a new row with the same rule_key and enabled=false
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS librarian_rules_key_idx ON librarian_rules (rule_key, created_at DESC);

-- Every filing ever made (history). The current filing of a message = its newest row.
CREATE TABLE IF NOT EXISTS memory_filings (
  id           BIGSERIAL PRIMARY KEY,
  message_id   BIGINT NOT NULL,               -- messages.id
  category     TEXT NOT NULL,                 -- 'unsorted' = the unsorted tray
  tags         TEXT[] NOT NULL DEFAULT '{}',
  shape        TEXT NOT NULL,
  source       TEXT,
  rulebook     TEXT NOT NULL,
  rule_key     TEXT,                          -- exact rule that filed it; NULL when unsorted or manual
  explanation  TEXT NOT NULL,                 -- plain words: why it is here
  hits         JSONB NOT NULL DEFAULT '[]',   -- every rule that matched, for audit
  filed_by     TEXT NOT NULL CHECK (filed_by IN ('librarian','manual','backfill')),
  engine_ver   TEXT NOT NULL,
  filed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_filings_msg_idx ON memory_filings (message_id, filed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS memory_filings_cat_idx ON memory_filings (category);
CREATE INDEX IF NOT EXISTS memory_filings_tags_idx ON memory_filings USING GIN (tags);

-- Manual moves (drag to the right table). Source of learned triggers.
CREATE TABLE IF NOT EXISTS memory_moves (
  id            BIGSERIAL PRIMARY KEY,
  message_id    BIGINT NOT NULL,
  from_category TEXT NOT NULL,
  to_category   TEXT NOT NULL,
  learned_rule  TEXT,                         -- rule_key learned from this move, if any
  moved_by      TEXT NOT NULL,
  moved_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Current filing per message.
CREATE OR REPLACE VIEW memory_current_filing AS
  SELECT DISTINCT ON (message_id) *
  FROM memory_filings
  ORDER BY message_id, filed_at DESC, id DESC;

-- The unsorted tray: filed as unsorted, OR never filed at all (so nothing is ever lost).
CREATE OR REPLACE VIEW memory_unsorted AS
  SELECT m.id AS message_id, m.conversation_uuid, m.created_at, left(m.text, 300) AS preview,
         COALESCE(f.explanation, 'Not filed yet.') AS why
  FROM messages m
  LEFT JOIN memory_current_filing f ON f.message_id = m.id
  WHERE f.message_id IS NULL OR f.category = 'unsorted';

-- Current rules (latest row per rule_key, enabled only).
CREATE OR REPLACE VIEW librarian_active_rules AS
  SELECT * FROM (
    SELECT DISTINCT ON (rule_key) * FROM librarian_rules ORDER BY rule_key, created_at DESC, id DESC
  ) r WHERE r.enabled;

-- Write role: SELECT + INSERT only, same as on the memory tables. No UPDATE, no DELETE.
GRANT SELECT, INSERT ON librarian_settings, memory_categories, librarian_rules, memory_filings, memory_moves TO memory_rw;
GRANT USAGE ON SEQUENCE librarian_settings_id_seq, librarian_rules_id_seq, memory_filings_id_seq, memory_moves_id_seq TO memory_rw;
GRANT SELECT ON memory_current_filing, memory_unsorted, librarian_active_rules TO memory_rw;
-- Read role (memory_ro_hz): read only.
GRANT SELECT ON librarian_settings, memory_categories, librarian_rules, memory_filings, memory_moves,
                memory_current_filing, memory_unsorted, librarian_active_rules TO memory_ro_hz;

COMMIT;
