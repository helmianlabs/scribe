/**
 * Entry point: an Express app that is simultaneously
 *   (a) an OAuth 2.1 authorization server with Dynamic Client Registration, and
 *   (b) an MCP resource server exposing `search_memory` over Streamable HTTP.
 *
 * Flow when Claude.ai adds this connector:
 *   1. Claude POSTs to /mcp with no token -> 401 + WWW-Authenticate pointing at
 *      /.well-known/oauth-protected-resource (served by mcpAuthRouter).
 *   2. Claude reads protected-resource metadata -> finds this server as its AS.
 *   3. Claude GETs /.well-known/oauth-authorization-server -> endpoint URLs.
 *   4. Claude POSTs /register (DCR) -> gets a client_id.
 *   5. Claude opens /authorize (PKCE) -> we render the passphrase consent page.
 *   6. Sam enters the passphrase -> POST /consent -> redirect to Claude with code.
 *   7. Claude POSTs /token (code + verifier) -> access + refresh tokens.
 *   8. Claude POSTs /mcp with Bearer token -> tool calls succeed.
 */
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { PUBLIC_URL, MCP_PATH, PORT, AUTH_PASSPHRASE } from "./config.js";
import { provider, adoptClient, approveAuthorization, denyAuthorization, getPending } from "./oauth-provider.js";
import { renderConsentPage } from "./consent.js";
import { buildMcpServer } from "./mcp-server.js";
import { mailboxStatus } from "./db.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const ISSUER = new URL(PUBLIC_URL);
const RESOURCE_URL = new URL(`${PUBLIC_URL}${MCP_PATH}`);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(RESOURCE_URL);

// ---------------------------------------------------------------------------
// Health check (no auth)
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.status(200).json({
    name: "helmian-scribe",
    status: "ok",
    mcp_endpoint: `${PUBLIC_URL}${MCP_PATH}`,
    transport: "streamable-http",
    auth: "oauth2.1+pkce+dcr",
  });
});
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------------------------------------------------------------------------
// Mailbox status feed (the Guard doorbell's data source). Deliberately
// OUTSIDE the MCP/OAuth machinery: a single static bearer token from the
// environment (MAILBOX_STATUS_TOKEN) gates it, so a browser extension can
// poll it without an OAuth dance. Counts and subjects only — never bodies.
// Feature is OFF (route 404s) unless the env var is set and non-empty.
// Self-host surface only: SaaS mode does not register this route (per-tenant
// mailbox scoping is a separate bite — see the B2 port report).
// ---------------------------------------------------------------------------
app.get("/mailbox-status", async (req, res) => {
  const expected = process.env.MAILBOX_STATUS_TOKEN;
  if (!expected) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  if (!presented || !constantTimeEquals(presented, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const entries = await mailboxStatus();
    res.status(200).json({
      generated_at: new Date().toISOString(),
      mailboxes: entries
        .filter((e) => e.count > 0)
        .map((e) => ({ tag: e.tag, count: e.count, newest: e.newest })),
    });
  } catch {
    res.status(500).json({ error: "mailbox status unavailable" });
  }
});

// ---------------------------------------------------------------------------
// OAuth authorization server + protected-resource metadata + DCR.
// mcpAuthRouter installs:
//   GET  /.well-known/oauth-authorization-server
//   GET  /.well-known/oauth-protected-resource   (because resourceServerUrl is set)
//   GET  /authorize    -> provider.authorize() renders the consent page
//   POST /token        -> code/refresh exchange (PKCE validated by SDK)
//   POST /register     -> Dynamic Client Registration (RFC 7591)
//   POST /revoke       -> token revocation
// ---------------------------------------------------------------------------
app.use("/authorize", (req, _res, next) => {
  const cid = typeof req.query.client_id === "string" ? req.query.client_id : "";
  const ru = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
  if (cid && ru) adoptClient(cid, ru);
  next();
});

// ---------------------------------------------------------------------------
// Custom discovery documents (override the SDK router's defaults, which are
// registered below; Express matches these first). Two strictness fixes for
// validators like Google's Gemini app checker, which rejected the SDK's
// documents while Claude and Mistral accepted them:
//   1. issuer WITHOUT a trailing slash. The SDK emits new URL(origin).href,
//      which always ends in "/"; strict RFC 8414 validators canonicalize the
//      issuer without it. Both documents below use the same issuer string so
//      discovery is consistent from every entry point.
//   2. a jwks_uri. Access tokens here are opaque (validated against the
//      server-side store), so the key set is empty; OIDC-bred validators
//      require the field to exist.
// ---------------------------------------------------------------------------
const ISSUER_STR = PUBLIC_URL; // config.ts guarantees: no trailing slash
const AS_METADATA = {
  issuer: ISSUER_STR,
  authorization_endpoint: PUBLIC_URL + "/authorize",
  token_endpoint: PUBLIC_URL + "/token",
  registration_endpoint: PUBLIC_URL + "/register",
  revocation_endpoint: PUBLIC_URL + "/revoke",
  jwks_uri: PUBLIC_URL + "/.well-known/jwks.json",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  scopes_supported: ["memory.read", "memory.write"],
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
  resource: RESOURCE_URL.toString(),
  authorization_servers: [ISSUER_STR],
  scopes_supported: ["memory.read", "memory.write"],
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

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: ISSUER,
    baseUrl: ISSUER,
    resourceServerUrl: RESOURCE_URL,
    resourceName: "Helmian Scribe",
    scopesSupported: ["memory.read", "memory.write"],
  })
);

// ---------------------------------------------------------------------------
// Consent POST handler: validate the passphrase, then redirect back to client.
// (urlencoded form body from the consent page.)
// ---------------------------------------------------------------------------
app.post("/consent", express.urlencoded({ extended: false }), (req, res) => {
  const pendingId = String(req.body.pending_id || "");
  const action = String(req.body.action || "");
  const passphrase = String(req.body.passphrase || "");

  const pending = getPending(pendingId);
  if (!pending) {
    res.status(400).send("This authorization request has expired or is invalid. Please retry from Claude.ai.");
    return;
  }

  if (action === "deny") {
    const url = denyAuthorization(pendingId);
    if (!url) {
      res.status(400).send("Invalid request.");
      return;
    }
    res.redirect(302, url);
    return;
  }

  // Approve path: constant-time-ish passphrase check.
  if (!constantTimeEquals(passphrase, AUTH_PASSPHRASE)) {
    res
      .status(401)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(
        renderConsentPage({
          pendingId,
          clientName: resolveClientName(pending.clientId),
          error: "Incorrect passphrase. Please try again.",
          scopes: pending.scopes,
        })
      );
    return;
  }

  const redirectUrl = approveAuthorization(pendingId);
  if (!redirectUrl) {
    res.status(400).send("This authorization request has expired. Please retry from Claude.ai.");
    return;
  }
  res.redirect(302, redirectUrl);
});

function resolveClientName(clientId: string): string {
  const c = provider.clientsStore.getClient(clientId);
  // getClient may be async in general, but ours is sync.
  if (c && typeof (c as { then?: unknown }).then !== "function") {
    return (c as { client_name?: string; client_id: string }).client_name || clientId;
  }
  return clientId;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The protected MCP endpoint. requireBearerAuth validates the access token via
// provider.verifyAccessToken and emits a spec-compliant 401 + WWW-Authenticate
// (with the resource_metadata URL) when the token is missing/invalid.
// ---------------------------------------------------------------------------
const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl,
});

app.post(MCP_PATH, bearer, express.json(), async (req, res) => {
  // Stateless: a fresh transport + server per request (no session reuse).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const auth = (req as unknown as { auth?: AuthInfo }).auth;
  const server = buildMcpServer(auth?.scopes ?? [], { clientId: auth?.clientId ?? null, clientName: auth?.clientId ? resolveClientName(auth.clientId) : null });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // Capability log: on an initialize request, this same server instance has
    // now recorded the client's declared capabilities (the low-level Server
    // stores them while handling initialize, before it replies). One line,
    // structure only — no tokens, no user data. Logging must never break a
    // connection, so it is fully guarded. (server.server.oninitialized is not
    // used: in this stateless per-request setup the initialized notification
    // arrives on a different instance that never saw the initialize.)
    try {
      const body = req.body as
        | { method?: unknown }
        | Array<{ method?: unknown }>
        | undefined;
      const isInitialize = Array.isArray(body)
        ? body.some((m) => m?.method === "initialize")
        : body?.method === "initialize";
      if (isInitialize) {
        const caps = server.server.getClientCapabilities();
        const client = server.server.getClientVersion();
        const rec = (caps ?? {}) as Record<string, unknown>;
        const known = [
          "sampling",
          "elicitation",
          "roots",
          "logging",
          "prompts",
          "resources",
          "tools",
        ];
        const presence = known
          .map((k) => `${k}=${rec[k] !== undefined}`)
          .join(" ");
        const experimental = caps?.experimental
          ? Object.keys(caps.experimental).join(",")
          : "";
        console.log(
          `[mcp] initialize client=${client?.name ?? "unknown"} version=${client?.version ?? "unknown"} capabilities: ${presence} experimental=[${experimental}]`
        );
      }
    } catch {
      /* logging only — swallow */
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Some clients probe GET/DELETE on the MCP path; respond 405 (we are stateless).
app.get(MCP_PATH, bearer, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST for MCP requests." },
    id: null,
  });
});
app.head(MCP_PATH, (_req, res) => {
  res.set("Allow", "POST").status(405).end();
});
app.delete(MCP_PATH, bearer, (_req, res) => res.status(405).end());

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `helmian-scribe (self-host) listening on :${PORT}\n` +
      `  public:   ${PUBLIC_URL}\n` +
      `  mcp:      ${PUBLIC_URL}${MCP_PATH}\n` +
      `  as-meta:  ${PUBLIC_URL}/.well-known/oauth-authorization-server\n` +
      `  rs-meta:  ${resourceMetadataUrl}`
  );
});
