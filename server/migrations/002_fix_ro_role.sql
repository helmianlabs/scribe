-- 002_fix_ro_role.sql — SECURITY FIX for memory_ro_hz (SAM'S CALL; do not run without his yes).
-- Today memory_ro_hz is a member of neon_superuser, so "read only" is enforced only by the app.
-- This makes the database enforce it. Run as neondb_owner in the Neon SQL editor.
-- Check first:  SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
--               WHERE a.member = 'memory_ro_hz'::regrole;
BEGIN;
REVOKE neon_superuser FROM memory_ro_hz;
GRANT CONNECT ON DATABASE claude_memory TO memory_ro_hz;
GRANT USAGE ON SCHEMA public TO memory_ro_hz;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO memory_ro_hz;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO memory_ro_hz;
ALTER ROLE memory_ro_hz SET default_transaction_read_only = on;
COMMIT;
-- Undo:  GRANT neon_superuser TO memory_ro_hz;  ALTER ROLE memory_ro_hz RESET default_transaction_read_only;
