/**
 * Database-backed OAuth 2.1 provider for SaaS mode (PKCE + Dynamic Client Registration).
 *
 * Differences from the self-host provider (../oauth-provider.ts):
 *  - consent is given by a SIGNED-IN ACCOUNT (magic-link session), not a shared passphrase;
 *  - every code/token is bound to one tenant (and the resource URL /t/<slug>/mcp);
 *  - clients, codes and tokens live in Postgres (hashed), so restarts lose nothing.
 */
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Db } from "./db.js";
import { sha256, randomToken, newId } from "./crypto.js";

export const ACCESS_TTL = 60 * 60;            // 1 hour
export const TRY_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days, first-party try-path token
export const REFRESH_TTL = 60 * 60 * 24 * 30;   // 30 days
export const CODE_TTL = 10 * 60;
export const PENDING_TTL = 30 * 60;           // time to finish the email sign-in on the consent page
export const SCOPES = ["memory.read", "memory.write"];
export const TRY_CLIENT_ID = "scribe-try";

/** Extract the tenant slug from a resource URL like https://host/t/<slug>/mcp */
export function slugFromResource(resource: string | undefined, publicUrl: string): string | null {
  if (!resource) return null;
  try {
    const u = new URL(resource);
    const base = new URL(publicUrl);
    if (u.origin !== base.origin) return null;
    const m = u.pathname.match(/^\/t\/([a-z0-9]{4,40})\/mcp\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

export interface Pending {
  id: string; client_id: string; redirect_uri: string; code_challenge: string; scopes: string[];
  state: string | null; resource: string | null; tenant_slug: string | null;
}

export class SaasOAuth implements OAuthServerProvider {
  constructor(private db: Db, private publicUrl: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      async getClient(clientId: string) {
        const r = await db.control.query("SELECT client_json FROM oauth_clients WHERE client_id = $1", [clientId]);
        return (r.rows[0]?.client_json as OAuthClientInformationFull) ?? undefined;
      },
      async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
        const full: OAuthClientInformationFull = { ...client, client_id: `mcp-client-${newId()}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
        await db.control.query("INSERT INTO oauth_clients (client_id, client_json) VALUES ($1,$2)", [full.client_id, JSON.stringify(full)]);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomToken(18);
    const resource = params.resource?.toString() ?? null;
    const scopes = (params.scopes?.length ? params.scopes : SCOPES).filter((s) => SCOPES.includes(s));
    await this.db.control.query(
      `INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge, scopes, state, resource, tenant_slug, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))`,
      [id, client.client_id, params.redirectUri, params.codeChallenge, scopes, params.state ?? null, resource, slugFromResource(resource ?? undefined, this.publicUrl), PENDING_TTL]);
    res.redirect(302, `/consent?pending=${encodeURIComponent(id)}`);
  }

  async getPending(id: string): Promise<Pending | null> {
    const r = await this.db.control.query("SELECT * FROM oauth_pending WHERE id = $1 AND expires_at > now()", [id]);
    return (r.rows[0] as Pending) ?? null;
  }

  async clientName(clientId: string): Promise<string> {
    const c = await this.clientsStore.getClient(clientId);
    return (c as OAuthClientInformationFull | undefined)?.client_name || "An AI app";
  }

  /** Signed-in user approved: mint a code bound to tenant + user. Returns the redirect URL. */
  async approve(pendingId: string, tenantId: string, userId: string): Promise<string | null> {
    const r = await this.db.control.query("DELETE FROM oauth_pending WHERE id = $1 AND expires_at > now() RETURNING *", [pendingId]);
    const p = r.rows[0] as Pending | undefined;
    if (!p) return null;
    const code = randomToken(24);
    await this.db.control.query(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, tenant_id, user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))`,
      [sha256(code), p.client_id, p.redirect_uri, p.code_challenge, p.scopes, p.resource, tenantId, userId, CODE_TTL]);
    const url = new URL(p.redirect_uri);
    url.searchParams.set("code", code);
    url.searchParams.set("iss", this.publicUrl);
    if (p.state != null) url.searchParams.set("state", p.state);
    return url.toString();
  }

  async deny(pendingId: string): Promise<string | null> {
    const r = await this.db.control.query("DELETE FROM oauth_pending WHERE id = $1 RETURNING redirect_uri, state", [pendingId]);
    const p = r.rows[0];
    if (!p) return null;
    const url = new URL(p.redirect_uri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "The user denied the authorization request.");
    url.searchParams.set("iss", this.publicUrl);
    if (p.state != null) url.searchParams.set("state", p.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const r = await this.db.control.query("SELECT code_challenge FROM oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()", [sha256(code)]);
    if (!r.rows[0]) throw new InvalidGrantError("Invalid authorization code");
    return r.rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const r = await this.db.control.query(
      "UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *", [sha256(code)]);
    const c = r.rows[0];
    if (!c) throw new InvalidGrantError("Invalid or already used authorization code");
    if (c.client_id !== client.client_id) throw new InvalidGrantError("Code was issued to a different client");
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    const res = resource?.toString() ?? c.resource ?? null;
    if (c.resource && resource && resource.toString() !== c.resource) throw new InvalidGrantError("resource mismatch");
    return this.mint(client.client_id, c.tenant_id, c.user_id, c.scopes, res);
  }

  private async mint(clientId: string, tenantId: string, userId: string, scopes: string[], resource: string | null, accessTtl = ACCESS_TTL): Promise<OAuthTokens> {
    const access = randomToken(32);
    const refresh = randomToken(32);
    await this.db.control.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, tenant_id, user_id, scopes, resource, expires_at)
       VALUES ($1,'access',$2,$3,$4,$5,$6, now() + make_interval(secs => $7)),
              ($8,'refresh',$2,$3,$4,$5,$6, now() + make_interval(secs => $9))`,
      [sha256(access), clientId, tenantId, userId, scopes, resource, accessTtl, sha256(refresh), REFRESH_TTL]);
    return { access_token: access, token_type: "Bearer", expires_in: accessTtl, refresh_token: refresh, scope: scopes.join(" ") };
  }

  /** First-party token for the no-signup try path. Hashed in oauth_tokens like any other access token. */
  async mintFirstParty(tenantId: string, userId: string, resource: string): Promise<OAuthTokens> {
    await this.db.control.query(
      `INSERT INTO oauth_clients (client_id, client_json) VALUES ($1, $2::jsonb) ON CONFLICT (client_id) DO NOTHING`,
      [TRY_CLIENT_ID, JSON.stringify({ client_id: TRY_CLIENT_ID, client_name: "Scribe Memory try", token_endpoint_auth_method: "none" })]);
    return this.mint(TRY_CLIENT_ID, tenantId, userId, SCOPES, resource, TRY_TOKEN_TTL);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const r = await this.db.control.query(
      `UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
      [sha256(refreshToken)]);
    const t = r.rows[0];
    if (!t) throw new InvalidGrantError("Invalid or expired refresh token");
    if (t.client_id !== client.client_id) throw new InvalidGrantError("Refresh token was issued to a different client");
    const granted = scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes;
    return this.mint(client.client_id, t.tenant_id, t.user_id, granted, resource?.toString() ?? t.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = await this.db.control.query(
      `SELECT client_id, tenant_id, user_id, scopes, resource, extract(epoch from expires_at)::bigint AS exp
       FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()`, [sha256(token)]);
    const t = r.rows[0];
    if (!t) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token, clientId: t.client_id, scopes: t.scopes, expiresAt: Number(t.exp),
      resource: t.resource ? new URL(t.resource) : undefined,
      extra: { tenantId: t.tenant_id, userId: t.user_id },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.control.query("UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1", [sha256(req.token)]);
  }

  /** Revoke every token of a tenant (used by delete-all / account deletion). */
  async revokeTenant(tenantId: string): Promise<void> {
    await this.db.control.query("UPDATE oauth_tokens SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL", [tenantId]);
  }

  async cleanup(): Promise<void> {
    await this.db.control.query("DELETE FROM oauth_pending WHERE expires_at < now()");
    await this.db.control.query("DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'");
    await this.db.control.query("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'");
    await this.db.control.query("DELETE FROM magic_links WHERE expires_at < now() - interval '1 day'");
    await this.db.control.query("DELETE FROM sessions WHERE expires_at < now()");
  }
}
