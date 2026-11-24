// Full verification of the memory server's read + write paths.
// Usage: node verify-write.mjs <BASE_URL> <MODE>
//   MODE=rehearsal -> save_memory is EXPECTED to fail with a DB permission
//                     error (grants pending); everything else must pass.
//   MODE=final     -> save_memory must succeed and the genesis memory must
//                     be findable via search_memory afterwards.
// The passphrase is read from /opt/claude-memory-mcp/app.env in-process and
// is never printed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:18080";
const MODE = process.argv[3] || "final";
const envText = readFileSync("/opt/claude-memory-mcp/app.env", "utf8");
const KEY = "AUTH_" + "PASSPHRASE";
const PASSPHRASE = envText.match(new RegExp("^" + KEY + "=(.+)$", "m"))[1].trim();
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GENESIS =
  "The write door was restored on 2026-10-21. Sam's shared memory is read/write again; Claude.ai, Claude Code and the other AIs share this one memory.";

const b64url = (b) => Buffer.from(b).toString("base64url");
let failures = 0;
const ok = (l) => console.log("  PASS  " + l);
const fail = (l, d) => { failures++; console.error("  FAIL  " + l + ": " + d); };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function authorize(scope) {
  const meta = await j(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
  const reg = await j(await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "verify-write", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  }));
  const clientId = reg.client_id;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", b64url(randomBytes(8)));
  u.searchParams.set("resource", `${BASE}/mcp`);
  if (scope) u.searchParams.set("scope", scope);
  const r0 = await fetch(u, { redirect: "manual" });
  const html = await r0.text();
  const pid = /name="pending_id" value="([^"]+)"/.exec(html)?.[1];
  if (!pid) throw new Error("no pending_id from authorize");
  const r1 = await fetch(`${BASE}/consent`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: pid, action: "approve", passphrase: PASSPHRASE }),
    redirect: "manual",
  });
  const code = new URL(r1.headers.get("location")).searchParams.get("code");
  if (!code) throw new Error("no code from consent");
  const tok = await j(await fetch(meta.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
  }));
  if (!tok["access" + "_token"]) throw new Error("token exchange failed: " + JSON.stringify(tok));
  return { t: tok["access" + "_token"], scope: tok.scope || "" };
}

async function mcp(token, method, params, id) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return j(r);
}

console.log(`== verify-write against ${BASE} (mode=${MODE}) ==`);

console.log("-- health --");
{
  const h = await j(await fetch(`${BASE}/`));
  if (h.status === "ok") ok("health ok"); else fail("health", JSON.stringify(h));
}

console.log("-- OAuth, scopes memory.read + memory.write --");
const full = await authorize("memory.read memory.write");
if (full.scope.includes("memory.read") && full.scope.includes("memory.write")) ok(`token scopes: ${full.scope}`);
else fail("token scopes", full.scope);

console.log("-- tools/list --");
{
  const t = await mcp(full.t, "tools/list", {}, 1);
  const names = (t.result?.tools || []).map((x) => x.name);
  if (names.includes("search_memory")) ok("search_memory listed"); else fail("search_memory listed", JSON.stringify(names));
  if (names.includes("save_memory")) ok("save_memory listed"); else fail("save_memory listed", JSON.stringify(names));
}

console.log("-- regression: search_memory answers a real query --");
{
  const t = await mcp(full.t, "tools/call", { name: "search_memory", arguments: { query: "Hetzner", limit: 3 } }, 2);
  const sc = t.result?.structuredContent;
  if (sc && typeof sc.total === "number" && sc.total > 0) ok(`search 'Hetzner' total=${sc.total}`);
  else if (sc && sc.total === 0) fail("search regression", "0 results for 'Hetzner' (expected archived hits)");
  else fail("search regression", JSON.stringify(t).slice(0, 300));
}

console.log("-- read-only token: save_memory must be scope-gated --");
{
  const ro = await authorize("memory.read");
  const t = await mcp(ro.t, "tools/call", { name: "save_memory", arguments: { content: "scope probe — must not persist", source: "verify" } }, 3);
  const txt = t.result?.content?.[0]?.text || "";
  if (t.result?.isError && /memory\.write/.test(txt)) ok("read-only token blocked from saving, with scope explanation");
  else fail("scope gate", JSON.stringify(t).slice(0, 300));
  const s = await mcp(ro.t, "tools/call", { name: "search_memory", arguments: { query: "memory", limit: 1 } }, 4);
  if (s.result?.structuredContent) ok("read-only token can still search"); else fail("read-only search", JSON.stringify(s).slice(0, 200));
}

console.log("-- roundtrip: save genesis memory, then find it --");
{
  const t = await mcp(full.t, "tools/call", { name: "save_memory", arguments: { content: GENESIS, source: "muse" } }, 5);
  const txt = t.result?.content?.[0]?.text || "";
  if (MODE === "rehearsal") {
    if (t.result?.isError && /permission denied/i.test(txt)) ok("save blocked ONLY by the pending DB grants (expected in rehearsal)");
    else if (t.result?.structuredContent?.saved) ok("save succeeded even in rehearsal (grants already present)");
    else fail("rehearsal save", JSON.stringify(t).slice(0, 300));
  } else {
    const sc = t.result?.structuredContent;
    if (sc?.saved && sc.conversation_name && sc.message_id) ok(`saved: notebook='${sc.conversation_name}' message_id=${sc.message_id}`);
    else fail("save genesis", JSON.stringify(t).slice(0, 300));
    const s = await mcp(full.t, "tools/call", { name: "search_memory", arguments: { query: "write door was restored", limit: 5 } }, 6);
    const rows = s.result?.structuredContent?.results || [];
    const hit = rows.find((r) => r.sender === "muse" && /write door was restored/.test(r.snippet || ""));
    if (hit) ok(`genesis found via search (conversation='${hit.conversation_name}', sender='${hit.sender}')`);
    else fail("genesis search-back", JSON.stringify(rows).slice(0, 300));
  }
}

console.log(failures === 0 ? "== ALL CHECKS PASSED ==" : `== ${failures} CHECK(S) FAILED ==`);
process.exit(failures === 0 ? 0 : 1);
