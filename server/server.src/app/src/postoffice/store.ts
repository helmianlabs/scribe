/**
 * Post office: connected AIs leave each other messages through the memory server.
 * Tenant scoped, append-only, and kept apart from memories (no Librarian, not searchable
 * with search_memory). Bodies are redacted by the Flags scanner before storage.
 */
import type { Q } from "../flags/store.js";
import { scanText } from "../flags/scanner.js";

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const BROADCAST = "all";

export class PostOfficeError extends Error {}

/** 'Claude AI' -> 'claude-ai', 'claude.ai' stays. */
export function agentName(raw: string | null | undefined): string | null {
  const n = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "").slice(0, 40);
  return n || null;
}

export interface Identity {
  /** OAuth client that holds the token (server-known, not self-declared) */
  clientId?: string | null;
  clientName?: string | null;
}

/** Name to use: the self-declared one, else one derived from the OAuth client name. */
export function resolveSender(declared: string | undefined, id: Identity): string {
  const n = agentName(declared) ?? agentName(id.clientName) ?? (id.clientId ? `client-${id.clientId.slice(-8)}` : null);
  if (!n) throw new PostOfficeError("Say who you are: pass 'from' (e.g. 'paul', 'muse', 'claude.ai').");
  if (n === BROADCAST) throw new PostOfficeError("'all' is reserved for broadcasts.");
  return n;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));
const row = (r: any) => ({
  id: Number(r.id), thread_id: Number(r.thread_id ?? r.id), reply_to: r.reply_to == null ? null : Number(r.reply_to),
  from: r.from_agent, from_client: r.from_client_name ?? null, to: r.to_agent, subject: r.subject, body: r.body,
  priority: r.priority, created_at: iso(r.created_at), ...(r.read_at !== undefined ? { read: r.read_at != null } : {}),
});

async function remember(q: Q, tenantId: string, name: string, id: Identity) {
  await q.query(
    "INSERT INTO agent_directory (tenant_id, name, client_id, client_name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [tenantId, name, id.clientId ?? "", id.clientName ?? null]);
}

export interface SendParams { to: string; subject: string; body: string; from?: string; reply_to?: number; thread_id?: number; priority?: Priority; }

export async function sendMessage(q: Q, tenantId: string, p: SendParams, id: Identity) {
  const from = resolveSender(p.from, id);
  const to = agentName(p.to);
  if (!to) throw new PostOfficeError("'to' must be an agent name or 'all'.");
  const priority: Priority = PRIORITIES.includes(p.priority as Priority) ? (p.priority as Priority) : "normal";
  let thread: number | null = p.thread_id ?? null;
  if (p.reply_to) {
    const parent = await q.query("SELECT id, thread_id FROM agent_messages WHERE tenant_id = $1 AND id = $2", [tenantId, p.reply_to]);
    if (!parent.rows[0]) throw new PostOfficeError(`No message ${p.reply_to} to reply to.`);
    thread = Number(parent.rows[0].thread_id ?? parent.rows[0].id);
  } else if (thread) {
    const t = await q.query("SELECT 1 FROM agent_messages WHERE tenant_id = $1 AND id = $2", [tenantId, thread]);
    if (!t.rows[0]) throw new PostOfficeError(`No thread ${thread}.`);
  }
  const subj = scanText(p.subject.slice(0, 200));
  const body = scanText(p.body.slice(0, 20000));
  const r = await q.query(
    `INSERT INTO agent_messages (tenant_id, thread_id, reply_to, from_agent, from_client_id, from_client_name, to_agent, subject, body, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, thread, p.reply_to ?? null, from, id.clientId ?? null, id.clientName ?? null, to, subj.redacted, body.redacted, priority]);
  await remember(q, tenantId, from, id);
  if (to !== BROADCAST) await remember(q, tenantId, to, {});
  const findings = [...subj.findings, ...body.findings].filter((f) => f.category === "secret" || f.category === "pii" || f.category === "harmful_code");
  return { sent: true, message: row(r.rows[0]), redactions: subj.redactions + body.redactions, findings };
}

export async function checkInbox(q: Q, tenantId: string, p: { agent_name?: string; unread_only?: boolean; limit?: number; include_sent?: boolean }, id: Identity) {
  const me = resolveSender(p.agent_name, id);
  await remember(q, tenantId, me, id);
  const unread = p.unread_only !== false;
  const lim = Math.min(Math.max(p.limit ?? 20, 1), 100);
  const r = await q.query(
    `SELECT m.*, rd.read_at FROM agent_messages m
     LEFT JOIN agent_message_reads rd ON rd.tenant_id = m.tenant_id AND rd.message_id = m.id AND rd.agent = $2
     WHERE m.tenant_id = $1 AND (m.to_agent = $2 OR (m.to_agent = 'all' AND m.from_agent <> $2))
       ${unread ? "AND rd.read_at IS NULL" : ""}
     ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at ASC, m.id ASC
     LIMIT $3`, [tenantId, me, lim]);
  const count = await q.query(
    `SELECT count(*)::int AS n FROM agent_messages m
     WHERE m.tenant_id = $1 AND (m.to_agent = $2 OR (m.to_agent = 'all' AND m.from_agent <> $2))
       AND NOT EXISTS (SELECT 1 FROM agent_message_reads rd WHERE rd.tenant_id = m.tenant_id AND rd.message_id = m.id AND rd.agent = $2)`, [tenantId, me]);
  const out: Record<string, unknown> = { agent: me, unread_total: count.rows[0].n, returned: r.rows.length, messages: r.rows.map(row) };
  if (p.include_sent) {
    const s = await q.query("SELECT * FROM agent_messages WHERE tenant_id = $1 AND from_agent = $2 ORDER BY created_at DESC, id DESC LIMIT $3", [tenantId, me, lim]);
    out.sent = s.rows.map(row);
  }
  out.hint = "Call mark_read with the ids you have handled. Reply with send_message(reply_to=<id>).";
  return out;
}

export async function markRead(q: Q, tenantId: string, p: { message_ids: number[]; agent_name?: string }, id: Identity) {
  const me = resolveSender(p.agent_name, id);
  const ids = [...new Set(p.message_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) return { agent: me, marked: 0 };
  // Only messages actually addressed to this agent (or broadcast) can be marked.
  const r = await q.query(
    `INSERT INTO agent_message_reads (tenant_id, message_id, agent)
     SELECT $1, m.id, $2 FROM agent_messages m
     WHERE m.tenant_id = $1 AND m.id = ANY($3::bigint[]) AND (m.to_agent = $2 OR m.to_agent = 'all')
     ON CONFLICT DO NOTHING RETURNING message_id`, [tenantId, me, ids]);
  return { agent: me, marked: r.rows.length, message_ids: r.rows.map((x) => Number(x.message_id)) };
}

export async function listAgents(q: Q, tenantId: string, extra: Array<{ name: string; client_id?: string; client_name?: string | null }> = []) {
  const r = await q.query(
    `SELECT d.name, array_remove(array_agg(DISTINCT NULLIF(d.client_name, '')), NULL) AS clients, min(d.first_seen) AS first_seen,
            (SELECT max(created_at) FROM agent_messages m WHERE m.tenant_id = d.tenant_id AND m.from_agent = d.name) AS last_sent
     FROM agent_directory d WHERE d.tenant_id = $1 GROUP BY d.tenant_id, d.name ORDER BY d.name`, [tenantId]);
  const agents = new Map<string, any>();
  for (const x of r.rows) agents.set(x.name, { name: x.name, clients: x.clients ?? [], first_seen: iso(x.first_seen), last_sent: x.last_sent ? iso(x.last_sent) : null });
  for (const e of extra) {
    const n = agentName(e.name);
    if (n && !agents.has(n)) agents.set(n, { name: n, clients: e.client_name ? [e.client_name] : [], first_seen: null, last_sent: null, connected_only: true });
  }
  return { agents: [...agents.values()], broadcast: BROADCAST, note: "Send to any name here, or to 'all'. A name that has never been used is created on first message." };
}
