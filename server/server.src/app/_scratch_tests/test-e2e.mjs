// End-to-end test of the OAuth + MCP flow, simulating what Claude.ai does.
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.TEST_BASE || "http://localhost:8080";
const PASSPHRASE = process.env.TEST_PASSPHRASE || "test-pass-123";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function ok(label) { console.log(`  PASS  ${label}`); }
function fail(label, detail) { console.error(`  FAIL  ${label}: ${detail}`); process.exitCode = 1; }

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

console.log("=== 1. Unauthenticated /mcp -> 401 + WWW-Authenticate ===");
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const wa = r.headers.get("www-authenticate") || "";
  if (r.status === 401) ok("401 returned"); else fail("401 returned", `got ${r.status}`);
  if (/resource_metadata=/.test(wa)) ok(`WWW-Authenticate has resource_metadata (${wa})`);
  else fail("WWW-Authenticate resource_metadata", wa || "(missing header)");
}

console.log("=== 2. Protected Resource Metadata (RFC 9728) ===");
let asUrl;
{
  const r = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  const m = await j(r);
  if (r.status === 200) ok("200"); else fail("PRM 200", r.status);
  if (m.resource) ok(`resource=${m.resource}`); else fail("resource present", JSON.stringify(m));
  if (Array.isArray(m.authorization_servers) && m.authorization_servers.length) {
    asUrl = m.authorization_servers[0];
    ok(`authorization_servers[0]=${asUrl}`);
  } else fail("authorization_servers present", JSON.stringify(m));
}

console.log("=== 3. Authorization Server Metadata (RFC 8414) ===");
let meta;
{
  const r = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  meta = await j(r);
  if (r.status === 200) ok("200"); else fail("ASM 200", r.status);
  for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (meta[k]) ok(`${k}=${meta[k]}`); else fail(`${k} present`, JSON.stringify(meta));
  }
  if ((meta.code_challenge_methods_supported || []).includes("S256")) ok("PKCE S256 advertised");
  else fail("PKCE S256 advertised", JSON.stringify(meta.code_challenge_methods_supported));
}

console.log("=== 4. Dynamic Client Registration (RFC 7591) ===");
let clientId;
{
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const c = await j(r);
  if (r.status === 200 || r.status === 201) ok(`registered (${r.status})`); else fail("DCR status", `${r.status} ${JSON.stringify(c)}`);
  if (c.client_id) { clientId = c.client_id; ok(`client_id=${clientId}`); } else fail("client_id issued", JSON.stringify(c));
}

console.log("=== 5. Authorize (PKCE) -> consent page ===");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(8));
let pendingId;
{
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", `${BASE}/mcp`);
  u.searchParams.set("scope", "memory.read");
  const r = await fetch(u, { redirect: "manual" });
  const html = await r.text();
  if (r.status === 200 && /pending_id/.test(html)) ok("consent page rendered");
  else fail("consent page", `status ${r.status}`);
  const m = /name="pending_id" value="([^"]+)"/.exec(html);
  if (m) { pendingId = m[1]; ok(`pending_id captured`); } else fail("pending_id in form", "not found");
}

console.log("=== 6a. Consent with WRONG passphrase -> rejected, no code ===");
{
  const body = new URLSearchParams({ pending_id: pendingId, action: "approve", passphrase: "wrong" });
  const r = await fetch(`${BASE}/consent`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  if (r.status === 401) ok("wrong passphrase -> 401"); else fail("wrong passphrase rejected", r.status);
}

console.log("=== 5b. Re-authorize (the wrong attempt consumed the first pending) ===");
{
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", `${BASE}/mcp`);
  const r = await fetch(u, { redirect: "manual" });
  const html = await r.text();
  const m = /name="pending_id" value="([^"]+)"/.exec(html);
  pendingId = m ? m[1] : null;
  if (pendingId) ok("re-authorized, new pending_id"); else fail("re-authorize", "no pending_id");
}

console.log("=== 6b. Consent with CORRECT passphrase -> redirect w/ code ===");
let code;
{
  const body = new URLSearchParams({ pending_id: pendingId, action: "approve", passphrase: PASSPHRASE });
  const r = await fetch(`${BASE}/consent`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  const loc = r.headers.get("location") || "";
  if (r.status === 302) ok("302 redirect"); else fail("consent approve 302", r.status);
  const lu = new URL(loc);
  code = lu.searchParams.get("code");
  const st = lu.searchParams.get("state");
  if (lu.origin + lu.pathname === REDIRECT) ok("redirect to claude callback"); else fail("redirect target", loc);
  if (code) ok("code present"); else fail("code present", loc);
  if (st === state) ok("state echoed"); else fail("state echoed", `${st} != ${state}`);
}

console.log("=== 7. Token exchange (code + verifier) ===");
let accessToken, refreshToken;
{
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  });
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const t = await j(r);
  if (r.status === 200) ok("token 200"); else fail("token status", `${r.status} ${JSON.stringify(t)}`);
  accessToken = t.access_token; refreshToken = t.refresh_token;
  if (accessToken) ok("access_token issued"); else fail("access_token", JSON.stringify(t));
  if (refreshToken) ok("refresh_token issued"); else fail("refresh_token", JSON.stringify(t));
}

console.log("=== 7b. PKCE negative: token with WRONG verifier -> rejected ===");
{
  // need a fresh code; re-run authorize+consent quickly
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  const r0 = await fetch(u, { redirect: "manual" });
  const html = await r0.text();
  const pid = /name="pending_id" value="([^"]+)"/.exec(html)[1];
  const cbody = new URLSearchParams({ pending_id: pid, action: "approve", passphrase: PASSPHRASE });
  const r1 = await fetch(`${BASE}/consent`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody, redirect: "manual" });
  const code2 = new URL(r1.headers.get("location")).searchParams.get("code");
  const body = new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: clientId, code_verifier: "totally-wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaa" });
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (r.status >= 400) ok(`wrong PKCE verifier rejected (${r.status})`); else fail("PKCE negative", `got ${r.status}`);
}

console.log("=== 8. MCP initialize with Bearer token ===");
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } }),
  });
  const t = await j(r);
  if (r.status === 200 && t.result) ok(`initialize ok (server ${t.result.serverInfo?.name})`); else fail("initialize", `${r.status} ${JSON.stringify(t)}`);
}

console.log("=== 9. tools/list with Bearer token ===");
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const t = await j(r);
  const tools = t.result?.tools || [];
  if (tools.some((x) => x.name === "search_memory")) ok("search_memory listed"); else fail("tools/list", JSON.stringify(t));
}

console.log("=== 10. tools/call search_memory ===");
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "milk", limit: 3 } } }),
  });
  const t = await j(r);
  const sc = t.result?.structuredContent;
  if (sc && typeof sc.total === "number") ok(`search returned total=${sc.total}, returned=${sc.returned}`);
  else fail("search_memory call", JSON.stringify(t).slice(0, 400));
  const first = sc?.results?.[0];
  if (first && "conversation_name" in first && "sender" in first && "created_at" in first && "snippet" in first)
    ok(`row shape correct (e.g. "${first.conversation_name}" / ${first.sender})`);
  else if (sc?.total === 0) ok("no rows for 'milk' (shape n/a, total 0)");
  else fail("row shape", JSON.stringify(first));
}

console.log("=== 11. Refresh token grant ===");
{
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const t = await j(r);
  if (r.status === 200 && t.access_token) ok("refresh -> new access_token"); else fail("refresh grant", `${r.status} ${JSON.stringify(t)}`);
  if (t.refresh_token && t.refresh_token !== refreshToken) ok("refresh token rotated"); else fail("refresh rotation", "not rotated");
}

console.log("=== 12. Bad token -> 401 ===");
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer not-a-real-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
  });
  if (r.status === 401) ok("bad token -> 401"); else fail("bad token rejected", r.status);
}

console.log(process.exitCode ? "\n*** SOME TESTS FAILED ***" : "\n*** ALL TESTS PASSED ***");
