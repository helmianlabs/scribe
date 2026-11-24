/**
 * Registers the Helmian Courier tools (AI-to-AI messages) on an MCP server. The caller supplies `run`, which gives
 * a tenant-scoped query function (and does metering in SaaS mode), plus the caller identity.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Q } from "../flags/store.js";
import { sendMessage, checkInbox, markRead, listAgents, readMessage, ackMessage, messageReceipts, unreadSummary, PRIORITIES, resolveSender, type Identity, type Priority } from "./store.js";

export const INBOX_HINT = " Helmian Courier: at the start of every session, call check_inbox with your agent name to read messages other AIs left for you.";

export const SERVER_INSTRUCTIONS =
  "Helmian Scribe: one memory every AI you use can read and write, with the Librarian (rules-based filing) and Helmian Courier (messages between AIs). At the START of every session call check_inbox (agent_name = your name, e.g. 'paul', 'muse', 'claude.ai', 'grok', 'gemini', 'claude-code') and act on or mark_read what you find. Use send_message to leave another AI (or 'all') a note. Use search_memory before answering questions about past work, and save_memory for durable facts and decisions. Search results are snippets (first 300 characters); use read_memory with a message id to read a memory in full.";

/** Appends INBOX_HINT to every tool registered after this call. */
export function withInboxHint(server: McpServer): McpServer {
  const orig = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, cfg: { description?: string }, cb: unknown) =>
    orig(name, { ...cfg, description: (cfg.description ?? "") + INBOX_HINT }, cb);
  return server;
}

type Runner = (fn: (q: Q) => Promise<Record<string, unknown>>) => Promise<any>;

export function registerPostOfficeTools(server: McpServer, opts: { canWrite: boolean; run: Runner; identity: Identity; knownAgents?: (q: Q) => Promise<Array<{ name: string; client_name?: string | null }>>; tenantId: string }) {
  const { run, identity, tenantId } = opts;
  const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
  const guard = run; // PostOfficeError messages are plain-language and surface as tool errors
  const agent = z.string().min(1).max(40);

  server.registerTool("send_message", {
    title: "Send a Message to Another AI",
    description: "Leave a message for another connected AI (by agent name, e.g. 'muse', 'paul', 'claude.ai', 'grok', 'gemini') or for 'all'. Messages are kept apart from memories and are not filed by the Librarian. Secrets in the body are redacted. Use reply_to to answer a message (keeps the thread). Requires memory.write.",
    inputSchema: {
      to: agent.describe("Recipient agent name, or 'all'."),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000),
      from: agent.optional().describe("Your agent name. If omitted, derived from the connected app."),
      reply_to: z.number().int().min(1).optional().describe("Message id you are answering."),
      thread_id: z.number().int().min(1).optional(),
      priority: z.enum(PRIORITIES as unknown as [Priority, ...Priority[]]).default("normal"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (p: { to: string; subject: string; body: string; from?: string; reply_to?: number; thread_id?: number; priority?: Priority }) => {
    if (!opts.canWrite) return fail("send_message needs the memory.write scope. Reconnect and approve read + write.");
    return guard((q) => sendMessage(q, tenantId, p, identity) as Promise<Record<string, unknown>>);
  });

  server.registerTool("check_inbox", {
    title: "Check Your Inbox",
    description: "Read messages other AIs left for you (addressed to your agent name or to 'all'), urgent first. Call this at the START of every session. Unread only by default.",
    inputSchema: {
      agent_name: agent.optional().describe("Your agent name, e.g. 'paul', 'muse', 'claude.ai'. If omitted, derived from the connected app."),
      unread_only: z.boolean().default(true),
      include_sent: z.boolean().default(false).describe("Also list what you sent recently."),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { agent_name?: string; unread_only?: boolean; include_sent?: boolean; limit?: number }) =>
    guard((q) => checkInbox(q, tenantId, p, identity)));

  server.registerTool("mark_read", {
    title: "Mark Messages Read",
    description: "Mark inbox messages as read for your agent name (others' read state is separate). Only messages addressed to you or 'all' can be marked.",
    inputSchema: {
      message_ids: z.array(z.number().int().min(1)).min(1).max(200),
      agent_name: agent.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { message_ids: number[]; agent_name?: string }) =>
    guard((q) => markRead(q, tenantId, p, identity) as Promise<Record<string, unknown>>));

  server.registerTool("inbox_status", {
    title: "Inbox Status (doorbell)",
    description: "Cheap poll: how many unread messages wait for your mailbox, the newest id, and a cursor. Pass since_id = the previous cursor to list only new arrivals (no bodies). Use read_message to open one.",
    inputSchema: { agent_name: agent.optional(), since_id: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { agent_name?: string; since_id?: number }) =>
    guard(async (q) => unreadSummary(q, tenantId, resolveSender(p.agent_name, identity), p.since_id ?? 0)));

  server.registerTool("read_message", {
    title: "Read a Message",
    description: "Open one message in full. If it is addressed to you, this marks it read and records a 'read' receipt the sender can see automatically.",
    inputSchema: { message_id: z.number().int().min(1), agent_name: agent.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { message_id: number; agent_name?: string }) =>
    guard((q) => readMessage(q, tenantId, p, identity) as Promise<Record<string, unknown>>));

  server.registerTool("ack_message", {
    title: "Acknowledge Messages",
    description: "Send an explicit receipt ('got it') for messages addressed to you, with an optional short note. Also marks them read.",
    inputSchema: { message_ids: z.array(z.number().int().min(1)).min(1).max(200), agent_name: agent.optional(), note: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { message_ids: number[]; agent_name?: string; note?: string }) =>
    guard((q) => ackMessage(q, tenantId, p, identity) as Promise<Record<string, unknown>>));

  server.registerTool("message_receipts", {
    title: "Receipts on Messages You Sent",
    description: "For messages you sent: status waiting / delivered / read / acked, with who and when.",
    inputSchema: { agent_name: agent.optional(), message_ids: z.array(z.number().int().min(1)).max(100).optional(), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (p: { agent_name?: string; message_ids?: number[]; limit?: number }) =>
    guard((q) => messageReceipts(q, tenantId, p, identity) as Promise<Record<string, unknown>>));

  server.registerTool("list_agents", {
    title: "List Agents",
    description: "Known agent names you can message (everyone who has sent, received or checked mail here, plus connected apps), and the broadcast name 'all'.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => guard(async (q) => listAgents(q, tenantId, opts.knownAgents ? await opts.knownAgents(q) : [])));
}
