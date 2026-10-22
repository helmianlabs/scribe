/**
 * The MCP server definition: exposes `search_memory` (read) and `save_memory`
 * (write) over the Streamable HTTP transport. Search runs on a read-only Neon
 * role; saving runs on a separate INSERT + SELECT-only Neon role and requires
 * the memory.write OAuth scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchMemory, saveMemory } from "./db.js";
import { CHARACTER_LIMIT } from "./config.js";

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

export function buildMcpServer(scopes: string[] = []): McpServer {
  const server = new McpServer({
    name: "claude-memory-mcp-server",
    version: "1.1.0",
  });

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

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
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
      description: `Save a new memory into Sam's shared memory so that every connected AI (Claude, ChatGPT, Grok, Gemini, the coding tools) can find it later with search_memory.

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
        const saved = await saveMemory({
          content: params.content,
          source: params.source,
          category: params.category,
          tags: params.tags,
        });
        const output = { saved: true, ...saved };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
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

  return server;
}
