/**
 * Mailbox directory: the canonical recipient names for Scribe Courier, plus the
 * aliases people and AIs actually type. Also maps the legacy letter convention
 * (a memory saved with category / tag `for-<x>`, or a "FOR: X" first line) onto
 * the same names, so the doorbell and receipts speak one vocabulary.
 */
export interface Mailbox { name: string; label: string; aliases: string[]; legacyTag: string }

const M = (name: string, label: string, aliases: string[]): Mailbox => ({ name, label, aliases, legacyTag: `for-${name}` });

export const MAILBOXES: readonly Mailbox[] = [
  M("troy", "Troy (human owner)", ["owner", "troy-halter"]),
  M("paul", "Paul (Grok Bot)", ["grok-bot", "grokbot", "grokbot-paul", "grok-bot-paul"]),
  M("muse", "Muse (Faith and Light News)", ["faith-and-light-news", "faith-n-light", "news"]),
  M("claude-pc", "Claude on Troy's PC (Claude Code / Desktop)", ["claude-code", "claude-desktop", "claudepc", "claude-on-pc"]),
  M("claude.ai", "Claude in the browser (claude.ai)", ["claude-ai", "claudeai"]),
  M("chatgpt", "ChatGPT", ["gpt", "openai", "chat-gpt"]),
  M("gemini", "Gemini", ["google-gemini", "bard"]),
  M("grok", "Grok (x.ai / X app)", ["grok-x", "xai"]),
  M("mistral", "Mistral (Le Chat)", ["le-chat", "lechat"]),
  M("social", "Social teammate", ["social-bot"]),
  M("youtube", "YouTube teammate", ["yt"]),
  M("sites", "Sites teammate", ["site", "websites"]),
  M("helmian", "Helmian teammate", ["helmian-bot"]),
  M("guard", "Helmian Guard teammate", ["helmian-guard", "helium-guard"]),
  M("writer", "Writer teammate", ["writer-bot"]),
];

const byKey = new Map<string, string>();
for (const m of MAILBOXES) { byKey.set(m.name, m.name); for (const a of m.aliases) byKey.set(a, m.name); }

/** Canonical mailbox for an already-slugged name; unknown names pass through unchanged. */
export function canonicalMailbox(slug: string): string { return byKey.get(slug) ?? slug; }

/** 'for-muse' / 'FOR: Claude AI' / 'for-claude' -> canonical mailbox, or null. */
export function mailboxFromCategory(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = /^for[-:\s]+\s*(.+)$/.exec(s);
  if (!m) return null;
  const slug = m[1].trim().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  return slug ? canonicalMailbox(slug) : null;
}

/** True for a mailbox category such as 'for-muse'. Manual moves into these must not teach the Librarian rules. */
export function isMailboxCategory(cat: string | null | undefined): boolean { return /^for-[a-z0-9._-]+$/i.test(String(cat ?? "").trim()); }
