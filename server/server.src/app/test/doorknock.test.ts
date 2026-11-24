import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, sql, startSaas, signIn, api, connect, tool, type Saas } from "./helpers.ts";
import { sendMessage, checkInbox, markRead, readMessage, ackMessage, messageReceipts, unreadSummary, resolveSender } from "../src/courier/store.ts";
import { canonicalMailbox, mailboxFromCategory, isMailboxCategory, MAILBOXES } from "../src/courier/mailboxes.ts";

test("mailbox directory: aliases and FOR: X map to canonical names", () => {
  assert.equal(canonicalMailbox("grok-bot"), "paul");
  assert.equal(canonicalMailbox("claude-code"), "claude-pc");
  assert.equal(canonicalMailbox("claude-ai"), "claude.ai");
  assert.equal(resolveSender("Claude AI", {}), "claude.ai");
  assert.equal(mailboxFromCategory("for-muse"), "muse");
  assert.equal(mailboxFromCategory("FOR: Faith and Light News"), "muse");
  assert.equal(mailboxFromCategory("helmian"), null);
  assert.ok(isMailboxCategory("for-muse") && !isMailboxCategory("helmian"));
  assert.equal(new Set(MAILBOXES.map((m) => m.name)).size, MAILBOXES.length);
});

test("006 is idempotent: running it twice is a no-op", async () => {
  const pg = await freshDb({ saas: false });
  await pg.exec(sql("006_courier.sql"));
  await pg.exec(sql("006_courier.sql"));
  const t = await pg.query<any>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'agent_%'");
  assert.equal(t.rows[0].n, 4);
  await pg.exec(sql("006_courier.down.sql"));
  assert.equal((await pg.query<any>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'agent_%'")).rows[0].n, 0);
  assert.equal((await pg.query<any>("SELECT count(*)::int AS n FROM messages")).rows[0].n, 1, "memories untouched by rollback");
});

test("doorbell poll, cursor, auto receipts and ack", async () => {
  const pg = await freshDb({ saas: false });
  const q = { query: (s: string, p?: unknown[]) => pg.query(s, p as any[]) } as any;
  const paul = { clientName: "Grok Bot" };
  const a = await sendMessage(q, "self", { to: "muse", subject: "One", body: "b1", from: "paul" }, paul);
  let s = await unreadSummary(q, "self", "Muse");
  assert.equal(s.unread_count, 1); assert.equal(s.newest_id, a.message.id); assert.equal(s.new.length, 1);
  assert.ok(!("body" in s.new[0]), "no bodies in the poll");
  const cur = s.cursor;
  assert.equal((await unreadSummary(q, "self", "muse", cur)).new.length, 0, "nothing new since cursor");
  const b = await sendMessage(q, "self", { to: "faith-and-light-news", subject: "Two", body: "b2", from: "grok-bot" }, paul);
  assert.equal(b.message.to, "muse"); assert.equal(b.message.from, "paul");
  s = await unreadSummary(q, "self", "muse", cur);
  assert.equal(s.unread_count, 2); assert.deepEqual(s.new.map((x) => x.id), [b.message.id]);

  assert.deepEqual((await messageReceipts(q, "self", { agent_name: "paul" }, paul)).sent.map((x) => x.status), ["waiting", "waiting"]);
  await checkInbox(q, "self", { agent_name: "muse" }, {});
  assert.deepEqual((await messageReceipts(q, "self", { agent_name: "paul" }, paul)).sent.map((x) => x.status), ["delivered", "delivered"]);
  const r = await readMessage(q, "self", { message_id: a.message.id, agent_name: "muse" }, {});
  assert.equal(r.message.body, "b1");
  await ackMessage(q, "self", { message_ids: [b.message.id], agent_name: "muse", note: "got it" }, {});
  const rc = await messageReceipts(q, "self", { agent_name: "paul" }, paul);
  assert.deepEqual(rc.sent.map((x) => x.status), ["acked", "read"]);
  assert.equal(rc.sent[0].receipts.find((e) => e.kind === "ack")?.note, "got it");
  assert.equal((await unreadSummary(q, "self", "muse")).unread_count, 0);
  await assert.rejects(readMessage(q, "self", { message_id: a.message.id, agent_name: "gemini" }, {}), /not addressed/);
  await markRead(q, "self", { message_ids: [a.message.id], agent_name: "muse" }, {}); // idempotent
});

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

test("SaaS: GET /mailbox/unread is token-gated, tenant-scoped and has no bodies", async () => {
  const sam = await signIn(s, "sam2@example.com");
  const me = (await api(s, sam)("/api/me")).body;
  const muse = await connect(s, sam, me.mcp_url, { clientName: "Muse" });
  const paul = await connect(s, sam, me.mcp_url, { clientName: "Paul" });
  const sent = await tool(me.mcp_url, paul.access_token, "send_message", { to: "muse", subject: "Knock", body: "secret body" });
  assert.equal(sent.isError, false, sent.text);
  const base = me.mcp_url.replace(/\/mcp.*$/, "").replace(/\/t\/[^/]+$/, "");
  const origin = new URL(me.mcp_url).origin;
  assert.equal((await fetch(`${origin}/mailbox/unread?agent=muse`)).status, 401);
  const res = await fetch(`${origin}/mailbox/unread?agent=muse`, { headers: { authorization: `Bearer ${muse.access_token}` } });
  assert.equal(res.status, 200, base);
  const j = await res.json();
  assert.equal(j.unread_count, 1); assert.equal(j.newest_id, sent.data.message.id);
  assert.ok(!JSON.stringify(j).includes("secret body"));
  await tool(me.mcp_url, paul.access_token, "save_memory", { content: "FOR: Muse\nfor-muse legacy letter", source: "paul" });
  const lj = await (await fetch(`${origin}/mailbox/unread?agent=muse&include_legacy=1`, { headers: { authorization: `Bearer ${muse.access_token}` } })).json();
  assert.equal(lj.legacy.recent_count, 1, JSON.stringify(lj));
  const st = await tool(me.mcp_url, muse.access_token, "inbox_status", {});
  assert.equal(st.data.unread_count, 1);
  const rd = await tool(me.mcp_url, muse.access_token, "read_message", { message_id: sent.data.message.id });
  assert.equal(rd.isError, false, rd.text);
  const rc = await tool(me.mcp_url, paul.access_token, "message_receipts", {});
  assert.equal(rc.data.sent[0].status, "read");
  const eve = await signIn(s, "eve2@example.com");
  const eme = (await api(s, eve)("/api/me")).body;
  const eveTok = await connect(s, eve, eme.mcp_url, { clientName: "Muse" });
  const ej = await (await fetch(`${origin}/mailbox/unread?agent=muse`, { headers: { authorization: `Bearer ${eveTok.access_token}` } })).json();
  assert.equal(ej.unread_count, 0, "other tenant sees nothing");
});

test("SaaS: /mailbox/unread answers 503 courier_not_installed when the tables are missing", async () => {
  const s2 = await startSaas();
  try {
    const sam = await signIn(s2, "sam3@example.com");
    const me = (await api(s2, sam)("/api/me")).body;
    const tok = await connect(s2, sam, me.mcp_url, { clientName: "Muse" });
    await s2.pg.exec("DROP TABLE agent_message_receipts, agent_message_reads, agent_messages CASCADE");
    const r = await fetch(`${new URL(me.mcp_url).origin}/mailbox/unread?agent=muse`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "courier_not_installed");
  } finally { await s2.close(); }
});
