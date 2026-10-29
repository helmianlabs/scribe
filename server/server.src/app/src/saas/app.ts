/**
 * SaaS mode (MEMORY_MODE=saas): accounts with magic-link sign-in, one tenant per account,
 * per-tenant MCP URL, OAuth consent by the signed-in account, plans + limits, Stripe
 * (test mode), export / delete-all, and the Flags API.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type Stripe from "stripe";
import type { Db } from "./db.js";
import type { SaasConfig } from "./config.js";
import { makeMailer, type Mailer } from "./mailer.js";
import { Accounts, safeReturnTo, type Tenant, type User } from "./accounts.js";
import { SaasOAuth, SCOPES } from "./oauth.js";
import { Billing, BillingError } from "./billing.js";
import { ApiKeys, type ApiKeyAuth } from "./apikeys.js";
import { planFor, LimitError, PLANS, type PlanId } from "./plans.js";
import { buildTenantMcpServer, alertTargetFor } from "./mcp.js";
import { countCall, usage, exportAll, deleteAll } from "./memory.js";
import { importHistory, ImportError, MAX_ZIP_BYTES } from "./importer.js";
import { courierMailboxStatus, unreadSummary, PostOfficeError } from "../courier/store.js";
import { listFlags } from "../flags/store.js";
import { recordFlags, findingsToFlags } from "../flags/service.js";
import { scanText, SEVERITIES, type Severity } from "../flags/scanner.js";
import { signInPage, verifyPage, messagePage, consentPage, dashboardPage, mockBillingPage, gettingStartedPage, DASHBOARD_JS } from "./pages.js";

const COOKIE = "smm_session";

export interface SaasDeps { db: Db; cfg: SaasConfig; mailer?: Mailer; stripe?: Stripe; }

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Tiny fixed-window limiter (per process) for unauthenticated endpoints. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "?";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) { res.status(429).json({ error: "Too many requests. Try again later." }); return; }
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

export function createSaasApp(deps: SaasDeps) {
  const { db, cfg } = deps;
  const mailer = deps.mailer ?? makeMailer(cfg);
  const accounts = new Accounts(db, cfg, mailer);
  const oauth = new SaasOAuth(db, cfg.publicUrl);
  const billing = new Billing(db, cfg, accounts, deps.stripe);
  const keys = new ApiKeys(db);
  const origin = new URL(cfg.publicUrl).origin;
  const genericResource = new URL(`${cfg.publicUrl}/mcp`);
  const mcpUrlFor = (t: Tenant) => `${cfg.publicUrl}/t/${t.slug}/mcp`;
  const planOf = (t: Tenant) => planFor(t.plan, cfg.limitsOverride as never);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });

  // ---------------------------------------------------------------- Stripe webhook (raw body, before JSON parsing)
  app.post("/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    try {
      const out = await billing.handleWebhook(req.body as Buffer, req.header("stripe-signature") ?? undefined);
      res.status(out.status).json(out.body);
    } catch (e) {
      console.error("stripe webhook error:", (e as Error).message);
      res.status(500).json({ error: "Webhook processing failed." });
    }
  });

  // ---------------------------------------------------------------- helpers
  const setSession = (res: Response, token: string) =>
    res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionTtlDays * 86400}${cfg.cookieSecure ? "; Secure" : ""}`);
  const clearSession = (res: Response) => res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure ? "; Secure" : ""}`);
  const sessionUser = (req: Request) => accounts.userForSession(cookies(req)[COOKIE]);
  const sameOrigin = (req: Request) => { const o = req.header("origin"); return !o || o === origin; };
  const html = (res: Response, status: number, body: string) => res.status(status).set("Content-Type", "text/html; charset=utf-8").send(body);
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      if (e instanceof LimitError) { res.status(402).json({ error: e.message, limit: e.kind }); return; }
      if (e instanceof BillingError) { res.status(e.status).json({ error: e.message }); return; }
      console.error("request error:", (e as Error).message);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong." });
    });
  };

  // ---------------------------------------------------------------- public pages + sign-in
  app.get("/", (_req, res) => res.json({ name: "helmian-scribe", product: "Helmian Scribe", mode: "saas", status: "ok", sign_in: `${cfg.publicUrl}/login` }));
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));
  app.get("/login", (req, res) => html(res, 200, signInPage({ returnTo: safeReturnTo(req.query.return_to) })));
  app.post("/auth/start", limiter(20, 60 * 60 * 1000), express.urlencoded({ extended: false }), express.json(), wrap(async (req, res) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: "Bad origin." }); return; }
    const email = String(req.body?.email || "");
    const returnTo = safeReturnTo(req.body?.return_to);
    const r = await accounts.startMagicLink(email, returnTo);
    const wantsJson = (req.header("content-type") || "").includes("json");
    if (wantsJson) { res.status(r.ok ? 200 : 400).json(r.ok ? { sent: true } : { error: r.error }); return; }
    html(res, r.ok ? 200 : 400, r.ok ? signInPage({ sent: email.trim().toLowerCase() }) : signInPage({ returnTo, error: r.error }));
  }));
  app.get("/auth/verify", (req, res) => html(res, 200, verifyPage(String(req.query.token || ""))));
  app.post("/auth/verify", limiter(60, 60 * 60 * 1000), express.urlencoded({ extended: false }), wrap(async (req, res) => {
    if (!sameOrigin(req)) { res.status(403).send("Bad origin."); return; }
    const out = await accounts.consumeMagicLink(String(req.body?.token || ""));
    if (!out) { html(res, 400, messagePage("Link expired", "That sign-in link has expired or was already used. Request a new one.")); return; }
    setSession(res, out.sessionToken);
    res.redirect(303, out.returnTo || "/dashboard");
  }));
  app.get("/logout", wrap(async (req, res) => { await accounts.endSession(cookies(req)[COOKIE]); clearSession(res); res.redirect(303, "/login"); }));
  app.get("/dashboard", (_req, res) => html(res, 200, dashboardPage()));
  app.get("/getting-started", (_req, res) => html(res, 200, gettingStartedPage()));
  app.get("/static/dashboard.js", (_req, res) => res.set("Content-Type", "text/javascript; charset=utf-8").send(DASHBOARD_JS));
  app.get("/billing/mock", (_req, res) => html(res, 200, mockBillingPage()));

  // ---------------------------------------------------------------- OAuth (AS) + consent by signed-in account
  // Custom discovery documents (registered BEFORE the SDK router below so
  // Express matches these first — the same strict-document approach the
  // self-host surface uses in single.ts). The SDK router builds its metadata
  // from URL objects, whose .href for an origin always ends in "/", and omits
  // jwks_uri and the iss advertisement; strict validators (Google's Gemini
  // app checker rejected exactly those documents on the box) canonicalize the
  // issuer WITHOUT the slash. Here every value is a string built from
  // cfg.publicUrl, which config.ts guarantees is the exact slash-less origin —
  // so the documents, the `iss` the OAuth provider puts on authorize
  // redirects (oauth.ts), and the WWW-Authenticate pointers all agree.
  // Access tokens are opaque (validated against the server-side store), so
  // the JWKS is empty; the field exists because OIDC-bred validators
  // require it.
  const AS_METADATA = {
    issuer: cfg.publicUrl,
    authorization_endpoint: `${cfg.publicUrl}/authorize`,
    token_endpoint: `${cfg.publicUrl}/token`,
    registration_endpoint: `${cfg.publicUrl}/register`,
    revocation_endpoint: `${cfg.publicUrl}/revoke`,
    jwks_uri: `${cfg.publicUrl}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/"], (_req, res) => {
    res.status(200).json(AS_METADATA);
  });
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.status(200).json(AS_METADATA);
  });
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.status(200).json({ keys: [] });
  });
  const PR_METADATA = {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.publicUrl],
    scopes_supported: SCOPES,
    resource_name: "Helmian Scribe",
    bearer_methods_supported: ["header"],
  };
  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/mcp/",
    ],
    (_req, res) => {
      res.status(200).json(PR_METADATA);
    }
  );

  app.use(mcpAuthRouter({
    provider: oauth,
    issuerUrl: new URL(cfg.publicUrl),
    baseUrl: new URL(cfg.publicUrl),
    resourceServerUrl: genericResource,
    resourceName: "Helmian Scribe",
    scopesSupported: SCOPES,
  }));
  app.get(/^\/\.well-known\/oauth-protected-resource\/t\/([a-z0-9]{4,40})\/mcp$/, wrap(async (req, res) => {
    const slug = (req.params as unknown as string[])[0];
    const t = await accounts.tenantBySlug(slug);
    if (!t) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ resource: mcpUrlFor(t), authorization_servers: [cfg.publicUrl], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: "Helmian Scribe" });
  }));

  async function renderConsent(req: Request, res: Response, pendingId: string, error?: string) {
    const p = await oauth.getPending(pendingId);
    if (!p) { html(res, 400, messagePage("Request expired", "This connection request expired. Start again from your AI app.")); return; }
    const user = await sessionUser(req);
    if (!user) { html(res, 200, signInPage({ returnTo: `/consent?pending=${encodeURIComponent(pendingId)}` })); return; }
    const ms = await accounts.memberships(user.id);
    let fixed: Tenant | null = null;
    if (p.tenant_slug) {
      fixed = ms.find((m) => m.tenant.slug === p.tenant_slug)?.tenant ?? null;
      if (!fixed) { html(res, 403, messagePage("Not your memory", `You're signed in as ${user.email}, which doesn't have access to this memory address. Sign out and use the right account.`)); return; }
    }
    html(res, error ? 400 : 200, consentPage({ pendingId, clientName: await oauth.clientName(p.client_id), email: user.email, tenants: ms.map((m) => m.tenant), fixedTenant: fixed, scopes: p.scopes, error }));
  }
  app.get("/consent", wrap(async (req, res) => renderConsent(req, res, String(req.query.pending || ""))));
  app.post("/consent", express.urlencoded({ extended: false }), wrap(async (req, res) => {
    if (!sameOrigin(req)) { res.status(403).send("Bad origin."); return; }
    const pendingId = String(req.body?.pending_id || "");
    if (req.body?.action === "deny") { const u = await oauth.deny(pendingId); if (u) res.redirect(302, u); else html(res, 400, messagePage("Request expired", "Start again from your AI app.")); return; }
    const user = await sessionUser(req);
    if (!user) { html(res, 401, signInPage({ returnTo: `/consent?pending=${encodeURIComponent(pendingId)}` })); return; }
    const p = await oauth.getPending(pendingId);
    if (!p) { html(res, 400, messagePage("Request expired", "Start again from your AI app.")); return; }
    const m = await accounts.membership(user.id, String(req.body?.tenant_id || ""));
    if (!m || (p.tenant_slug && m.tenant.slug !== p.tenant_slug)) { await renderConsent(req, res, pendingId, "Pick a memory this account belongs to."); return; }
    const url = await oauth.approve(pendingId, m.tenant.id, user.id);
    if (!url) { html(res, 400, messagePage("Request expired", "Start again from your AI app.")); return; }
    res.redirect(302, url);
  }));

  // ---------------------------------------------------------------- MCP endpoints
  async function mcpAuth(req: Request, res: Response, slug: string | null): Promise<{ auth: AuthInfo; tenant: Tenant } | null> {
    const resourceUrl = slug ? `${cfg.publicUrl}/t/${slug}/mcp` : genericResource.toString();
    const meta = slug ? `${cfg.publicUrl}/.well-known/oauth-protected-resource/t/${slug}/mcp` : `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`;
    const deny = (status: number, err: string, desc: string) => {
      res.set("WWW-Authenticate", `Bearer error="${err}", error_description="${desc}", resource_metadata="${meta}"`);
      res.status(status).json({ error: err, error_description: desc });
      return null;
    };
    const h = req.header("authorization") || "";
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (!m) return deny(401, "invalid_token", "Missing bearer token");
    let auth: AuthInfo;
    try { auth = await oauth.verifyAccessToken(m[1]); } catch { return deny(401, "invalid_token", "Invalid or expired token"); }
    const tenantId = String(auth.extra?.tenantId || "");
    const tenant = await accounts.tenantById(tenantId);
    if (!tenant) return deny(401, "invalid_token", "Account no longer exists");
    if (slug && tenant.slug !== slug) return deny(403, "insufficient_scope", "This token belongs to a different memory");
    if (auth.resource && slug && auth.resource.toString() !== resourceUrl) return deny(403, "insufficient_scope", "Token was issued for a different resource");
    return { auth, tenant };
  }

  const handleMcp = (slugOf: (req: Request) => string | null) => wrap(async (req, res) => {
    const ok = await mcpAuth(req, res, slugOf(req));
    if (!ok) return;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildTenantMcpServer({ db, tenant: ok.tenant, scopes: ok.auth.scopes, publicUrl: cfg.publicUrl, limitsOverride: cfg.limitsOverride as never, clientId: ok.auth.clientId, clientName: await oauth.clientName(ok.auth.clientId) });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // Capability log (ported from the self-host build): on an initialize
    // request, log the client's declared capabilities — structure only, no
    // tokens, no user data. Fully guarded; logging must never break a call.
    try {
      const body = req.body as { method?: unknown } | Array<{ method?: unknown }> | undefined;
      const isInitialize = Array.isArray(body) ? body.some((m) => m?.method === "initialize") : body?.method === "initialize";
      if (isInitialize) {
        const caps = server.server.getClientCapabilities();
        const client = server.server.getClientVersion();
        const rec = (caps ?? {}) as Record<string, unknown>;
        const known = ["sampling", "elicitation", "roots", "logging", "prompts", "resources", "tools"];
        const presence = known.map((k) => `${k}=${rec[k] !== undefined}`).join(" ");
        const experimental = caps?.experimental ? Object.keys(caps.experimental).join(",") : "";
        console.log(`[mcp] initialize client=${client?.name ?? "unknown"} version=${client?.version ?? "unknown"} capabilities: ${presence} experimental=[${experimental}]`);
      }
    } catch { /* logging only — swallow */ }
  });
  const tenantSlug = (req: Request) => String(req.params.slug || "");
  app.post("/t/:slug/mcp", express.json({ limit: "1mb" }), handleMcp(tenantSlug));
  app.post("/mcp", express.json({ limit: "1mb" }), handleMcp(() => null));
  for (const path of ["/t/:slug/mcp", "/mcp"]) {
    app.get(path, wrap(async (req, res) => { if (await mcpAuth(req, res, req.params.slug ? String(req.params.slug) : null)) res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST for MCP requests." }, id: null }); }));
    app.delete(path, (_req, res) => res.status(405).end());
  }

  // ---------------------------------------------------------------- Mailbox status (SaaS, tenant-scoped)
  // The SaaS counterpart of the self-host doorbell feed. Unlike self-host mode,
  // there is no shared status token and no tenant input: an MCP OAuth token
  // (memory.read) or a service API key (mailbox.read) is verified first, and
  // the tenant bound to that credential is the only tenant queried.
  async function mailboxTenant(req: Request, res: Response): Promise<Tenant | null> {
    const deny = (status: number, error: string, description: string) => {
      res.set("WWW-Authenticate", `Bearer error="${error}", error_description="${description}"`);
      res.status(status).json({ error, error_description: description });
      return null;
    };
    const m = (req.header("authorization") || "").match(/^Bearer\s+(\S+)$/i);
    if (!m) return deny(401, "invalid_token", "Missing bearer token");
    const token = m[1];
    if (token.startsWith("smk_")) {
      const key = await keys.verify(token);
      if (!key || !key.scopes.includes("mailbox.read")) return deny(401, "invalid_token", "Invalid API key or missing mailbox.read scope");
      const tenant = await accounts.tenantById(key.tenantId);
      return tenant ?? deny(401, "invalid_token", "Account no longer exists");
    }
    let auth: AuthInfo;
    try { auth = await oauth.verifyAccessToken(token); } catch { return deny(401, "invalid_token", "Invalid or expired token"); }
    if (!auth.scopes.includes("memory.read")) return deny(403, "insufficient_scope", "Mailbox status requires the memory.read scope");
    const tenant = await accounts.tenantById(String(auth.extra?.tenantId || ""));
    return tenant ?? deny(401, "invalid_token", "Account no longer exists");
  }

  app.get("/mailbox-status", wrap(async (req, res) => {
    const tenant = await mailboxTenant(req, res);
    if (!tenant) return;
    const mailboxes = await db.tenant(tenant.id, (q) => courierMailboxStatus(q, tenant.id));
    res.json({ generated_at: new Date().toISOString(), mailboxes });
  }));

  // Door-knock poll for one mailbox (Guard extension, every 60-120 s). No bodies.
  app.get("/mailbox/unread", wrap(async (req, res) => {
    const tenant = await mailboxTenant(req, res);
    if (!tenant) return;
    const agent = String(req.query.agent ?? "");
    const since = Number(req.query.since_id ?? 0);
    try {
      const out = await db.tenant(tenant.id, (q) => unreadSummary(q, tenant.id, agent, Number.isFinite(since) ? since : 0));
      res.set("Cache-Control", "no-store");
      res.json({ generated_at: new Date().toISOString(), poll_after_seconds: 60, ...out });
    } catch (e) {
      if (e instanceof PostOfficeError) { res.status(400).json({ error: "bad_request", error_description: e.message }); return; }
      throw e;
    }
  }));

  // ---------------------------------------------------------------- JSON API (session cookie, or API key for /api/flags*)
  interface Caller { user: User | null; key: ApiKeyAuth | null; tenant: Tenant; role: string; }
  async function caller(req: Request, res: Response, opts: { allowKeyScope?: "flags.read" | "flags.write"; ownerOnly?: boolean } = {}): Promise<Caller | null> {
    const bearer = (req.header("authorization") || "").match(/^Bearer\s+(smk_\S+)$/)?.[1];
    if (bearer) {
      const k = opts.allowKeyScope ? await keys.verify(bearer) : null;
      if (!k || !k.scopes.includes(opts.allowKeyScope!)) { res.status(401).json({ error: "Invalid API key or missing scope." }); return null; }
      const t = await accounts.tenantById(k.tenantId);
      if (!t) { res.status(401).json({ error: "Account no longer exists." }); return null; }
      return { user: null, key: k, tenant: t, role: "service" };
    }
    const user = await sessionUser(req);
    if (!user) { res.status(401).json({ error: "Sign in first." }); return null; }
    if (req.method !== "GET" && (!sameOrigin(req) || !req.header("x-requested-with"))) { res.status(403).json({ error: "Cross-site request refused." }); return null; }
    const ms = await accounts.memberships(user.id);
    const want = req.header("x-tenant-id");
    const m = want ? ms.find((x) => x.tenant.id === want) : ms[0];
    if (!m) { res.status(403).json({ error: "No access to that memory." }); return null; }
    if (opts.ownerOnly && m.role !== "owner" && m.role !== "admin") { res.status(403).json({ error: "Only the owner can do that." }); return null; }
    return { user, key: null, tenant: m.tenant, role: m.role };
  }

  const api = express.Router();
  api.use(express.json({ limit: "256kb" }));

  api.get("/me", wrap(async (req, res) => {
    const c = await caller(req, res); if (!c) return;
    const plan = planOf(c.tenant);
    const u = await db.tenant(c.tenant.id, (q) => usage(q, c.tenant.id));
    const { stripe_customer_id: _a, stripe_subscription_id: _b, ...tenant } = c.tenant;
    res.json({ user: c.user, tenant, role: c.role, plan, plans: PLANS, usage: u, mcp_url: mcpUrlFor(c.tenant), billing_mode: billing.mode });
  }));

  api.post("/billing/checkout", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    const plan = String(req.body?.plan || "") as PlanId;
    res.json(await billing.checkout(c.tenant, plan, c.user!.email));
  }));
  api.post("/billing/portal", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    res.json(await billing.portal(c.tenant));
  }));

  api.get("/export", wrap(async (req, res) => {
    const c = await caller(req, res); if (!c) return;
    const data = await db.tenant(c.tenant.id, (q) => exportAll(q, c.tenant.id));
    res.set("Content-Disposition", `attachment; filename="helmian-scribe-export-${c.tenant.slug}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  }));
  api.post("/delete-all", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    if (req.body?.confirm !== "DELETE") { res.status(400).json({ error: 'Send {"confirm":"DELETE"} to delete every memory.' }); return; }
    const deleted = await db.tenant(c.tenant.id, (q) => deleteAll(q, c.tenant.id));
    if (req.body?.revoke_connections) await oauth.revokeTenant(c.tenant.id);
    res.json({ deleted });
  }));

  api.post("/alerts", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    try { await accounts.updateAlerts(c.tenant.id, req.body ?? {}); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    res.json({ saved: true });
  }));
  api.post("/librarian/preset", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    try { await accounts.setPreset(c.tenant.id, String(req.body?.preset || ""), c.user!.email); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    res.json({ saved: true });
  }));

  api.get("/keys", wrap(async (req, res) => { const c = await caller(req, res); if (!c) return; res.json({ keys: await keys.list(c.tenant.id) }); }));
  api.post("/keys", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    const k = await keys.create(c.tenant.id, planOf(c.tenant), String(req.body?.name || ""), Array.isArray(req.body?.scopes) ? req.body.scopes : [], c.user!.email);
    res.status(201).json(k);
  }));
  api.delete("/keys/:id", wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    res.json({ revoked: await keys.revoke(c.tenant.id, String(req.params.id)) });
  }));

  // ------------------------------ Flags API (see docs/FLAGS_API.md)
  const meter = (c: Caller) => db.tenant(c.tenant.id, (q) => countCall(q, c.tenant.id, planOf(c.tenant)));
  api.get("/flags", wrap(async (req, res) => {
    const c = await caller(req, res, { allowKeyScope: "flags.read" }); if (!c) return;
    if (c.key) await meter(c);
    const sev = SEVERITIES.includes(req.query.min_severity as Severity) ? (req.query.min_severity as Severity) : undefined;
    const out = await db.tenant(c.tenant.id, (q) => listFlags(q, c.tenant.id, {
      min_severity: sev, category: typeof req.query.category === "string" ? req.query.category : undefined,
      since: typeof req.query.since === "string" && !isNaN(Date.parse(req.query.since)) ? req.query.since : undefined,
      limit: Number(req.query.limit) || 50,
    }));
    res.json(out);
  }));
  api.post("/flags", wrap(async (req, res) => {
    const c = await caller(req, res, { allowKeyScope: "flags.write" }); if (!c) return;
    await meter(c);
    const b = req.body ?? {};
    const severity = b.severity as Severity;
    const categories = ["secret", "pii", "harmful_code", "hedging", "privacy", "moderation", "other"];
    if (!SEVERITIES.includes(severity) || !categories.includes(b.category) || typeof b.reason !== "string" || b.reason.length < 3 || b.reason.length > 1000) {
      res.status(400).json({ error: "Need severity (low|medium|high|critical), category (" + categories.join("|") + ") and reason (3-1000 chars)." }); return;
    }
    const scan = typeof b.excerpt === "string" ? scanText(b.excerpt.slice(0, 5000)) : null;
    const ctx: Record<string, unknown> = {};
    if (typeof b.url === "string") ctx.url = b.url.slice(0, 500);
    if (b.context && typeof b.context === "object") ctx.extra = b.context;
    const reporter = c.key ? `key:${c.key.name}` : c.user!.email;
    const out = await db.tenant(c.tenant.id, (q) => recordFlags(q, c.tenant.id, [
      { severity, category: b.category, rule: typeof b.rule === "string" ? b.rule.slice(0, 80) : null, origin: "api", source_ai: typeof b.source_ai === "string" ? b.source_ai : null, reporter: typeof b.reporter === "string" ? `${reporter} (${b.reporter.slice(0, 40)})` : reporter, reason: b.reason, excerpt: scan?.redacted ?? null, context: ctx },
      ...(scan ? findingsToFlags(scan.findings.filter((f) => f.category !== "hedging"), { source_ai: b.source_ai ?? null, reporter: "server", excerpt: scan.redacted }) : []),
    ], alertTargetFor(c.tenant, cfg.publicUrl)));
    res.status(201).json({ flags: out.flags, redactions: scan?.redactions ?? 0, alert: out.alert });
  }));
  api.post("/flags/scan", wrap(async (req, res) => {
    const c = await caller(req, res, { allowKeyScope: "flags.read" }); if (!c) return;
    await meter(c);
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 50000) : "";
    const s = scanText(text);
    res.json({ redacted: s.redacted, redactions: s.redactions, findings: s.findings.map(({ start: _s, end: _e, ...f }) => f) });
  }));

  // ---------------------------------------------------------------- History import (raw ZIP body)
  // Registered on the app (not the JSON api router) so the body stays raw
  // bytes. Auth is the same session-cookie caller as the rest of /api, owner
  // only; the tenant comes from the session, never from the upload.
  app.post("/api/import", express.raw({ type: () => true, limit: Math.ceil(MAX_ZIP_BYTES * 1.05) }), wrap(async (req, res) => {
    const c = await caller(req, res, { ownerOnly: true }); if (!c) return;
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Upload your Claude or ChatGPT export .zip as the request body." }); return;
    }
    await db.tenant(c.tenant.id, (q) => countCall(q, c.tenant.id, planOf(c.tenant)));
    try {
      const out = await importHistory(db, c.tenant, planOf(c.tenant), body, alertTargetFor(c.tenant, cfg.publicUrl));
      res.json(out);
    } catch (e) {
      if (e instanceof ImportError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
  }));

  app.use("/api", api);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return { app, mailer, accounts, oauth, billing, keys };
}
