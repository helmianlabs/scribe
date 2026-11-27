// proof-graphfix.mjs — post-deploy proof for ONE memory server, through its own OAuth door
// machinery (same flow as verify-librarian.mjs, parameterised by env file).
// Plants one novel labelled value under the namespaced source "graph-fix-proof", confirms
// search_memory finds the plant (control: the save landed), then requires graph_neighbors
// to answer the planted value AND its label's has_value link.
//
//   node proof-graphfix.mjs <BASE_URL> <ENV_FILE> <LABEL> <PORT_VALUE>
//
// BASE_URL is the server's own base (local port on the box, or its public door host —
// the OAuth endpoints are rewritten to BASE exactly like verify-librarian.mjs does).
// The passphrase is read from ENV_FILE in-process and never printed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const [BASE0, ENV_FILE, LABEL, PORT_VALUE] = process.argv.slice(2);
if (!BASE0 || !ENV_FILE || !LABEL || !PORT_VALUE) {
  console.error("usage: node proof-graphfix.mjs <BASE_URL> <ENV_FILE> <LABEL> <PORT_VALUE>");
  process.exit(2);
}
const BASE = BASE0.replace(/\/+$/, "");
const envText = readFileSync(ENV_FILE, "utf8");
const val = (k) => envText.match(new RegExp("^" + k + "=(.+)$", "m"))?.[1].trim();
const PASSPHRASE = val("AUTH_" + "PASSPHRASE");
const PUBLIC = (val("PUBLIC_URL") || "").replace(/\/+$/, "");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const local = (u) => (PUBLIC && u.startsWith(PUBLIC) ? BASE + u.slice(PUBLIC.length) : u);
const b64url = (b) => Buffer.from(b).toString("base64url");
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function authorize(scope) {
  const meta = await j(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
  const reg = await j(await fetch(local(meta.registration_endpoint), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "graph-fix-proof", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
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
  return tok["access" + "_token"];
}

let failures = 0;
const ok = (l) => console.log("  PASS  " + l);
const fail = (l, d) => { failures++; console.error("  FAIL  " + l + ": " + d); };

const VALUE = `ep-gfproof-${LABEL}-${randomBytes(3).toString("hex")}`;
const token = await authorize("memory.read memory.write");
const mcp = async (method, params, id) => j(await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
const call = (name, args, id) => mcp("tools/call", { name, arguments: args }, id);
const textOf = (t) => JSON.stringify(t?.result ?? t ?? "");

console.log(`== graph-fix proof against ${BASE} (label ${LABEL}) ==`);
const plant = `Graph fix deploy proof. The graph proof endpoint id is ${VALUE}. GRAPHFIX_PROOF_PORT = '${PORT_VALUE}'.`;
const saved = await call("save_memory", { content: plant, source: "graph-fix-proof" }, 1);
saved.result && !saved.result.isError ? ok("plant saved under source graph-fix-proof") : fail("plant save", textOf(saved).slice(0, 300));

const found = await call("search_memory", { query: VALUE, limit: 3 }, 2);
textOf(found).includes(VALUE) ? ok("control: search_memory finds the plant") : fail("control search", textOf(found).slice(0, 300));

const byValue = await call("graph_neighbors", { entity: VALUE }, 3);
textOf(byValue).includes(VALUE) ? ok(`graph_neighbors(${VALUE}) answers the planted value`) : fail("graph by value", textOf(byValue).slice(0, 300));

const byLabel = await call("graph_neighbors", { entity: "GRAPHFIX_PROOF_PORT" }, 4);
textOf(byLabel).includes(PORT_VALUE) ? ok(`graph_neighbors(GRAPHFIX_PROOF_PORT) answers ${PORT_VALUE} via has_value`) : fail("graph by label", textOf(byLabel).slice(0, 300));

console.log(failures === 0 ? "PROOF PASSED" : `PROOF FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
