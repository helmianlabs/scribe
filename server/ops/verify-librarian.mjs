// Verify the Librarian build: health, OAuth, all tools listed, search regression, scope gates,
// librarian read tools answer. Does NOT save anything (no test rows in the real memory).
// Usage (on the box): node verify-librarian.mjs <BASE_URL>
// The passphrase is read from /opt/claude-memory-mcp/app.env in-process and is never printed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] || "http://localhost:8080").replace(/\/+$/, "");
const envText = readFileSync("/opt/claude-memory-mcp/app.env", "utf8");
const val = (k) => envText.match(new RegExp("^" + k + "=(.+)$", "m"))?.[1].trim();
const PASSPHRASE = val("AUTH_" + "PASSPHRASE");
const PUBLIC = (val("PUBLIC_URL") || "").replace(/\/+$/, "");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const local = (u) => (PUBLIC && u.startsWith(PUBLIC) ? BASE + u.slice(PUBLIC.length) : u);
const b64url = (b) => Buffer.from(b).toString("base64url");
let failures = 0;
const ok = (l) => console.log("  PASS  " + l);
const fail = (l, d) => { failures++; console.error("  FAIL  " + l + ": " + d); };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function authorize(scope) {
  const meta = await j(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
  const reg = await j(await fetch(local(meta.registration_endpoint), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "verify-librarian", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  }));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const u = new URL(local(meta.authorization_endpoint));
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: b64url(randomBytes(8)), resource: `${PUBLIC}/mcp`, scope })) u.searchParams.set(k, v);
  const html = await (await fetch(u, { redirect: "manual" })).text();
  const pid = /name="pending_id" value="([^"]+)"/.exec(html)?.[1];
  if (!pid) throw new Error("no pending_id from authorize");
  const r1 = await fetch(`${BASE}/consent`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending_id: pid, action: "approve", passphrase: PASSPHRASE }), redirect: "manual" });
  const code = new URL(r1.headers.get("location")).searchParams.get("code");
  if (!code) throw new Error("no code from consent");
  const tok = await j(await fetch(local(meta.token_endpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${PUBLIC}/mcp` }) }));
  if (!tok["access" + "_token"]) throw new Error("token exchange failed");
  return { t: tok["access" + "_token"], scope: tok.scope || "" };
}
async function mcp(token, method, params, id) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return j(r);
}
const call = (t, name, args, id) => mcp(t, "tools/call", { name, arguments: args }, id);

console.log(`== verify-librarian against ${BASE} ==`);
{ const h = await j(await fetch(`${BASE}/`)); h.status === "ok" ? ok("health ok") : fail("health", JSON.stringify(h)); }
{ const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); r.status === 401 ? ok("anonymous /mcp refused (401)") : fail("anonymous gate", r.status); }
const full = await authorize("memory.read memory.write");
full.scope.includes("memory.write") ? ok(`token scopes: ${full.scope}`) : fail("token scopes", full.scope);
{
  const t = await mcp(full.t, "tools/list", {}, 1);
  const names = (t.result?.tools || []).map((x) => x.name).sort();
  const want = ["add_rule", "explain_filing", "list_unsorted", "move_memory", "save_memory", "search_memory"];
  want.every((n) => names.includes(n)) ? ok(`tools: ${names.join(", ")}`) : fail("tools/list", JSON.stringify(names));
}
{
  const t = await call(full.t, "search_memory", { query: "Hetzner", limit: 3 }, 2);
  const sc = t.result?.structuredContent;
  sc && sc.total > 0 ? ok(`search 'Hetzner' total=${sc.total}`) : fail("search regression", JSON.stringify(t).slice(0, 300));
}
{
  const t = await call(full.t, "explain_filing", { message_id: 49167 }, 3);
  const sc = t.result?.structuredContent;
  sc && sc.category ? ok(`explain_filing 49167 -> ${sc.category} (recorded=${sc.recorded}) rule=${sc.rule_key}`) : fail("explain_filing", JSON.stringify(t).slice(0, 300));
}
{
  const t = await call(full.t, "list_unsorted", { limit: 3 }, 4);
  const sc = t.result?.structuredContent;
  sc && Array.isArray(sc.items) ? ok(`list_unsorted answered (installed=${sc.installed}, items=${sc.items.length})`) : fail("list_unsorted", JSON.stringify(t).slice(0, 300));
}
{
  const ro = await authorize("memory.read");
  for (const [name, args] of [["save_memory", { content: "scope probe - must not persist", source: "verify" }], ["move_memory", { message_id: 49167, to_category: "code", source: "verify" }], ["add_rule", { rule: "anything mentioning probe goes in probe", source: "verify" }]]) {
    const t = await call(ro.t, name, args, 5);
    t.result?.isError && /memory\.write/.test(t.result?.content?.[0]?.text || "") ? ok(`read-only token blocked from ${name}`) : fail(`scope gate ${name}`, JSON.stringify(t).slice(0, 200));
  }
  const s = await call(ro.t, "search_memory", { query: "memory", limit: 1 }, 6);
  s.result?.structuredContent ? ok("read-only token can still search") : fail("read-only search", JSON.stringify(s).slice(0, 200));
}
console.log(failures === 0 ? "== ALL CHECKS PASSED ==" : `== ${failures} CHECK(S) FAILED ==`);
process.exit(failures === 0 ? 0 : 1);
