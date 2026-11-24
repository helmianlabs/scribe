/**
 * Discovery strictness (B7): the SaaS surface serves the same strict
 * discovery documents as the self-host surface (single.ts) — hand-built from
 * the slash-less PUBLIC_URL string, NOT the SDK router's URL-derived
 * metadata (whose issuer always ends in "/" and which omits jwks_uri and
 * the iss advertisement). These tests pin the exact document shapes so a
 * future SDK upgrade or refactor cannot silently regress them; strict
 * third-party checkers (Gemini's) canonicalize the issuer without a slash.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, api, connect, type Saas } from "./helpers.ts";

let s: Saas;
let me: any;

before(async () => {
  s = await startSaas();
  const cookie = await signIn(s, "dana@example.com");
  me = (await api(s, cookie)("/api/me")).body;
  (globalThis as any).__cookie = cookie;
});
after(async () => { await s.close(); });

const getJson = async (path: string) => {
  const r = await fetch(`${s.base}${path}`);
  assert.equal(r.status, 200, `${path} -> ${r.status}`);
  return r.json();
};

test("AS metadata: exact slash-less issuer and the full strict field set", async () => {
  const doc = await getJson("/.well-known/oauth-authorization-server");
  assert.equal(doc.issuer, s.base, "issuer is the exact PUBLIC_URL, no trailing slash");
  assert.equal(doc.authorization_endpoint, `${s.base}/authorize`);
  assert.equal(doc.token_endpoint, `${s.base}/token`);
  assert.equal(doc.registration_endpoint, `${s.base}/register`);
  assert.equal(doc.revocation_endpoint, `${s.base}/revoke`);
  assert.equal(doc.jwks_uri, `${s.base}/.well-known/jwks.json`);
  assert.deepEqual(doc.response_types_supported, ["code"]);
  assert.deepEqual(doc.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(doc.token_endpoint_auth_methods_supported, ["client_secret_post", "none"]);
  assert.deepEqual(doc.revocation_endpoint_auth_methods_supported, ["client_secret_post"]);
  assert.deepEqual(doc.scopes_supported, ["memory.read", "memory.write"]);
  // The provider DOES send iss on authorize redirects (RFC 9207) — the
  // document must advertise it, and the two must agree exactly.
  assert.equal(doc.authorization_response_iss_parameter_supported, true);
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === "string") assert.ok(!v.endsWith("://") && v !== `${s.base}/`, `${k} must not be a slashed origin: ${v}`);
  }
});

test("AS metadata: trailing-slash path and openid-configuration serve the same document", async () => {
  const a = await getJson("/.well-known/oauth-authorization-server");
  const b = await getJson("/.well-known/oauth-authorization-server/");
  const c = await getJson("/.well-known/openid-configuration");
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test("JWKS document exists and is an empty key set (opaque tokens)", async () => {
  const doc = await getJson("/.well-known/jwks.json");
  assert.deepEqual(doc, { keys: [] });
});

test("PR metadata (generic resource): served at the bare path and the /mcp variants, slash-less AS", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp/",
  ]) {
    const doc = await getJson(path);
    assert.equal(doc.resource, `${s.base}/mcp`, path);
    assert.deepEqual(doc.authorization_servers, [s.base], `${path}: authorization_servers is the exact slash-less issuer`);
    assert.deepEqual(doc.scopes_supported, ["memory.read", "memory.write"], path);
    assert.deepEqual(doc.bearer_methods_supported, ["header"], path);
    assert.equal(doc.resource_name, "Helmian Scribe", path);
  }
});

test("PR metadata (per-tenant resource): authorization_servers carries NO trailing slash", async () => {
  const slug = me.tenant.slug;
  const doc = await getJson(`/.well-known/oauth-protected-resource/t/${slug}/mcp`);
  assert.equal(doc.resource, me.mcp_url);
  assert.deepEqual(doc.authorization_servers, [s.base]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
  assert.equal(doc.resource_name, "Helmian Scribe");
});

test("RFC 9207 consistency: the iss on the authorize redirect equals the AS document's issuer", async () => {
  const cookie = (globalThis as any).__cookie as string;
  const tok = await connect(s, cookie, me.mcp_url);
  const back = new URL(tok.redirectUrl);
  const asDoc = await getJson("/.well-known/oauth-authorization-server");
  assert.equal(back.searchParams.get("iss"), asDoc.issuer);
  assert.equal(back.searchParams.get("iss"), s.base);
});
