/**
 * The MCP server for ONE tenant (SaaS mode). Same tools as self-host, plus the Flags tools.
 * Every tool call is metered against the tenant's plan and runs inside a tenant transaction.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import type { Tenant } from "./accounts.js";
import { planFor, LimitError, type Plan } from "./plans.js";
import { countCall, searchMemory, saveMemory, TenantLibrarian } from "./memory.js";
import { prepareContent, findingsToFlags, recordFlags, summarize } from "../flags/service.js";
import { listFlags } from "../flags/store.js";
import { scanText, SEVERITIES, type Severity } from "../flags/scanner.js";
import type { AlertTarget } from "../flags/alerts.js";
import { registerPostOfficeTools, withInboxHint, SERVER_INSTRUCTIONS } from "../postoffice/tools.js";

const CHARACTER_LIMIT = 25000;

export function alertTargetFor(t: Tenant, publicUrl: string): AlertTarget {
  return { tenantId: t.id, tenantName: t.name, email: t.alert_email, webhookUrl: t.alert_webhook_url, minSeverity: t.alert_min_severity as Severity, dashboardUrl: `${publicUrl}/dashboard` };
}

const json = (o: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], structuredContent: o });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

export interface McpCtx { db: Db; tenant: Tenant; scopes: string[]; publicUrl: string; limitsOverride?: Record<string, Partial<Plan>>; clientId?: string; clientName?: string | null; }

export function buildTenantMcpServer(ctx: McpCtx): McpServer {
  const { db, tenant, scopes } = ctx;
  const plan = planFor(tenant.plan, ctx.limitsOverride as never);
  const canWrite = scopes.includes("memory.write");
  const server = withInboxHint(new McpServer({ name: "shared-memory", version: "2.0.0-saas" }, { instructions: SERVER_INSTRUCTIONS }));

  /** Meter + run in a tenant transaction; limits and errors become plain tool errors. */
  async function run(kind: "call" | "save", fn: (q: Parameters<Parameters<Db["tenant"]>[1]>[0]) => Promise<Record<string, unknown>>) {
    try {
      await db.tenant(tenant.id, (q) => countCall(q, tenant.id, plan, kind));
      return json(await db.tenant(tenant.id, fn));
    } catch (e) {
      if (e instanceof LimitError) return fail(e.message);
      return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const needWrite = (tool: string) => fail(`${tool} needs the memory.write scope. Reconnect and approve read + write.`);

  server.registerTool("search_memory", {
    title: "Search Memory",
    description: "Search this account's shared memory (case-insensitive substring), newest first. Returns message_id, notebook, sender, time and a snippet.",
    inputSchema: {
      query: z.string().min(1).max(500),
      since: z.string().optional().describe("ISO-8601 lower bound"),
      limit: z.number().int().min(1).max(200).default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { query: string; since?: string; limit?: number }) => run("call", async (q) => {
    let rows = await searchMemory(q, tenant.id, { query: p.query, since: p.since, limit: p.limit ?? 20 });
    const total = rows.length;
    while (JSON.stringify(rows).length > CHARACTER_LIMIT && rows.length > 1) rows = rows.slice(0, Math.floor(rows.length / 2));
    return { total, returned: rows.length, truncated: rows.length < total, results: rows };
  }));

  server.registerTool("save_memory", {
    title: "Save a Memory",
    description: "Save a memory every connected AI can find later. Secrets and personal numbers (API keys, tokens, passwords, card numbers, SSNs) are redacted BEFORE storage and raise a flag; harmful code and hedging are flagged. Requires memory.write.",
    inputSchema: {
      content: z.string().min(1).max(20000),
      source: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i).describe("Which AI/app is writing, e.g. 'claude.ai', 'grok'."),
      category: z.string().min(1).max(80).regex(/^[^\r\n]+$/).optional(),
      tags: z.array(z.string().min(1).max(30)).max(10).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (p: { content: string; source: string; category?: string; tags?: string[] }) => {
    if (!canWrite) return needWrite("save_memory");
    const prepared = await prepareContent(p.content);
    const tags = p.tags?.map((t) => scanText(t).redacted);
    return run("save", async (q) => {
      const saved = await saveMemory(q, tenant.id, plan, { content: prepared.text, source: p.source, category: p.category ? scanText(p.category).redacted : undefined, tags });
      let filing: Record<string, unknown> = {};
      try {
        const f = await new TenantLibrarian(q, tenant.id).fileSaved({ id: saved.message_id, text: saved.text, sender: p.source, source: p.source, conversationName: saved.conversation_name });
        filing = { filed_in: f.category, filing_tags: f.tags, filing_reason: f.explanation, filing_recorded: f.recorded };
      } catch (e) { filing = { filed_in: "unsorted", filing_reason: `Librarian error: ${(e as Error).message}`, filing_recorded: false }; }
      const flagged = await recordFlags(q, tenant.id, findingsToFlags(prepared.findings, { source_ai: p.source, reporter: "server", message_id: saved.message_id }), alertTargetFor(tenant, ctx.publicUrl));
      const { text: _t, ...rest } = saved;
      return { saved: true, ...rest, ...filing, redactions: prepared.redactions, flags: summarize(prepared.findings), flag_ids: flagged.flags.map((f) => f.id), alert: flagged.alert };
    });
  });

  server.registerTool("list_unsorted", {
    title: "List the Unsorted Tray", description: "Memories the Librarian could not file. Read-only.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { limit?: number }) => run("call", (q) => new TenantLibrarian(q, tenant.id).listUnsorted(p.limit ?? 20)));

  server.registerTool("explain_filing", {
    title: "Explain a Filing", description: "Which shelf a memory is on and the exact rule that put it there. Read-only.",
    inputSchema: { message_id: z.number().int().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { message_id: number }) => run("call", (q) => new TenantLibrarian(q, tenant.id).explain(p.message_id) as Promise<Record<string, unknown>>));

  server.registerTool("move_memory", {
    title: "Move a Memory", description: "Move a memory to another shelf; the Librarian may learn a trigger from it. Requires memory.write.",
    inputSchema: { message_id: z.number().int().min(1), to_category: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9/_-]*$/i), source: z.string().min(1).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (p: { message_id: number; to_category: string; source: string }) => {
    if (!canWrite) return needWrite("move_memory");
    return run("call", (q) => new TenantLibrarian(q, tenant.id).move(p.message_id, p.to_category.toLowerCase(), p.source) as Promise<Record<string, unknown>>);
  });

  server.registerTool("add_rule", {
    title: "Add a Filing Rule", description: 'Plain-word rule, e.g. "anything mentioning invoices goes in finance". Requires memory.write.',
    inputSchema: { rule: z.string().min(5).max(300), source: z.string().min(1).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (p: { rule: string; source: string }) => {
    if (!canWrite) return needWrite("add_rule");
    return run("call", (q) => new TenantLibrarian(q, tenant.id).addRule(p.rule, p.source) as Promise<Record<string, unknown>>);
  });

  server.registerTool("report_flag", {
    title: "Report a Flag",
    description: "Report a problem you noticed: a privacy leak, a secret in a chat, harmful code an AI suggested, hedging/evasion, or anything else the owner should see. The excerpt is redacted before storage. High and critical flags alert the owner. Requires memory.write.",
    inputSchema: {
      severity: z.enum(SEVERITIES as [Severity, ...Severity[]]),
      category: z.enum(["secret", "pii", "harmful_code", "hedging", "privacy", "moderation", "other"]),
      reason: z.string().min(3).max(1000).describe("Plain words: what is wrong and why it matters."),
      source_ai: z.string().min(1).max(60).describe("Which AI produced the content, e.g. 'chatgpt', 'claude.ai'."),
      reporter: z.string().min(1).max(60).optional().describe("Who is reporting (your own name/app)."),
      excerpt: z.string().max(2000).optional().describe("The offending text. It will be redacted."),
      url: z.string().max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (p: { severity: Severity; category: string; reason: string; source_ai: string; reporter?: string; excerpt?: string; url?: string }) => {
    if (!canWrite) return needWrite("report_flag");
    return run("call", async (q) => {
      const scan = p.excerpt ? scanText(p.excerpt) : null;
      const extra = scan ? findingsToFlags(scan.findings.filter((f) => f.category !== "hedging"), { source_ai: p.source_ai, reporter: "server", excerpt: scan.redacted }) : [];
      const res = await recordFlags(q, tenant.id, [
        { severity: p.severity, category: p.category, rule: null, origin: "report", source_ai: p.source_ai, reporter: p.reporter ?? "mcp", reason: p.reason, excerpt: scan?.redacted ?? null, context: p.url ? { url: p.url } : {} },
        ...extra,
      ], alertTargetFor(tenant, ctx.publicUrl));
      return { reported: true, flag_ids: res.flags.map((f) => f.id), redactions: scan?.redactions ?? 0, alert: res.alert };
    });
  });

  server.registerTool("list_flags", {
    title: "List Flags", description: "Recent flags for this account (secrets caught, harmful code, hedging, reports), newest first. Read-only.",
    inputSchema: {
      min_severity: z.enum(SEVERITIES as [Severity, ...Severity[]]).optional(),
      category: z.string().max(40).optional(),
      since: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { min_severity?: Severity; category?: string; since?: string; limit?: number }) => run("call", async (q) => listFlags(q, tenant.id, p) as unknown as Record<string, unknown>));

  // ---------------------------------------------------------------- Post office
  registerPostOfficeTools(server, {
    canWrite, tenantId: tenant.id,
    identity: { clientId: ctx.clientId ?? null, clientName: ctx.clientName ?? null },
    run: (fn) => run("call", fn),
    knownAgents: async (q) => (await q.query(
      `SELECT DISTINCT c.client_json->>'client_name' AS name, c.client_id FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.tenant_id = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`, [tenant.id])).rows
      .filter((r) => r.name).map((r) => ({ name: r.name, client_name: r.name })),
  });

  return server;
}
