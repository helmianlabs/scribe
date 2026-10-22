-- Staging only: a throwaway copy of the live claude_memory base schema + the roles the migrations expect.
CREATE ROLE memory_rw NOLOGIN;
CREATE ROLE memory_ro_hz NOLOGIN;
-- The SaaS app role: not a superuser, no BYPASSRLS, so row-level security applies to it.
CREATE ROLE memory_app LOGIN PASSWORD 'staging-only-app-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE TABLE projects (uuid TEXT PRIMARY KEY, name TEXT, raw JSONB);
CREATE TABLE conversations (uuid TEXT PRIMARY KEY, name TEXT, project_uuid TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, message_count INT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_uuid TEXT, turn_index INT, sender TEXT, text TEXT, created_at TIMESTAMPTZ);
CREATE INDEX idx_messages_created ON messages (created_at);
CREATE INDEX idx_messages_conv ON messages (conversation_uuid);
INSERT INTO conversations (uuid, name) VALUES ('seed', 'Seed archive (tenant self)');
INSERT INTO messages (conversation_uuid, sender, text, created_at) VALUES ('seed', 'human', 'seed row that belongs to tenant self', now());
