import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { pgliteDb } from "../src/saas/db.ts";
import { loadSaasConfig, type SaasConfig } from "../src/saas/config.ts";
import { createSaasApp } from "../src/saas/app.ts";

const MIG = new URL("../../../migrations/", import.meta.url);
export const sql = (f: string) => readFileSync(new URL(f, MIG), "utf8");

// Matches the live claude_memory base schema (see the root test/migration.test.ts).
export const BASE = `
CREATE ROLE memory_rw; CREATE ROLE memory_ro_hz; CREATE ROLE memory_app NOSUPERUSER NOBYPASSRLS;
CREATE TABLE projects (uuid TEXT PRIMARY KEY, name TEXT, raw JSONB);
CREATE TABLE conversations (uuid TEXT PRIMARY KEY, name TEXT, project_uuid TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, message_count INT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_uuid TEXT, turn_index INT, sender TEXT, text TEXT, created_at TIMESTAMPTZ);
INSERT INTO conversations(uuid,name) VALUES ('c1','Sam archive');
INSERT INTO messages(conversation_uuid,sender,text,created_at) VALUES ('c1','human','sam private archive row', now());
`;

export async function freshDb(opts: { saas?: boolean } = {}) {
  const pg = new PGlite();
  await pg.exec(BASE);
  await pg.exec(sql("001_librarian.sql"));
  await pg.exec(sql("004_flags.sql"));
  if (opts.saas !== false) await pg.exec(sql("005_saas.sql"));
  await pg.exec(sql("006_courier.sql"));
  await pg.exec(sql("008_graph.sql"));
  if (opts.saas !== false) await pg.exec(sql("007_stripe_events_status.sql"));
  if (opts.saas !== false) { await pg.exec(sql("009_plans_personal.sql")); await pg.exec(sql("010_paddle_seats.sql")); await pg.exec(sql("011_recall_quality.sql")); }
  return pg;
}

export async function startSaas(over: Partial<SaasConfig> = {}, deps: Record<string, unknown> = {}) {
  const pg = await freshDb();
  const db = pgliteDb(pg, "memory_app"); // non-superuser: row-level security really applies
  const cfg = loadSaasConfig({ publicUrl: "http://127.0.0.1:0", databaseUrl: "pglite", mail: { provider: "dev", from: null, outboxFile: "/tmp/smm-test-outbox.jsonl" }, stripe: { secretKey: null, webhookSecret: "whsec_test_local_secret_123456789", prices: { personal: "price_personal_test", personalYearly: "price_personal_yearly_test", team: "price_team_test" }, allowLive: false }, ...over });
  // bind first to learn the port, then fix publicUrl (issuer/resource URLs must be exact)
  const { createServer } = await import("node:http");
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  const made = createSaasApp({ db, cfg, ...deps } as never);
  srv.on("request", made.app);
  return { ...made, pg, db, cfg, base: cfg.publicUrl, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

export type Saas = Awaited<ReturnType<typeof startSaas>>;

export async function signIn(s: Saas, email: string): Promise<string> {
  const r = await fetch(`${s.base}/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  if (r.status !== 200) throw new Error(`auth/start ${r.status} ${await r.text()}`);
  const mail = s.mailer.outbox.filter((m) => m.to === email.toLowerCase()).at(-1)!;
  const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  const v = await fetch(`${s.base}/auth/verify`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: s.base }, body: new URLSearchParams({ token }) });
  if (v.status !== 303) throw new Error(`verify ${v.status}`);
  return v.headers.get("set-cookie")!.split(";")[0];
}

/** Put a signed-in account's tenant on a plan (the Stripe webhook does this in production). */
export async function upgrade(s: Saas, cookie: string, plan: "free" | "personal" | "team" = "personal"): Promise<void> {
  const me = await (await fetch(`${s.base}/api/me`, { headers: { Cookie: cookie } })).json() as any;
  await s.pg.query("UPDATE tenants SET plan = $1 WHERE id = $2", [plan, me.tenant.id]);
}

export const api = (s: Saas, cookie: string) => async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${s.base}${path}`, { ...init, headers: { "Content-Type": "application/json", "X-Requested-With": "test", Origin: s.base, Cookie: cookie, ...(init.headers || {}) } });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};

/** Full OAuth dance as an MCP client would do it (DCR + PKCE + consent by the signed-in account). */
export async function connect(s: Saas, cookie: string, mcpUrl: string, opts: { scope?: string; clientName?: string } = {}) {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await fetch(`${s.base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: opts.clientName ?? "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope: opts.scope ?? "memory.read memory.write", state: "st8", resource: mcpUrl });
  const a = await fetch(`${s.base}/authorize?${q}`, { redirect: "manual" });
  if (a.status !== 302) throw new Error(`authorize ${a.status} ${await a.text()}`);
  const consentUrl = new URL(a.headers.get("location")!, s.base);
  const pending = consentUrl.searchParams.get("pending")!;
  const page = await (await fetch(consentUrl, { headers: { Cookie: cookie } })).text();
  const tenantId = page.match(/name="tenant_id" value="([^"]+)"/)?.[1] ?? page.match(/<option value="([^"]+)"/)?.[1];
  const c = await fetch(`${s.base}/consent`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: s.base }, body: new URLSearchParams({ pending_id: pending, tenant_id: tenantId ?? "", action: "approve" }) });
  if (c.status !== 302) throw new Error(`consent ${c.status} ${await c.text()}`);
  const back = new URL(c.headers.get("location")!);
  if (back.searchParams.get("state") !== "st8") throw new Error("state lost");
  const tok = await fetch(`${s.base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: mcpUrl }) });
  const body = await tok.json();
  if (tok.status !== 200) throw new Error(`token ${tok.status} ${JSON.stringify(body)}`);
  return { ...body, client_id: reg.client_id, consentPage: page, redirectUrl: back.toString() };
}

let rpcId = 1;
export async function mcp(url: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body, headers: r.headers };
}

export async function tool(url: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(url, token, "tools/call", { name, arguments: args });
  if (r.status !== 200) throw new Error(`tool ${name} HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const res = r.body.result;
  const text = res?.content?.[0]?.text ?? "";
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { isError: Boolean(res?.isError), data, text };
}
