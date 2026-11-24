/**
 * The MCP server definition: exposes `search_memory` + `read_memory` (read)
 * and `save_memory` (write) over the Streamable HTTP transport. Search runs
 * on a read-only Neon role; saving runs on a separate INSERT + SELECT-only
 * Neon role and requires the memory.write OAuth scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchMemory, saveMemory, getMessageById, mailboxDigest, librarianPools } from "./db.js";
import { Librarian } from "./librarian-tools.js";
import { CHARACTER_LIMIT } from "./config.js";
import { prepareContent, findingsToFlags, recordFlags, summarize } from "./flags/service.js";
import { listFlags } from "./flags/store.js";
import { scanText, SEVERITIES, type Severity } from "./flags/scanner.js";
import type { AlertTarget } from "./flags/alerts.js";
import { registerPostOfficeTools, withInboxHint, SERVER_INSTRUCTIONS } from "./courier/tools.js";

/** Self-host alerts go to ALERT_EMAIL_TO and/or ALERT_WEBHOOK_URL (both optional; stubbed if absent). */
function selfAlertTarget(): AlertTarget {
  return { tenantId: "self", tenantName: "Helmian Scribe", email: process.env.ALERT_EMAIL_TO || null, webhookUrl: process.env.ALERT_WEBHOOK_URL || null };
}

const SearchMemoryInputSchema = z
  .object({
    query: z
      .string()
      .min(1, "query must not be empty")
      .max(500, "query must not exceed 500 characters")
      .describe("Substring to search for (case-insensitive ILIKE) within message text."),
    since: z
      .string()
      .optional()
      .describe(
        "Optional ISO-8601 date or datetime (e.g. '2026-06-01' or '2026-06-01T00:00:00Z'). Only messages at/after this time are returned."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum number of matching messages to return (default 20, max 200)."),
  })
  .strict();

type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;

let librarian: Librarian | null = null;
function getLibrarian(): Librarian {
  if (!librarian) {
    const { read, write } = librarianPools();
    librarian = new Librarian(read, write);
  }
  return librarian;
}

function jsonResult(output: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(prefix: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `${prefix}: ${msg}` }], isError: true };
}

/**
 * The piggyback mailbox block appended to search_memory / save_memory text
 * results: one line per recipient tag with recent mail (count + newest
 * message). Never throws — on any error it returns "" so the main tool
 * result is unaffected.
 */
async function mailboxBlock(): Promise<string> {
  try {
    const entries = await mailboxDigest();
    if (entries.length === 0) {
      return "\n\n--- MAILBOX --- no recent mail for anyone.";
    }
    const lines = entries.map(
      (e) =>
        `${e.tag}: ${e.recent_count} recent, newest #${e.newest_id} from ${e.newest_sender} (${e.newest_created_at.slice(0, 10)}): ${e.newest_first_line}`
    );
    return `\n\n--- MAILBOX ---\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

export function buildMcpServer(scopes: string[] = [], identity: { clientId?: string | null; clientName?: string | null } = {}): McpServer {
  const server = withInboxHint(new McpServer({
    name: "helmian-scribe",
    title: "Helmian Scribe",
    version: "1.3.0",
  }, { instructions: SERVER_INSTRUCTIONS }));

  server.registerTool(
    "search_memory",
    {
      title: "Search Conversation Memory",
      description: `Search Sam's archived Claude conversation history for messages matching a query string.

Performs a case-insensitive substring (ILIKE) search over the text of every message across all archived conversations, joined to the conversation they belong to. Results are ordered newest-first.

Args:
  - query (string, required): substring to match within message text.
  - since (string, optional): ISO-8601 date/datetime lower bound on message timestamp.
  - limit (number, optional): max results, 1-200 (default 20).

Returns: a JSON array of objects, each:
  {
    "id": number,                 // stable message id — pass it to read_memory to fetch the full text
    "conversation_name": string,  // title of the conversation the message is in
    "sender": string,             // "human" or "assistant"
    "created_at": string,         // ISO-8601 timestamp of the message
    "snippet": string             // first 300 characters of the message text
  }

Examples:
  - "find when we discussed Saadi pricing" -> { query: "Saadi" }
  - "detention talk since June" -> { query: "detention", since: "2026-06-01" }

Returns an empty array if nothing matches. This is read-only; it never modifies data.`,
      inputSchema: SearchMemoryInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchMemoryInput) => {
      try {
        const rows = await searchMemory({
          query: params.query,
          since: params.since,
          limit: params.limit ?? 20,
        });

        let text = JSON.stringify(rows, null, 2);
        let truncated = false;
        let returned = rows.length;
        if (text.length > CHARACTER_LIMIT) {
          // Halve until under the limit.
          let slice = rows;
          while (text.length > CHARACTER_LIMIT && slice.length > 1) {
            slice = slice.slice(0, Math.max(1, Math.floor(slice.length / 2)));
            text = JSON.stringify(slice, null, 2);
          }
          truncated = true;
          returned = slice.length;
        }

        const output = {
          total: rows.length,
          returned,
          truncated,
          ...(truncated
            ? {
                note: `Response truncated to ${returned} of ${rows.length} results to stay within size limits. Use 'limit' or 'since' to narrow.`,
              }
            : {}),
          results: truncated
            ? JSON.parse(text)
            : rows,
        };

        const block = await mailboxBlock();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) + block }],
          structuredContent: output,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching memory: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const ReadMemoryInputSchema = z
    .object({
      message_id: z
        .number()
        .int()
        .min(1)
        .describe("The stable numeric message id, as shown in search_memory results or returned by save_memory."),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Character offset for very long messages. If a previous read_memory call returned next_offset, pass that value to fetch the next chunk."),
    })
    .strict();

  type ReadMemoryInput = z.infer<typeof ReadMemoryInputSchema>;

  const READ_MEMORY_PAGE = 8000;

  server.registerTool(
    "read_memory",
    {
      title: "Read a Full Memory by ID",
      description: `Helmian Scribe — Fetch the complete text of one message by its stable id.

search_memory returns only the first 300 characters of each message; this tool returns the whole letter. Use it after search_memory: take the "id" from a search result and read the full message.

Args:
  - message_id (number, required): the message id from a search result or from save_memory.
  - offset (number, optional): character offset for very long messages. Responses carry at most ${READ_MEMORY_PAGE} characters of text; if a response includes next_offset, call again with offset set to that value to fetch the next chunk.

Returns a JSON object: { id, sender, created_at, conversation_name, text, text_length, offset, returned_chars, next_offset }. next_offset is null when the whole message has been returned. Read-only; it never modifies data.`,
      inputSchema: ReadMemoryInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ReadMemoryInput) => {
      try {
        const msg = await getMessageById(params.message_id);
        if (!msg) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No message found with id ${params.message_id}. Check the id from a search_memory result and try again.`,
              },
            ],
            isError: true,
          };
        }
        const total = msg.text.length;
        const offset = Math.min(params.offset ?? 0, total);
        const chunk = msg.text.slice(offset, offset + READ_MEMORY_PAGE);
        const nextOffset =
          offset + chunk.length < total ? offset + chunk.length : null;
        const output = {
          id: msg.id,
          sender: msg.sender,
          created_at: msg.created_at,
          conversation_name: msg.conversation_name,
          text: chunk,
          text_length: total,
          offset,
          returned_chars: chunk.length,
          next_offset: nextOffset,
          ...(nextOffset !== null
            ? {
                note: `This message is ${total} characters long. You are reading characters ${offset}–${offset + chunk.length - 1}. Call read_memory again with offset ${nextOffset} to continue.`,
              }
            : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult("Error reading memory", err);
      }
    }
  );

  const canWrite = scopes.includes("memory.write");

  const SaveMemoryInputSchema = z
    .object({
      content: z
        .string()
        .min(1, "content must not be empty")
        .max(20000, "content must not exceed 20000 characters")
        .describe(
          "The memory text to save, written to be useful out of context: what happened, what was decided, names, dates."
        ),
      source: z
        .string()
        .min(1)
        .max(40)
        .regex(
          /^[a-z0-9][a-z0-9._-]*$/i,
          "source must be a short slug like 'claude.ai', 'grok', 'claude-code'"
        )
        .describe(
          "Which AI/app is writing this memory (caller-declared), e.g. 'claude.ai', 'claude-code', 'codex', 'grok', 'gemini', 'mistral', 'muse'. Stored as the message sender so search results show the author."
        ),
      category: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[^\r\n]+$/, "category must be a single line")
        .optional()
        .describe(
          "Optional filing topic (e.g. 'Helmian', 'DairyForge', 'Family'). Memories with the same category are filed into one shared notebook that every AI can read and add to. Omit for a per-source notebook."
        ),
      tags: z
        .array(z.string().min(1).max(30))
        .max(10)
        .optional()
        .describe(
          "Optional short tags. Stored as a '[tags: ...]' line in the memory text, so they are searchable too."
        ),
    })
    .strict();

  type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

  server.registerTool(
    "save_memory",
    {
      title: "Save a Memory",
      description: `Save a new memory into Helmian Scribe (Sam's shared memory) so that every connected AI (Claude, ChatGPT, Grok, Gemini, the coding tools) can find it later with search_memory.

The memory is filed as a message in a notebook conversation: with a category, the notebook is "Shared Memory — <category>" and is shared across AIs; without one, it goes to "Shared Memory — <source>". The writing AI is recorded as the sender.

Args:
  - content (string, required): the memory text. Write it to stand alone: include the facts, decisions, names and dates a future reader needs.
  - source (string, required): which AI/app is writing, e.g. "claude.ai", "claude-code", "codex", "grok", "gemini", "mistral".
  - category (string, optional): filing topic; the same category always files into the same shared notebook.
  - tags (string[], optional): up to 10 short tags; stored in the text and searchable.

Requires the memory.write OAuth scope. Returns the notebook name, conversation uuid, message id and timestamp of the saved memory. This tool only ever INSERTs; it cannot edit or delete existing memories.`,
      inputSchema: SaveMemoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: SaveMemoryInput) => {
      if (!canWrite) {
        return {
          content: [
            {
              type: "text" as const,
              text: "save_memory is not enabled for this connection: the access token does not carry the memory.write scope. Searching is unaffected. To enable saving, reconnect the connector and approve access again so a token with memory.write is issued.",
            },
          ],
          isError: true,
        };
      }
      try {
        // Flags: secrets and personal numbers are redacted BEFORE storage.
        const prepared = await prepareContent(params.content);
        const tags = params.tags?.map((t) => scanText(t).redacted);
        const category = params.category ? scanText(params.category).redacted : undefined;
        const saved = await saveMemory({
          content: prepared.text,
          source: params.source,
          category,
          tags,
        });
        // The Librarian files it (never blocks or fails the save).
        const filing = await getLibrarian().fileSaved({
          id: saved.message_id,
          text: tags?.length ? `[tags: ${tags.join(", ")}]\n${prepared.text}` : prepared.text,
          sender: params.source,
          source: params.source,
          conversationName: saved.conversation_name,
        });
        let flagIds: number[] = [];
        let alert: unknown = null;
        try {
          const rec = await recordFlags(librarianPools().write, "self", findingsToFlags(prepared.findings, { source_ai: params.source, reporter: "server", message_id: saved.message_id }), selfAlertTarget());
          flagIds = rec.flags.map((f) => f.id);
          alert = rec.alert;
        } catch { /* flags table missing or transient: the save still stands, redaction already applied */ }
        const output = { saved: true, ...saved, filed_in: filing.category, filing_tags: filing.tags, filing_reason: filing.explanation, filing_recorded: filing.recorded, redactions: prepared.redactions, flags: summarize(prepared.findings), flag_ids: flagIds, alert };
        const block = await mailboxBlock();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) + block }],
          structuredContent: output,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error saving memory: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------- Librarian
  server.registerTool(
    "list_unsorted",
    {
      title: "List the Unsorted Tray",
      description: "List memories the Librarian could not file (the unsorted tray). Nothing in the tray is lost; move an item with move_memory and the Librarian may learn a rule from it. Read-only.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("Max items (default 20).") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p: { limit?: number }) => {
      try { return jsonResult(await getLibrarian().listUnsorted(p.limit ?? 20)); } catch (e) { return errorResult("Error listing unsorted", e); }
    }
  );

  server.registerTool(
    "explain_filing",
    {
      title: "Explain a Filing",
      description: "Say which shelf a memory is on and the exact rule that put it there. Takes the message_id that save_memory returned. Read-only.",
      inputSchema: { message_id: z.number().int().min(1).describe("Message id of the memory.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p: { message_id: number }) => {
      try { return jsonResult(await getLibrarian().explain(p.message_id)); } catch (e) { return errorResult("Error explaining filing", e); }
    }
  );

  const needWrite = (tool: string) => ({
    content: [{ type: "text" as const, text: `${tool} needs the memory.write scope. Reconnect the connector and approve read+write access.` }],
    isError: true,
  });

  server.registerTool(
    "move_memory",
    {
      title: "Move a Memory to Another Shelf",
      description: "Move a memory to another shelf (category). The move is recorded (history is kept, nothing is overwritten) and the Librarian may learn a trigger word from it so similar memories file there next time. Requires memory.write.",
      inputSchema: {
        message_id: z.number().int().min(1),
        to_category: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9/_-]*$/i, "category slug, e.g. 'helmian' or 'personal'"),
        source: z.string().min(1).max(40).describe("Who is moving it, e.g. 'sam', 'claude.ai', 'grok'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p: { message_id: number; to_category: string; source: string }) => {
      if (!canWrite) return needWrite("move_memory");
      try { return jsonResult(await getLibrarian().move(p.message_id, p.to_category.toLowerCase(), p.source)); } catch (e) { return errorResult("Error moving memory", e); }
    }
  );

  server.registerTool(
    "add_rule",
    {
      title: "Add a Filing Rule",
      description: 'Add a plain-word filing rule for the Librarian, e.g. "anything mentioning invoices goes in finance", "anything from grok goes in grok notes", "errors go in bugs and tag it urgent". Requires memory.write.',
      inputSchema: {
        rule: z.string().min(5).max(300),
        source: z.string().min(1).max(40).describe("Who is adding it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p: { rule: string; source: string }) => {
      if (!canWrite) return needWrite("add_rule");
      try { return jsonResult(await getLibrarian().addRule(p.rule, p.source)); } catch (e) { return errorResult("Error adding rule", e); }
    }
  );

  // ---------------------------------------------------------------- Flags
  server.registerTool(
    "report_flag",
    {
      title: "Report a Flag",
      description: "Report a problem you noticed: a privacy leak, a secret in a chat, harmful code an AI suggested, hedging/evasion, or anything the owner should see. The excerpt is redacted before storage. Requires memory.write.",
      inputSchema: {
        severity: z.enum(SEVERITIES as [Severity, ...Severity[]]),
        category: z.enum(["secret", "pii", "harmful_code", "hedging", "privacy", "moderation", "other"]),
        reason: z.string().min(3).max(1000),
        source_ai: z.string().min(1).max(60).describe("Which AI produced the content."),
        reporter: z.string().min(1).max(60).optional(),
        excerpt: z.string().max(2000).optional(),
        url: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p: { severity: Severity; category: string; reason: string; source_ai: string; reporter?: string; excerpt?: string; url?: string }) => {
      if (!canWrite) return needWrite("report_flag");
      try {
        const scan = p.excerpt ? scanText(p.excerpt) : null;
        const extra = scan ? findingsToFlags(scan.findings.filter((f) => f.category !== "hedging"), { source_ai: p.source_ai, reporter: "server", excerpt: scan.redacted }) : [];
        const res = await recordFlags(librarianPools().write, "self", [
          { severity: p.severity, category: p.category, origin: "report", source_ai: p.source_ai, reporter: p.reporter ?? "mcp", reason: p.reason, excerpt: scan?.redacted ?? null, context: p.url ? { url: p.url } : {} },
          ...extra,
        ], selfAlertTarget());
        if (!res.installed) return jsonResult({ reported: false, note: "The flags table is not installed yet (migration 004_flags.sql)." });
        return jsonResult({ reported: true, flag_ids: res.flags.map((f) => f.id), redactions: scan?.redactions ?? 0, alert: res.alert });
      } catch (e) { return errorResult("Error reporting flag", e); }
    }
  );

  server.registerTool(
    "list_flags",
    {
      title: "List Flags",
      description: "Recent flags (secrets caught, harmful code, hedging, reports), newest first. Read-only.",
      inputSchema: {
        min_severity: z.enum(SEVERITIES as [Severity, ...Severity[]]).optional(),
        category: z.string().max(40).optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p: { min_severity?: Severity; category?: string; since?: string; limit?: number }) => {
      try { return jsonResult((await listFlags(librarianPools().read, "self", p)) as unknown as Record<string, unknown>); } catch (e) { return errorResult("Error listing flags", e); }
    }
  );

  // ---------------------------------------------------------------- Helmian Courier
  // Append-only on the write pool (memory_rw: SELECT + INSERT), tenant 'self'.
  registerPostOfficeTools(server, {
    canWrite, tenantId: "self", identity,
    run: async (fn) => {
      try { return jsonResult(await fn(librarianPools().write)); }
      catch (e) {
        if ((e as { code?: string }).code === "42P01") return errorResult("Helmian Courier", new Error("not installed yet (migration 006_courier.sql)"));
        return errorResult("Helmian Courier", e);
      }
    },
  });

  return server;
}
