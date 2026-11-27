/**
 * Database access for the memory server.
 *
 * READ path: a small pg Pool on DATABASE_URL (the read-only Neon role
 * memory_ro_hz). Every query is a SELECT, and each session is additionally
 * forced into default_transaction_read_only, so this path cannot mutate.
 *
 * WRITE path (save_memory only): a SEPARATE pg Pool on DATABASE_WRITE_URL
 * (the Neon role memory_rw, which holds INSERT + SELECT on the conversations
 * and messages tables and USAGE on messages_id_seq — nothing else). No
 * read-only session forcing here; the tight role grants are the boundary.
 * The write pool never serves search, and the read pool never serves saves.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { DATABASE_URL, DATABASE_WRITE_URL } from "./config.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  ssl: { rejectUnauthorized: false },
  application_name: "claude-memory-mcp",
});

// Force every new connection to default_transaction_read_only so that, even if
// the supplied role had write rights, this process cannot write.
pool.on("connect", (client) => {
  client.query("SET default_transaction_read_only = on").catch(() => {
    /* if the role can't set this, the SELECTs are still harmless */
  });
});

export interface MemoryRow {
  id: number;
  conversation_name: string;
  sender: string;
  created_at: string;
  snippet: string;
}

export interface SearchParams {
  query: string;
  since?: string; // ISO-8601 date/time
  limit: number;
}

/**
 * ILIKE search over messages.text, joined to conversations, newest first.
 * Returns id, conversation_name, sender, created_at, and a 300-char snippet.
 * The id is the stable handle for read_memory (full text by id).
 */
export async function searchMemory(params: SearchParams): Promise<MemoryRow[]> {
  const values: unknown[] = [`%${params.query}%`];
  let sinceClause = "";
  if (params.since && params.since.trim()) {
    values.push(params.since.trim());
    sinceClause = `AND m.created_at >= $${values.length}`;
  }
  values.push(params.limit);
  const limitPlaceholder = `$${values.length}`;

  const sql = `
    SELECT m.id          AS id,
           c.name        AS conversation_name,
           m.sender       AS sender,
           m.created_at   AS created_at,
           LEFT(m.text, 300) AS snippet
    FROM messages m
    JOIN conversations c ON c.uuid = m.conversation_uuid
    WHERE m.text ILIKE $1
    ${sinceClause}
    ORDER BY m.created_at DESC
    LIMIT ${limitPlaceholder}`;

  const result = await pool.query(sql, values);
  return result.rows.map((r) => ({
    id: Number(r.id),
    conversation_name: r.conversation_name,
    sender: r.sender,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    snippet: r.snippet ?? "",
  }));
}

export interface FullMessage {
  id: number;
  sender: string;
  created_at: string;
  conversation_name: string;
  text: string;
}

/**
 * Fetch one complete message by its stable id (the read_memory backing query).
 * Returns null when no message has that id.
 */
export async function getMessageById(id: number): Promise<FullMessage | null> {
  const result = await pool.query(
    `SELECT m.id         AS id,
            m.sender     AS sender,
            m.created_at AS created_at,
            c.name       AS conversation_name,
            m.text       AS text
     FROM messages m
     JOIN conversations c ON c.uuid = m.conversation_uuid
     WHERE m.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: Number(r.id),
    sender: r.sender,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    conversation_name: r.conversation_name,
    text: r.text ?? "",
  };
}

export interface MailboxEntry {
  tag: string;
  recent_count: number;
  newest_id: number;
  newest_sender: string;
  newest_created_at: string;
  newest_first_line: string;
}

/** Recipient tags the piggyback mailbox block reports on. */
export const MAILBOX_TAGS = [
  "for-claude",
  "for-mistral",
  "for-gemini",
  "for-grok",
  "for-muse",
] as const;

/**
 * First real content line of a message body: tags live in a leading
 * "[tags: ...]" line, so skip that line and return the first line of the
 * body itself (trimmed, blank lines dropped), capped at 100 chars.
 */
function firstContentLine(text: string): string {
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let firstLine = lines[0] ?? "";
  if (firstLine.startsWith("[tags:") && lines.length > 1) {
    firstLine = lines[1];
  }
  return firstLine.slice(0, 100);
}

export interface MailboxStatusEntry {
  tag: string;
  count: number;
  newest: {
    id: number;
    sender: string;
    created_at: string;
    subject: string;
  } | null;
}

/**
 * Structured mailbox status for every known recipient tag (backs the
 * token-gated GET /mailbox-status feed): how many messages from the last
 * 14 days contain the tag, plus the newest one (id, sender, date,
 * subject = first content line). Tags with no recent mail report
 * count 0 and newest null. Counts and subjects only — never bodies.
 */
export async function mailboxStatus(): Promise<MailboxStatusEntry[]> {
  const entries: MailboxStatusEntry[] = [];
  for (const tag of MAILBOX_TAGS) {
    const like = `%${tag}%`;
    const counted = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM messages m
       WHERE m.text ILIKE $1
         AND m.created_at >= now() - interval '14 days'`,
      [like]
    );
    const count = Number(counted.rows[0]?.total ?? 0);
    if (count === 0) {
      entries.push({ tag, count, newest: null });
      continue;
    }
    const result = await pool.query(
      `SELECT m.id, m.sender, m.created_at, m.text
       FROM messages m
       WHERE m.text ILIKE $1
         AND m.created_at >= now() - interval '14 days'
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1`,
      [like]
    );
    const r = result.rows[0];
    entries.push({
      tag,
      count,
      newest: {
        id: Number(r.id),
        sender: String(r.sender),
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
        subject: firstContentLine(String(r.text ?? "")),
      },
    });
  }
  return entries;
}

/** Recent (14-day) count of legacy-tagged memory filings for one mailbox
 * tag (e.g. "for-muse"): the legacy letter convention the door-knock
 * contract's include_legacy block reports. Same window and match as
 * mailboxStatus(). */
export async function legacyMailboxRecentCount(tag: string): Promise<number> {
  const counted = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messages m
     WHERE m.text ILIKE $1
       AND m.created_at >= now() - interval '14 days'`,
    [`%${tag}%`]
  );
  return Number(counted.rows[0]?.total ?? 0);
}

/**
 * Mailbox digest for the piggyback block: for each known recipient tag, how
 * many messages from the last 14 days contain that tag, plus the newest one
 * (id, sender, date, first content line). Tags live in a leading
 * "[tags: ...]" line, so the preview skips that line and shows the first
 * real line of the body. Tags with no recent mail are omitted.
 *
 * NOTE (v1 limitation): this digest is global, not scoped to the caller —
 * every caller sees every mailbox's count. Fine for this single-user post
 * office; per-recipient scoping arrives with the delivery ledger.
 */
export async function mailboxDigest(): Promise<MailboxEntry[]> {
  const status = await mailboxStatus();
  const entries: MailboxEntry[] = [];
  for (const s of status) {
    if (s.count === 0 || !s.newest) continue;
    entries.push({
      tag: s.tag,
      recent_count: s.count,
      newest_id: s.newest.id,
      newest_sender: s.newest.sender,
      newest_created_at: s.newest.created_at,
      newest_first_line: s.newest.subject,
    });
  }
  return entries;
}

export async function closePool(): Promise<void> {
  await pool.end();
  await writePool.end();
}

// ---------------------------------------------------------------------------
// WRITE path — used ONLY by the save_memory tool.
// ---------------------------------------------------------------------------

const writePool = new Pool({
  connectionString: DATABASE_WRITE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
  application_name: "claude-memory-mcp-write",
});

export interface SaveMemoryParams {
  content: string;
  source: string; // the AI/app writing, e.g. "claude.ai", "grok", "muse"
  category?: string; // filing topic; becomes the notebook (conversation) name
  tags?: string[];
}

export interface SaveMemoryResult {
  conversation_name: string;
  conversation_uuid: string;
  message_id: number;
  created_at: string;
}

/**
 * File one new memory into the shared archive.
 *
 * Filing model (fits the existing conversations/messages schema, no new
 * tables or columns):
 *   - Notebook = a row in . With a category, the notebook is
 *     named "Shared Memory — <category>" and every AI writing on that topic
 *     files into the same notebook. Without a category, the notebook is
 *     "Shared Memory — <source>" (one notebook per writing AI).
 *   - The memory itself is one row in  with sender = source (so
 *     search results show which AI wrote it), turn_index = next in notebook.
 *   - Tags have no column in the schema; they are stored as a leading
 *     "[tags: a, b]" line in the message text, which also makes them
 *     findable through search_memory.
 *
 * Note: conversations.message_count is set to 1 when a notebook is created
 * and is not maintained afterwards — the memory_rw role is deliberately
 * INSERT + SELECT only (no UPDATE), so the counter can drift for shared
 * notebooks. Nothing in this server reads message_count.
 */
export async function saveMemory(params: SaveMemoryParams): Promise<SaveMemoryResult> {
  const source = params.source.trim().toLowerCase();
  const category = params.category?.trim();
  const notebook = category
    ? `Shared Memory — ${category}`
    : `Shared Memory — ${source}`;
  const tags = (params.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const text = tags.length
    ? `[tags: ${tags.join(", ")}]\n${params.content}`
    : params.content;

  const client = await writePool.connect();
  try {
    await client.query("BEGIN");

    let conversationUuid: string;
    const existing = await client.query(
      "SELECT uuid FROM conversations WHERE name = $1 ORDER BY created_at ASC LIMIT 1",
      [notebook]
    );
    if (existing.rows.length > 0) {
      conversationUuid = existing.rows[0].uuid as string;
    } else {
      conversationUuid = randomUUID();
      await client.query(
        "INSERT INTO conversations (uuid, name, created_at, updated_at, message_count) VALUES ($1, $2, now(), now(), 1)",
        [conversationUuid, notebook]
      );
    }

    const next = await client.query(
      "SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_index FROM messages WHERE conversation_uuid = $1",
      [conversationUuid]
    );
    const turnIndex = next.rows[0].next_index as number;

    const inserted = await client.query(
      "INSERT INTO messages (conversation_uuid, turn_index, sender, text, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING id, created_at",
      [conversationUuid, turnIndex, source, text]
    );

    await client.query("COMMIT");
    const row = inserted.rows[0];
    return {
      conversation_name: notebook,
      conversation_uuid: conversationUuid,
      message_id: row.id as number,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Librarian access: the read pool (read-only sessions) and the write pool (memory_rw).
export function librarianPools(): { read: pg.Pool; write: pg.Pool } {
  return { read: pool, write: writePool };
}
