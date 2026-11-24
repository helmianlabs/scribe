-- Reverses 004_flags.sql (drops the flags table and everything in it).
BEGIN;
DROP TABLE IF EXISTS flags;
COMMIT;
