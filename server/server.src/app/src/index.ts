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
    name: "claude-memory-mcp-server",
    status: "ok",
    mcp_endpoint: `${PUBLIC_URL}${MCP_PATH}`,
    transport: "streamable-http",
    auth: "oauth2.1+pkce+dcr",
  });
});
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

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

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: ISSUER,
    baseUrl: ISSUER,
    resourceServerUrl: RESOURCE_URL,
    resourceName: "Claude Memory",
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
  const server = buildMcpServer(auth?.scopes ?? []);
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
app.delete(MCP_PATH, bearer, (_req, res) => res.status(405).end());

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `claude-memory-mcp-server listening on :${PORT}\n` +
      `  public:   ${PUBLIC_URL}\n` +
      `  mcp:      ${PUBLIC_URL}${MCP_PATH}\n` +
      `  as-meta:  ${PUBLIC_URL}/.well-known/oauth-authorization-server\n` +
      `  rs-meta:  ${resourceMetadataUrl}`
  );
});
