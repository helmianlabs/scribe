/**
 * History import (SaaS mode): a signed-in tenant uploads a Claude.ai or
 * ChatGPT data-export .zip and their old conversations are filed into THEIR
 * vault through the same save pipeline save_memory uses (redaction scan →
 * saveMemory → Librarian filing → flags). The tenant always comes from the
 * caller's credential — nothing in the file can name a tenant.
 *
 * Parsers are deliberately strict: an export whose shape does not match the
 * documented Claude/ChatGPT formats fails loudly BEFORE anything is saved.
 * Formats drift; a loud failure is a support ticket, a silent mis-parse is
 * a corrupted vault.
 */
import { createHash } from "node:crypto";
import type { Db, Q } from "./db.js";
import type { Tenant } from "./accounts.js";
import { LimitError, type Plan } from "./plans.js";
import { saveMemory, TenantLibrarian } from "./memory.js";
import { prepareContent, findingsToFlags, recordFlags } from "../flags/service.js";
import type { AlertTarget } from "../flags/alerts.js";
import { readZip, ZipError } from "./zip.js";

export class ImportError extends Error {}

// ------------------------------------------------------------------ caps
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;          // compressed, as uploaded
export const MAX_CONVERSATIONS = 2_000;                 // per import
export const MAX_CONVERSATION_CHARS = 2_000_000;        // rendered, per conversation
export const PART_CHARS = 48_000;                       // per saved memory (one part)
const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 192 * 1024 * 1024;

// ------------------------------------------------------------------ shapes
export type ImportFormat = "claude" | "chatgpt";

export interface ImportMessage { sender: string; text: string; at: string | null; }
export interface ImportConversation {
  sourceId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messages: ImportMessage[];
}
export interface ParsedExport {
  format: ImportFormat;
  formatLabel: string;      // "Claude" | "ChatGPT"
  sourceTag: string;        // "import-claude" | "import-chatgpt"
  assistantName: string;    // sender label for assistant turns
  conversations: ImportConversation[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isoFromEpochSeconds = (v: unknown): string | null =>
  typeof v === "number" && isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
const isoStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

// ------------------------------------------------------------------ Claude.ai
// conversations.json: [{ uuid, name, created_at, updated_at,
//   chat_messages: [{ sender: "human"|"assistant", text, content?, created_at }] }]
function parseClaude(items: unknown[]): ImportConversation[] {
  return items.map((item, i) => {
    if (!isObj(item) || !Array.isArray(item.chat_messages)) {
      throw new ImportError(`Claude export, conversation ${i + 1}: missing the chat_messages list — the export format has changed or the file is damaged. Nothing was imported.`);
    }
    const messages: ImportMessage[] = [];
    for (const m of item.chat_messages) {
      if (!isObj(m)) throw new ImportError(`Claude export, conversation ${i + 1}: a message is not an object — the export format has changed. Nothing was imported.`);
      let text = str(m.text);
      if (!text.trim() && Array.isArray(m.content)) {
        text = m.content
          .filter((b) => isObj(b) && b.type === "text")
          .map((b) => str((b as Record<string, unknown>).text))
          .join("\n");
      }
      if (m.text === undefined && m.content === undefined) {
        throw new ImportError(`Claude export, conversation ${i + 1}: a message has neither text nor content blocks — the export format has changed. Nothing was imported.`);
      }
      if (!text.trim()) continue; // attachment-only turn: nothing to file
      messages.push({ sender: str(m.sender) || "unknown", text: text.trim(), at: isoStr(m.created_at) });
    }
    return {
      sourceId: str(item.uuid),
      title: str(item.name).trim() || "Untitled conversation",
      createdAt: isoStr(item.created_at),
      updatedAt: isoStr(item.updated_at),
      messages,
    };
  });
}

// ------------------------------------------------------------------ ChatGPT
// conversations.json: [{ title, create_time, update_time, conversation_id,
//   mapping: { nodeId: { message: { author: { role }, create_time,
//   content: { parts: [...] } } | null, parent, children } }, current_node }]
interface ChatNode { message: Record<string, unknown> | null; parent: string | null; }

function chatGptThread(item: Record<string, unknown>): ImportMessage[] {
  const mapping = item.mapping as Record<string, unknown>;
  const nodes = new Map<string, ChatNode>();
  for (const [id, raw] of Object.entries(mapping)) {
    if (!isObj(raw)) continue;
    nodes.set(id, { message: isObj(raw.message) ? raw.message : null, parent: typeof raw.parent === "string" ? raw.parent : null });
  }
  // The live thread is the current_node's ancestor chain; branches not on it
  // are abandoned forks and are not part of the conversation the user read.
  let chain: string[] = [];
  const current = str(item.current_node);
  if (current && nodes.has(current)) {
    const seen = new Set<string>();
    let n: string | null = current;
    while (n && nodes.has(n) && !seen.has(n)) { seen.add(n); chain.push(n); n = nodes.get(n)!.parent; }
    chain.reverse();
  } else {
    chain = [...nodes.entries()]
      .filter(([, nd]) => nd.message)
      .sort((a, b) => Number((a[1].message as Record<string, unknown>).create_time ?? 0) - Number((b[1].message as Record<string, unknown>).create_time ?? 0))
      .map(([id]) => id);
  }
  const out: ImportMessage[] = [];
  for (const id of chain) {
    const msg = nodes.get(id)!.message;
    if (!msg) continue;
    const role = isObj(msg.author) ? str(msg.author.role) : "";
    if (role !== "user" && role !== "assistant") continue; // system/tool turns are scaffolding
    const content = isObj(msg.content) ? msg.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.map((p) => (typeof p === "string" ? p : isObj(p) ? str(p.text) : "")).filter(Boolean).join("\n").trim();
    if (!text) continue;
    out.push({ sender: role === "user" ? "human" : "assistant", text, at: isoFromEpochSeconds(msg.create_time) });
  }
  return out;
}

function parseChatGpt(items: unknown[]): ImportConversation[] {
  return items.map((item, i) => {
    if (!isObj(item) || !isObj(item.mapping)) {
      throw new ImportError(`ChatGPT export, conversation ${i + 1}: missing the mapping tree — the export format has changed or the file is damaged. Nothing was imported.`);
    }
    return {
      sourceId: str(item.conversation_id),
      title: str(item.title).trim() || "Untitled conversation",
      createdAt: isoFromEpochSeconds(item.create_time),
      updatedAt: isoFromEpochSeconds(item.update_time),
      messages: chatGptThread(item),
    };
  });
}

// ------------------------------------------------------------------ entry point: zip → parsed export
export function parseExportZip(bytes: Buffer): ParsedExport {
  if (bytes.length > MAX_ZIP_BYTES) {
    throw new ImportError(`That export is ${(bytes.length / 1048576).toFixed(1)} MB — the import limit is ${MAX_ZIP_BYTES / 1048576} MB. Split the export or contact support.`);
  }
  let entries;
  try {
    entries = readZip(bytes, { maxTotalUncompressed: MAX_TOTAL_UNCOMPRESSED, maxEntryUncompressed: MAX_ENTRY_UNCOMPRESSED });
  } catch (e) {
    if (e instanceof ZipError) throw new ImportError(e.message);
    throw e;
  }
  const candidates = entries
    .filter((e) => e.name.split("/").at(-1) === "conversations.json")
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  if (!candidates.length) {
    const names = entries.slice(0, 12).map((e) => e.name).join(", ");
    throw new ImportError(`No conversations.json in this ZIP (found: ${names || "nothing"}). Upload the unmodified export from Claude or ChatGPT.`);
  }
  let data: unknown;
  try { data = JSON.parse(candidates[0].data.toString("utf8")); }
  catch { throw new ImportError("conversations.json is not valid JSON — the export file is damaged. Download a fresh export and try again."); }
  if (!Array.isArray(data)) throw new ImportError("conversations.json is not a list of conversations — this does not look like a Claude or ChatGPT export.");
  if (!data.length) throw new ImportError("That export contains no conversations.");

  const claudeLike = data.filter((x) => isObj(x) && Array.isArray(x.chat_messages)).length;
  const gptLike = data.filter((x) => isObj(x) && isObj(x.mapping)).length;
  if (claudeLike > 0 && gptLike === 0) {
    return { format: "claude", formatLabel: "Claude", sourceTag: "import-claude", assistantName: "Claude", conversations: parseClaude(data) };
  }
  if (gptLike > 0 && claudeLike === 0) {
    return { format: "chatgpt", formatLabel: "ChatGPT", sourceTag: "import-chatgpt", assistantName: "ChatGPT", conversations: parseChatGpt(data) };
  }
  throw new ImportError("This conversations.json matches neither the Claude nor the ChatGPT export format. If the format has changed, tell us — the importer fails on purpose rather than guess at your history.");
}

// ------------------------------------------------------------------ rendering + dedupe
/**
 * Stable per-conversation key: a hash of the provider's own conversation id,
 * or — when the export carries none — of title + start + first message.
 * The hash is encoded LETTERS-ONLY (hex digits mapped to a–p) on purpose:
 * the dedupe marker rides inside the saved text, and the redaction scanner
 * eats long digit runs (a raw UUID's tail reads as a card number), which
 * would mangle the marker in storage and silently break dedupe.
 */
export function conversationKey(format: ImportFormat, c: ImportConversation): string {
  const material = c.sourceId.trim()
    ? `id:${c.sourceId.trim()}`
    : `t:${c.title}\n${c.createdAt ?? ""}\n${c.messages[0]?.text ?? ""}`;
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 40);
  const letters = [...hex].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join("");
  return `${format}:${letters}`;
}

const senderLabel = (p: ParsedExport, sender: string) =>
  sender === "human" ? "You" : sender === "assistant" ? p.assistantName : sender;

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** Render one conversation into one or more save-sized parts, each carrying its dedupe marker. */
export function renderParts(p: ParsedExport, c: ImportConversation): string[] {
  const key = conversationKey(p.format, c);
  const blocks = c.messages.map((m) => {
    const d = dayOf(m.at);
    return `${senderLabel(p, m.sender)}${d ? ` · ${d}` : ""}:\n${m.text}`;
  });
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const b of blocks) {
    if (b.length > PART_CHARS) { // a single enormous turn: hard-split it
      if (cur.length) { chunks.push(cur); cur = []; curLen = 0; }
      for (let i = 0; i < b.length; i += PART_CHARS) chunks.push([b.slice(i, i + PART_CHARS)]);
      continue;
    }
    if (curLen + b.length + 2 > PART_CHARS && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(b); curLen += b.length + 2;
  }
  if (cur.length) chunks.push(cur);
  if (!chunks.length) chunks.push([`(This conversation had no readable messages.)`]);
  const started = dayOf(c.createdAt);
  const updated = dayOf(c.updatedAt);
  return chunks.map((blocksInPart, i) => {
    const marker = `[scribe-import ${key}#${i + 1}of${chunks.length}]`;
    const head = [
      marker,
      "",
      `# ${c.title}`,
      `Imported from ${p.formatLabel}${started ? ` · chat started ${started}` : ""}${updated && updated !== started ? ` · last updated ${updated}` : ""}${chunks.length > 1 ? ` · part ${i + 1} of ${chunks.length}` : ""}`,
      "",
    ].join("\n");
    return head + blocksInPart.join("\n\n");
  });
}

// ------------------------------------------------------------------ the import run
export interface ImportReport {
  format: ImportFormat;
  format_label: string;
  conversations_total: number;
  imported: number;
  skipped_duplicates: number;
  failed: Array<{ title: string; error: string }>;
  redactions: number;
  note?: string;
}

export async function importHistory(
  db: Db,
  tenant: Tenant,
  plan: Plan,
  bytes: Buffer,
  alertTarget: AlertTarget | null,
): Promise<ImportReport> {
  const parsed = parseExportZip(bytes); // throws ImportError before anything is saved
  if (parsed.conversations.length > MAX_CONVERSATIONS) {
    throw new ImportError(`That export holds ${parsed.conversations.length} conversations — the per-import limit is ${MAX_CONVERSATIONS}. Nothing was imported.`);
  }
  const report: ImportReport = {
    format: parsed.format, format_label: parsed.formatLabel,
    conversations_total: parsed.conversations.length,
    imported: 0, skipped_duplicates: 0, failed: [], redactions: 0,
  };
  const category = `Imported from ${parsed.formatLabel}`;

  for (const conv of parsed.conversations) {
    const totalChars = conv.messages.reduce((n, m) => n + m.text.length, 0);
    if (totalChars > MAX_CONVERSATION_CHARS) {
      report.failed.push({ title: conv.title, error: `Conversation is too large to import (${totalChars.toLocaleString("en-US")} characters; limit ${MAX_CONVERSATION_CHARS.toLocaleString("en-US")}).` });
      continue;
    }
    try {
      const parts = renderParts(parsed, conv);
      // Redact before storage, exactly like save_memory (outside the tenant tx).
      const prepared = await Promise.all(parts.map((t) => prepareContent(t)));
      const outcome = await db.tenant(tenant.id, async (q) => {
        const key = conversationKey(parsed.format, conv);
        let savedAny = false;
        let redactions = 0;
        for (let i = 0; i < parts.length; i++) {
          const marker = `[scribe-import ${key}#${i + 1}of${parts.length}]`;
          const found = await q.query("SELECT 1 AS x FROM messages WHERE tenant_id = $1 AND position($2 IN text) > 0 LIMIT 1", [tenant.id, marker]);
          if (found.rows.length) continue; // this part is already in the vault
          const prep = prepared[i];
          const saved = await saveMemory(q, tenant.id, plan, { content: prep.text, source: parsed.sourceTag, category, tags: ["import", parsed.format] });
          redactions += prep.redactions;
          try {
            await new TenantLibrarian(q, tenant.id).fileSaved({ id: saved.message_id, text: saved.text, sender: parsed.sourceTag, source: parsed.sourceTag, conversationName: saved.conversation_name });
          } catch { /* filing is best-effort, exactly as in save_memory's error shape */ }
          await recordFlags(q, tenant.id, findingsToFlags(prep.findings, { source_ai: parsed.sourceTag, reporter: "server", message_id: saved.message_id }), alertTarget);
          savedAny = true;
        }
        return { savedAny, redactions };
      });
      report.redactions += outcome.redactions;
      if (outcome.savedAny) report.imported++;
      else report.skipped_duplicates++;
    } catch (e) {
      if (e instanceof LimitError) {
        report.failed.push({ title: conv.title, error: e.message });
        report.note = "Import stopped: your plan's storage limit was reached. Everything listed as imported is safely in your vault; upgrade and re-upload the same file to continue — already-imported conversations are skipped, not duplicated.";
        break;
      }
      report.failed.push({ title: conv.title, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
