-- Run these in the Neon Console SQL Editor (project: claude_memory,
-- database: claude_memory). The console runs as the database owner, which is
-- the one access level that can grant privileges on the archive tables.
-- Role memory_rw already exists (created 2026-10-21); its password lives
-- only in /opt/claude-memory-mcp/app.env as DATABASE_WRITE_URL.
GRANT SELECT, INSERT ON conversations, messages TO memory_rw;
GRANT USAGE ON SEQUENCE messages_id_seq TO memory_rw;
-- Proof it landed (should list INSERT+SELECT for memory_rw):
SELECT table_name, privilege_type FROM information_schema.role_table_grants
WHERE grantee = 'memory_rw' ORDER BY 1, 2;
