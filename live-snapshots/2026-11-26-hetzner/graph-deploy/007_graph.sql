-rw-r----- 1 root root 4372 2026-11-23 09:22 /root/007_graph.sql
-- 007_graph.sql — Knowledge graph for the Librarian: entities, aliases, links (ADDITIVE ONLY).
-- Creates three new tables. Does NOT alter, drop, or rewrite any existing table.
-- The graph sits beside the Librarian's own tables (001): a filing stays a filing; the graph
-- records which named things (people, agents, projects, products, orgs, places, topics) a
-- memory touches and how those things connect, so recall can walk the connections later.
-- Links are append-only rows keyed by their source (the message / filing / move that proved
-- the connection), so the same connection found twice is stored once.
-- Idempotent (IF NOT EXISTS): safe to re-run; a no-op once applied.
-- Run as the table owner (neondb_owner) inside database claude_memory.
-- Rollback: DROP TABLE IF EXISTS links, entity_aliases, entities; (data-destroying;
-- only ever on a database you provisioned and have not put into service.)

BEGIN;

-- One row per named thing the memory knows about. canonical_key is the normalised name
-- (lowercase, punctuation folded to single spaces) and is the identity: two surface names
-- with the same canonical key are the same entity. First write wins for kind and display
-- name, the same convention as agent_directory (006).
CREATE TABLE IF NOT EXISTS entities (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('person','agent','project','product','org','place','topic')),
  name          TEXT NOT NULL,                -- display name, as first written
  canonical_key TEXT NOT NULL UNIQUE,         -- normalised identity key (see librarian/graph.ts)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Other surface names for an entity ('jdoe1' for the person 'Jane Doe').
-- alias_key is the same normalisation as canonical_key and is globally unique: a surface
-- name resolves to at most one entity, first registration wins.
CREATE TABLE IF NOT EXISTS entity_aliases (
  id         BIGSERIAL PRIMARY KEY,
  entity_id  BIGINT NOT NULL REFERENCES entities(id),
  alias      TEXT NOT NULL,                   -- the surface name, as written
  alias_key  TEXT NOT NULL UNIQUE,            -- normalised form of the alias
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_aliases_entity_idx ON entity_aliases (entity_id);

-- One row per proven connection between two entities. source_kind + source_id say which
-- record proved it: a row of messages, memory_filings, or memory_moves, or 'manual' for a
-- hand-made link (source_id NULL). The unique key makes re-filing the same record a no-op.
CREATE TABLE IF NOT EXISTS links (
  id             BIGSERIAL PRIMARY KEY,
  from_entity_id BIGINT NOT NULL REFERENCES entities(id),
  to_entity_id   BIGINT NOT NULL REFERENCES entities(id),
  relation       TEXT NOT NULL,               -- e.g. 'active_in', 'filed_under', 'mentioned'
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('message','filing','move','manual')),
  source_id      BIGINT,                      -- messages.id / memory_filings.id / memory_moves.id; NULL for manual
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_entity_id, to_entity_id, relation, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS links_from_idx ON links (from_entity_id);
CREATE INDEX IF NOT EXISTS links_to_idx ON links (to_entity_id);

-- Roles (only if they exist, the 004/006 pattern): the write role appends + reads, exactly
-- like the Librarian tables in 001 — upserts in code are INSERT ... ON CONFLICT DO NOTHING
-- plus SELECT, so memory_rw needs no UPDATE or DELETE here either.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_rw') THEN
    GRANT SELECT, INSERT ON entities, entity_aliases, links TO memory_rw;
    GRANT USAGE ON SEQUENCE entities_id_seq, entity_aliases_id_seq, links_id_seq TO memory_rw;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_ro_hz') THEN
    GRANT SELECT ON entities, entity_aliases, links TO memory_ro_hz;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON entities, entity_aliases, links TO memory_app;
    GRANT USAGE ON SEQUENCE entities_id_seq, entity_aliases_id_seq, links_id_seq TO memory_app;
  END IF;
END $$;

COMMIT;
