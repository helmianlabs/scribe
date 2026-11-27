-- 008_graph_value_kind.sql — DRAFT for the production deploy bite (graph v2 extraction).
-- NOT applied anywhere by the graph-fix bite; proven only against a scratch database.
--
-- Free-text extraction (librarian/extract.ts) creates entities for exact named
-- values found in filed text (a port, an endpoint id, a codename). Those are
-- neither people nor topics: they get their own kind, 'value'. The entities
-- table from 007 pins kind with an inline CHECK, whose auto-generated name is
-- entities_kind_check on a database built by 007 as written. The deploy bite
-- must confirm the constraint's actual name on each production database
-- before running this (pg_constraint lookup), on BOTH memory deployments
-- (Scribe memory and Helmian memory — separate databases, same codebase).
--
-- Idempotent in effect: safe to run once per database; a second run fails on
-- the DROP of an already-replaced constraint only if the name differs, so the
-- deploy bite runs it once, supervised, per database.
-- Rollback: reverse the CHECK to the original seven kinds — only valid while
-- no 'value' entities exist; after extraction has run in production the
-- rollback is a code rollback (revert extract wiring), not a schema rollback.

BEGIN;

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_kind_check;
ALTER TABLE entities ADD CONSTRAINT entities_kind_check
  CHECK (kind IN ('person','agent','project','product','org','place','topic','value'));

COMMIT;
