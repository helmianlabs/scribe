/**
 * Centralised configuration, read from environment variables.
 *
 * Required at runtime (set as Fly secrets, NEVER committed):
 *   DATABASE_URL       - read-only Neon connection string for claude_memory (role memory_ro_hz)
 *   DATABASE_WRITE_URL - write Neon connection string for claude_memory (role memory_rw:
 *                        INSERT + SELECT on conversations/messages only; used solely by
 *                        the save_memory tool's pool in db.ts)
 *   AUTH_PASSPHRASE    - the passphrase Sam types on the OAuth consent screen
 *   PUBLIC_URL         - the canonical public https origin of this server
 *                        (e.g. https://your-app.fly.dev). No trailing slash.
 *
 * Optional:
 *   PORT               - listen port (Fly sets this; defaults to 8080)
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

export const DATABASE_URL = required("DATABASE_URL");
export const DATABASE_WRITE_URL = required("DATABASE_WRITE_URL");
export const AUTH_PASSPHRASE = required("AUTH_PASSPHRASE");

// Canonical public origin (no trailing slash). Used as the OAuth issuer,
// the RFC 8707 resource identifier, and to build redirect/well-known URLs.
export const PUBLIC_URL = required("PUBLIC_URL").replace(/\/+$/, "");

export const PORT = parseInt(process.env.PORT || "8080", 10);

// The MCP endpoint path. The canonical resource identifier is PUBLIC_URL + MCP_PATH.
export const MCP_PATH = "/mcp";

// Token / code lifetimes (seconds).
export const AUTH_CODE_TTL_SECONDS = 600; // 10 minutes
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const CHARACTER_LIMIT = 25000;
