/**
 * Scribe Courier (the Courier): connected AIs leave each other messages through the memory server.
 * Tenant scoped, append-only, and kept apart from memories (no Librarian, not searchable
 * with search_memory). Bodies are redacted by the Flags scanner before storage.
 */
import type { Q } from "../flags/store.js";
import { scanText } from "../flags/scanner.js";
import { canonicalMailbox, MAILBOXES } from "./mailboxes.js";

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
  const raw = agentName(declared) ?? agentName(id.clientName) ?? (id.clientId ? `client-${id.clientId.slice(-8)}` : null);
  const n = raw ? canonicalMailbox(raw) : null;
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
  const toRaw = agentName(p.to);
  const to = toRaw ? canonicalMailbox(toRaw) : null;
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
  await receipt(q, tenantId, r.rows.map((x: any) => Number(x.id)), me, "delivered");
  const out: Record<string, unknown> = { agent: me, unread_total: count.rows[0].n, returned: r.rows.length, messages: r.rows.map(row) };
  if (p.include_sent) {
    const s = await q.query("SELECT * FROM agent_messages WHERE tenant_id = $1 AND from_agent = $2 ORDER BY created_at DESC, id DESC LIMIT $3", [tenantId, me, lim]);
    const rc = await receiptsFor(q, tenantId, s.rows.map((x: any) => Number(x.id)));
    out.sent = s.rows.map((x: any) => ({ ...row(x), receipts: rc.get(Number(x.id)) ?? [] }));
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
  const marked = r.rows.map((x) => Number(x.message_id));
  await receipt(q, tenantId, await addressed(q, tenantId, ids, me), me, "read");
  return { agent: me, marked: marked.length, message_ids: marked };
}

// ---------------------------------------------------------------- receipts (door-knock)
export const RECEIPT_KINDS = ["delivered", "read", "ack"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/** Ids among `ids` that are addressed to `me` (directly or as a broadcast from someone else). */
async function addressed(q: Q, tenantId: string, ids: number[], me: string): Promise<number[]> {
  if (!ids.length) return [];
  const r = await q.query(
    `SELECT id FROM agent_messages WHERE tenant_id = $1 AND id = ANY($2::bigint[])
       AND (to_agent = $3 OR (to_agent = 'all' AND from_agent <> $3))`, [tenantId, ids, me]);
  return r.rows.map((x: any) => Number(x.id));
}

/** Append-only receipt rows. First one of each kind wins (ON CONFLICT DO NOTHING). */
async function receipt(q: Q, tenantId: string, ids: number[], agent: string, kind: ReceiptKind, note: string | null = null) {
  if (!ids.length) return;
  await q.query(
    `INSERT INTO agent_message_receipts (tenant_id, message_id, agent, kind, note)
     SELECT $1, x, $2, $3, $4 FROM unnest($5::bigint[]) AS x ON CONFLICT DO NOTHING`, [tenantId, agent, kind, note, ids]);
}

async function receiptsFor(q: Q, tenantId: string, ids: number[]) {
  const out = new Map<number, Array<{ agent: string; kind: string; at: string; note: string | null }>>();
  if (!ids.length) return out;
  const r = await q.query(
    `SELECT message_id, agent, kind, at, note FROM agent_message_receipts
     WHERE tenant_id = $1 AND message_id = ANY($2::bigint[]) ORDER BY at ASC`, [tenantId, ids]);
  for (const x of r.rows as any[]) {
    const k = Number(x.message_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push({ agent: x.agent, kind: x.kind, at: iso(x.at), note: x.note ?? null });
  }
  return out;
}

/** Read one message in full. Reading it as its addressee records a 'read' receipt (and the read state). */
export async function readMessage(q: Q, tenantId: string, p: { message_id: number; agent_name?: string }, id: Identity) {
  const me = resolveSender(p.agent_name, id);
  const r = await q.query("SELECT * FROM agent_messages WHERE tenant_id = $1 AND id = $2", [tenantId, p.message_id]);
  const m = r.rows[0];
  if (!m) throw new PostOfficeError(`No message ${p.message_id}.`);
  const mine = (await addressed(q, tenantId, [Number(m.id)], me)).length > 0;
  if (!mine && m.from_agent !== me) throw new PostOfficeError(`Message ${p.message_id} is not addressed to ${me}.`);
  if (mine) {
    await q.query(`INSERT INTO agent_message_reads (tenant_id, message_id, agent) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, m.id, me]);
    await receipt(q, tenantId, [Number(m.id)], me, "delivered");
    await receipt(q, tenantId, [Number(m.id)], me, "read");
  }
  const rc = await receiptsFor(q, tenantId, [Number(m.id)]);
  return { agent: me, message: { ...row(m), read: mine ? true : undefined }, receipts: rc.get(Number(m.id)) ?? [] };
}

/** Explicit acknowledgement ("got it, working on it"). Also counts as read. */
export async function ackMessage(q: Q, tenantId: string, p: { message_ids: number[]; agent_name?: string; note?: string }, id: Identity) {
  const me = resolveSender(p.agent_name, id);
  const ids = await addressed(q, tenantId, [...new Set(p.message_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200), me);
  const note = p.note ? scanText(p.note.slice(0, 500)).redacted : null;
  if (ids.length) {
    await q.query(
      `INSERT INTO agent_message_reads (tenant_id, message_id, agent) SELECT $1, x, $2 FROM unnest($3::bigint[]) AS x ON CONFLICT DO NOTHING`, [tenantId, me, ids]);
    await receipt(q, tenantId, ids, me, "read");
    await receipt(q, tenantId, ids, me, "ack", note);
  }
  return { agent: me, acked: ids.length, message_ids: ids };
}

/** Receipts on messages this agent sent (newest first). The sender's view of "did they get it?". */
export async function messageReceipts(q: Q, tenantId: string, p: { agent_name?: string; message_ids?: number[]; limit?: number }, id: Identity) {
  const me = resolveSender(p.agent_name, id);
  const lim = Math.min(Math.max(p.limit ?? 20, 1), 100);
  const r = p.message_ids?.length
    ? await q.query("SELECT * FROM agent_messages WHERE tenant_id = $1 AND from_agent = $2 AND id = ANY($3::bigint[]) ORDER BY id DESC", [tenantId, me, p.message_ids])
    : await q.query("SELECT * FROM agent_messages WHERE tenant_id = $1 AND from_agent = $2 ORDER BY id DESC LIMIT $3", [tenantId, me, lim]);
  const rc = await receiptsFor(q, tenantId, r.rows.map((x: any) => Number(x.id)));
  return {
    agent: me,
    sent: r.rows.map((x: any) => {
      const list = rc.get(Number(x.id)) ?? [];
      const status = list.some((e) => e.kind === "ack") ? "acked" : list.some((e) => e.kind === "read") ? "read" : list.some((e) => e.kind === "delivered") ? "delivered" : "waiting";
      return { id: Number(x.id), to: x.to_agent, subject: x.subject, created_at: iso(x.created_at), status, receipts: list };
    }),
  };
}

/**
 * Doorbell poll for ONE mailbox. Cheap: one indexed count + one small page.
 * `since_id` is the cursor: pass back `cursor` from the previous poll and `new`
 * lists only waiting messages with a larger id. Never returns bodies.
 */
export async function unreadSummary(q: Q, tenantId: string, agentRaw: string, sinceId = 0) {
  const a = agentName(agentRaw);
  if (!a || a === BROADCAST) throw new PostOfficeError("Pass a mailbox name, e.g. 'paul'.");
  const me = canonicalMailbox(a);
  const where = `m.tenant_id = $1 AND (m.to_agent = $2 OR (m.to_agent = 'all' AND m.from_agent <> $2))
       AND NOT EXISTS (SELECT 1 FROM agent_message_reads rd WHERE rd.tenant_id = m.tenant_id AND rd.message_id = m.id AND rd.agent = $2)`;
  const c = await q.query(`SELECT count(*)::int AS n, max(m.id) AS newest FROM agent_messages m WHERE ${where}`, [tenantId, me]);
  const fresh = await q.query(
    `SELECT m.id, m.from_agent, m.subject, m.priority, m.created_at FROM agent_messages m WHERE ${where} AND m.id > $3
     ORDER BY m.id ASC LIMIT 20`, [tenantId, me, Math.max(0, Math.floor(sinceId) || 0)]);
  const newest = c.rows[0].newest == null ? null : Number(c.rows[0].newest);
  const cursor = Math.max(Math.floor(sinceId) || 0, newest ?? 0, ...fresh.rows.map((x: any) => Number(x.id)));
  return {
    agent: me, unread_count: Number(c.rows[0].n), newest_id: newest, cursor,
    new: fresh.rows.map((x: any) => ({ id: Number(x.id), from: x.from_agent, subject: x.subject, priority: x.priority, created_at: iso(x.created_at) })),
  };
}

export interface CourierMailboxStatusEntry {
  /** Doorbell-compatible mailbox key: `for-${agent}`. */
  tag: string;
  agent: string;
  count: number;
  newest: {
    id: number;
    sender: string;
    created_at: string;
    subject: string;
  } | null;
}

/**
 * Tenant-scoped Courier status for the doorbell feed.
 *
 * A mailbox is one recipient agent in this tenant. "Waiting" is precise in
 * Courier: a message addressed to that agent — or a broadcast from another
 * agent — for which that agent has no row in agent_message_reads. The newest
 * field summarizes the newest waiting message, using its actual Courier
 * subject. Unlike the self-host memory-tag feed, there is no 14-day window:
 * explicit per-agent read state, not recency, defines whether mail waits.
 * Only mailboxes with waiting mail are returned.
 */
export async function courierMailboxStatus(q: Q, tenantId: string): Promise<CourierMailboxStatusEntry[]> {
  const r = await q.query(
    `WITH agents AS (
       SELECT DISTINCT name
       FROM agent_directory
       WHERE tenant_id = $1 AND name <> $2
     ),
     unread AS (
       SELECT recipient.name AS mailbox_agent,
              m.id,
              m.from_agent,
              m.created_at,
              m.subject
       FROM agents recipient
       JOIN agent_messages m
         ON m.tenant_id = $1
        AND (m.to_agent = recipient.name
             OR (m.to_agent = $2 AND m.from_agent <> recipient.name))
       WHERE NOT EXISTS (
         SELECT 1
         FROM agent_message_reads rd
         WHERE rd.tenant_id = m.tenant_id
           AND rd.message_id = m.id
           AND rd.agent = recipient.name
       )
     ),
     counts AS (
       SELECT mailbox_agent, count(*)::int AS count
       FROM unread
       GROUP BY mailbox_agent
     ),
     newest AS (
       SELECT DISTINCT ON (mailbox_agent)
              mailbox_agent, id, from_agent, created_at, subject
       FROM unread
       ORDER BY mailbox_agent, created_at DESC, id DESC
     )
     SELECT counts.mailbox_agent AS agent,
            counts.count,
            newest.id,
            newest.from_agent,
            newest.created_at,
            newest.subject
     FROM counts
     JOIN newest ON newest.mailbox_agent = counts.mailbox_agent
     ORDER BY counts.mailbox_agent ASC`, [tenantId, BROADCAST]);
  return r.rows.map((x) => ({
    tag: `for-${x.agent}`,
    agent: String(x.agent),
    count: Number(x.count),
    newest: {
      id: Number(x.id),
      sender: String(x.from_agent),
      created_at: iso(x.created_at),
      subject: String(x.subject),
    },
  }));
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
  return { agents: [...agents.values()], mailboxes: MAILBOXES.map((m) => ({ name: m.name, label: m.label, aliases: m.aliases, legacy_tag: m.legacyTag })), broadcast: BROADCAST, note: "Send to any name here, or to 'all'. A name that has never been used is created on first message." };
}
