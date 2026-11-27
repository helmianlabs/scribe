import type { MemoryItem } from './types.js';

const TAG_LINE = /^\s*\[tags:\s*([^\]]*)\]\s*(?:\r?\n|$)/i;
const NOTEBOOK = /^Shared Memory\s*[—–-]\s*(.+)$/i;

/** Tags from the leading `[tags: a, b]` line that save_memory writes. */
export function parseTags(text: string): string[] {
  const m = TAG_LINE.exec(text ?? '');
  if (!m) return [];
  return m[1].split(/[,;]/).map((t) => normalise(t)).filter(Boolean);
}

/** The text without the leading tags line. */
export function stripTagLine(text: string): string {
  return (text ?? '').replace(TAG_LINE, '');
}

/** "Shared Memory — muse" -> "muse". */
export function notebookLabel(conversationName?: string | null): string | null {
  if (!conversationName) return null;
  const m = NOTEBOOK.exec(conversationName.trim());
  return m ? normalise(m[1]) : null;
}

export function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

const CHAT_ROLES = new Set(['human', 'assistant', 'user', 'system']);

/**
 * Source = explicit field, else messages.sender when it names a writer (save_memory stores the
 * writing AI there, e.g. "muse"), else "claude-archive" for imported human/assistant chat turns.
 */
export function resolveSource(item: MemoryItem): string | null {
  if (item.source && item.source.trim()) return normalise(item.source);
  const s = item.sender ? normalise(item.sender) : '';
  if (s && !CHAT_ROLES.has(s)) return s;
  return s ? 'claude-archive' : null;
}
