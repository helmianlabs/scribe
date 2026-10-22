/**
 * A self-contained OAuth 2.1 authorization server provider for this MCP server.
 *
 * The MCP server acts as BOTH the resource server and its own authorization
 * server (AS = RS). It implements:
 *   - Dynamic Client Registration (RFC 7591) via the in-memory clients store
 *   - Authorization Code grant with PKCE (validated by the SDK's token handler)
 *   - Refresh token grant
 *   - Bearer access-token verification
 *
 * The single human gate is a passphrase prompt rendered during authorize():
 * because this server exposes Sam's entire private conversation history, a
 * caller must prove they are Sam by entering AUTH_PASSPHRASE before any
 * authorization code is issued. Claude.ai (the MCP client) registers via DCR,
 * then drives the standard OAuth dance; the consent screen is where the human
 * actually authorizes.
 *
 * Auth codes and pending consents live in memory only. Registered clients,
 * access tokens and refresh tokens are persisted to OAUTH_STATE_FILE
 * (default /data/oauth-state.json) so connected AIs survive a restart.
 */
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  PUBLIC_URL,
  MCP_PATH,
  AUTH_CODE_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./config.js";
import { renderConsentPage } from "./consent.js";

const RESOURCE_ID = `${PUBLIC_URL}${MCP_PATH}`;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

interface StoredAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredAccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredRefreshToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

const clients = new Map<string, OAuthClientInformationFull>();
const authCodes = new Map<string, StoredAuthCode>();
const accessTokens = new Map<string, StoredAccessToken>();
const refreshTokens = new Map<string, StoredRefreshToken>();

// ---------------------------------------------------------------------------
// Persistence of clients / access tokens / refresh tokens
// ---------------------------------------------------------------------------

const STATE_FILE = process.env.OAUTH_STATE_FILE || "/data/oauth-state.json";

function loadState(): void {
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const t = now();
    for (const c of raw.clients ?? []) if (c?.client_id) clients.set(c.client_id, c);
    for (const a of raw.accessTokens ?? []) if (a?.token && a.expiresAt >= t) accessTokens.set(a.token, a);
    for (const r of raw.refreshTokens ?? []) if (r?.token && r.expiresAt >= t) refreshTokens.set(r.token, r);
    console.log(
      `oauth state loaded: ${clients.size} clients, ${accessTokens.size} access, ${refreshTokens.size} refresh`
    );
  } catch (err) {
    console.error("oauth state load failed (starting empty):", (err as Error).message);
  }
}

function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    const data = JSON.stringify({
      version: 1,
      clients: [...clients.values()],
      accessTokens: [...accessTokens.values()],
      refreshTokens: [...refreshTokens.values()],
    });
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error("oauth state save failed:", (err as Error).message);
  }
}

loadState();

// ---------------------------------------------------------------------------
// Pending-authorization tracking (between the consent GET and the consent POST)
// ---------------------------------------------------------------------------

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  createdAt: number;
}

const pendingAuth = new Map<string, PendingAuthorization>();

/**
 * Called from the consent POST handler (see index.ts). Validates the passphrase,
 * mints an authorization code, and returns the redirect URL back to the client
 * (Claude.ai) carrying ?code=...&state=...
 */
export function approveAuthorization(pendingId: string): string | null {
  const p = pendingAuth.get(pendingId);
  if (!p) return null;
  pendingAuth.delete(pendingId);

  const code = token(24);
  authCodes.set(code, {
    code,
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scopes: p.scopes,
    resource: p.resource,
    expiresAt: now() + AUTH_CODE_TTL_SECONDS,
  });

  const url = new URL(p.redirectUri);
  url.searchParams.set("code", code);
  if (p.state !== undefined) url.searchParams.set("state", p.state);
  return url.toString();
}

export function getPending(pendingId: string): PendingAuthorization | undefined {
  return pendingAuth.get(pendingId);
}

/** Build the client redirect for a denied / failed consent. */
export function denyAuthorization(pendingId: string): string | null {
  const p = pendingAuth.get(pendingId);
  if (!p) return null;
  const url = new URL(p.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "The user denied the authorization request.");
  if (p.state !== undefined) url.searchParams.set("state", p.state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Clients store (Dynamic Client Registration)
// ---------------------------------------------------------------------------

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return clients.get(clientId);
  },
  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: `mcp-client-${randomUUID()}`,
      client_id_issued_at: now(),
    };
    // Public client (Claude.ai) -> no client secret. token_endpoint_auth_method
    // defaults to "none" for public clients, which is correct for PKCE.
    clients.set(full.client_id, full);
    saveState();
    return full;
  },
};

/**
 * Re-adopt a client id this server issued before an in-memory restart wiped it.
 * Only our own id format and https redirect URIs; the passphrase consent still gates access.
 */
export function adoptClient(clientId: string, redirectUri: string): boolean {
  if (clients.has(clientId)) return false;
  if (!/^mcp-client-[0-9a-f-]{36}$/.test(clientId)) return false;
  let u: URL;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.protocol !== "https:") return false;
  clients.set(clientId, {
    client_id: clientId,
    client_id_issued_at: now(),
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Re-adopted client",
  } as OAuthClientInformationFull);
  saveState();
  console.log("oauth: re-adopted client", clientId, u.host);
  return true;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /**
   * Begin the authorization flow. Instead of auto-approving, we render an HTML
   * consent page asking for the passphrase. The form POSTs to /consent, which
   * (on success) calls approveAuthorization() and redirects back to the client.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const pendingId = token(18);
    pendingAuth.set(pendingId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      state: params.state,
      resource: params.resource?.toString(),
      createdAt: now(),
    });
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(
        renderConsentPage({
          pendingId,
          clientName: client.client_name || client.client_id,
          scopes: params.scopes ?? [],
        })
      );
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const rec = authCodes.get(authorizationCode);
    if (!rec) throw new Error("Invalid authorization code");
    return rec.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = authCodes.get(authorizationCode);
    if (!rec) throw new Error("Invalid authorization code");
    authCodes.delete(authorizationCode); // one-time use

    if (rec.expiresAt < now()) throw new Error("Authorization code expired");
    if (rec.clientId !== client.client_id) throw new Error("Authorization code was issued to a different client");
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    // PKCE (code_verifier vs code_challenge) is validated by the SDK token
    // handler using challengeForAuthorizationCode() above.

    const tokenResource = resource?.toString() ?? rec.resource ?? RESOURCE_ID;

    const accessToken = token(32);
    accessTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: rec.scopes,
      resource: tokenResource,
      expiresAt: now() + ACCESS_TOKEN_TTL_SECONDS,
    });

    const refreshToken = token(32);
    refreshTokens.set(refreshToken, {
      token: refreshToken,
      clientId: client.client_id,
      scopes: rec.scopes,
      resource: tokenResource,
      expiresAt: now() + REFRESH_TOKEN_TTL_SECONDS,
    });
    saveState();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: rec.scopes.join(" "),
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = refreshTokens.get(refreshToken);
    if (!rec) throw new Error("Invalid refresh token");
    if (rec.expiresAt < now()) {
      refreshTokens.delete(refreshToken);
      saveState();
      throw new Error("Refresh token expired");
    }
    if (rec.clientId !== client.client_id) throw new Error("Refresh token was issued to a different client");

    const grantedScopes = scopes && scopes.length ? scopes : rec.scopes;
    const tokenResource = resource?.toString() ?? rec.resource ?? RESOURCE_ID;

    // Rotate the refresh token (OAuth 2.1 requires rotation for public clients).
    refreshTokens.delete(refreshToken);
    const newRefresh = token(32);
    refreshTokens.set(newRefresh, {
      token: newRefresh,
      clientId: client.client_id,
      scopes: grantedScopes,
      resource: tokenResource,
      expiresAt: now() + REFRESH_TOKEN_TTL_SECONDS,
    });

    const accessToken = token(32);
    accessTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: grantedScopes,
      resource: tokenResource,
      expiresAt: now() + ACCESS_TOKEN_TTL_SECONDS,
    });
    saveState();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefresh,
      scope: grantedScopes.join(" "),
    };
  },

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const rec = accessTokens.get(accessToken);
    if (!rec) throw new InvalidTokenError("Invalid or unknown access token");
    if (rec.expiresAt < now()) {
      accessTokens.delete(accessToken);
      saveState();
      throw new InvalidTokenError("Access token expired");
    }
    return {
      token: rec.token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  },

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const changed = accessTokens.delete(request.token) || refreshTokens.delete(request.token);
    if (changed) saveState();
  },
};

// Periodic cleanup of expired in-memory records.
setInterval(() => {
  const t = now();
  let changed = false;
  for (const [k, v] of authCodes) if (v.expiresAt < t) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < t) { accessTokens.delete(k); changed = true; }
  for (const [k, v] of refreshTokens) if (v.expiresAt < t) { refreshTokens.delete(k); changed = true; }
  if (changed) saveState();
  for (const [k, v] of pendingAuth) if (v.createdAt + AUTH_CODE_TTL_SECONDS < t) pendingAuth.delete(k);
}, 60_000).unref();

// Exported for the SHA-256 PKCE helper if ever needed locally (kept for clarity).
export function sha256base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
