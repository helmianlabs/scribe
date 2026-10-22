import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startSaas, signIn, api, connect, tool, type Saas } from "./helpers.ts";
import { sendMessage, checkInbox, markRead, listAgents, agentName, resolveSender } from "../src/postoffice/store.ts";

test("names normalize; identity falls back to the OAuth client name", () => {
  assert.equal(agentName("Claude AI"), "claude-ai");
  assert.equal(agentName("claude.ai"), "claude.ai");
  assert.equal(resolveSender(undefined, { clientName: "Muse" }), "muse");
  assert.equal(resolveSender("Paul", { clientName: "Muse" }), "paul");
  assert.throws(() => resolveSender(undefined, {}), /Say who you are/);
  assert.throws(() => resolveSender("all", {}), /reserved/);
});

test("self-host schema (no 005): send, inbox, broadcast, per-agent read state, threads, redaction", async () => {
  const pg = await freshDb({ saas: false });
  const q = { query: (s: string, p?: unknown[]) => pg.query(s, p as any[]) } as any;
  const muse = { clientId: "mcp-client-muse", clientName: "Muse" };
  const paul = { clientId: "mcp-client-paul", clientName: "Grok Bot" };
  const secret = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz";
  const m1 = await sendMessage(q, "self", { to: "paul", subject: "Migration 001", body: `Applied. key ${secret}`, from: "muse", priority: "high" }, muse);
  assert.equal(m1.message.from, "muse");
  assert.equal(m1.message.from_client, "Muse");
  assert.ok(!m1.message.body.includes(secret));
  assert.equal(m1.redactions, 1);
  await sendMessage(q, "self", { to: "all", subject: "Heads up", body: "KJV only from now on.", from: "paul" }, paul);
  await sendMessage(q, "self", { to: "all", subject: "Urgent", body: "Backfill paused.", from: "muse", priority: "urgent" }, muse);

  const inbox = await checkInbox(q, "self", { agent_name: "paul" }, paul);
  assert.equal(inbox.unread_total, 2, "own broadcast excluded");
  assert.deepEqual((inbox.messages as any[]).map((m) => m.subject), ["Urgent", "Migration 001"], "urgent first");

  const reply = await sendMessage(q, "self", { to: "muse", subject: "Re: Migration 001", body: "Thanks, starting backfill.", from: "paul", reply_to: m1.message.id }, paul);
  assert.equal(reply.message.thread_id, m1.message.id);

  const mr = await markRead(q, "self", { agent_name: "paul", message_ids: (inbox.messages as any[]).map((m) => m.id).concat([reply.message.id]) }, paul);
  assert.equal(mr.marked, 2, "cannot mark a message not addressed to you");
  assert.equal((await checkInbox(q, "self", { agent_name: "paul" }, paul)).unread_total, 0);
  const claude = await checkInbox(q, "self", { agent_name: "claude.ai" }, {});
  assert.equal(claude.unread_total, 2, "broadcasts stay unread for others");
  const all = await checkInbox(q, "self", { agent_name: "paul", unread_only: false }, paul);
  assert.equal((all.messages as any[]).length, 2);

  const agents = await listAgents(q, "self");
  assert.deepEqual((agents.agents as any[]).map((a) => a.name).sort(), ["claude.ai", "muse", "paul"]);

  // kept apart from memories: nothing landed in messages, nothing filed
  assert.equal((await pg.query<any>("SELECT count(*)::int AS n FROM messages")).rows[0].n, 1);
  assert.equal((await pg.query<any>("SELECT count(*)::int AS n FROM memory_filings")).rows[0].n, 0);
  await assert.rejects(sendMessage(q, "self", { to: "muse", subject: "x", body: "y", from: "paul", reply_to: 99999 }, paul), /No message/);
});

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

test("SaaS: AIs message each other over MCP, identity from the OAuth client, tenant isolated", async () => {
  const sam = await signIn(s, "sam@example.com");
  const me = (await api(s, sam)("/api/me")).body;
  const museTok = await connect(s, sam, me.mcp_url, { clientName: "Muse" });
  const claudeTok = await connect(s, sam, me.mcp_url, { clientName: "Claude" });

  const sent = await tool(me.mcp_url, museTok.access_token, "send_message", { to: "claude", subject: "Hi", body: "Please check the KJV PR." });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sent.data.message.from, "muse", "sender derived from the OAuth client name");

  const inbox = await tool(me.mcp_url, claudeTok.access_token, "check_inbox", {});
  assert.equal(inbox.data.agent, "claude");
  assert.equal(inbox.data.unread_total, 1);
  const id = inbox.data.messages[0].id;
  assert.equal((await tool(me.mcp_url, claudeTok.access_token, "mark_read", { message_ids: [id] })).data.marked, 1);
  assert.equal((await tool(me.mcp_url, claudeTok.access_token, "check_inbox", {})).data.unread_total, 0);

  const agents = await tool(me.mcp_url, claudeTok.access_token, "list_agents", {});
  const names = agents.data.agents.map((a: any) => a.name);
  assert.ok(names.includes("muse") && names.includes("claude"));

  // not a memory: search can't see it
  assert.equal((await tool(me.mcp_url, claudeTok.access_token, "search_memory", { query: "KJV" })).data.total, 0);

  // another tenant sees nothing
  const eve = await signIn(s, "eve@example.com");
  const eme = (await api(s, eve)("/api/me")).body;
  const eveTok = await connect(s, eve, eme.mcp_url, { clientName: "Claude" });
  assert.equal((await tool(eme.mcp_url, eveTok.access_token, "check_inbox", { agent_name: "claude", unread_only: false })).data.messages.length, 0);
  assert.equal((await tool(eme.mcp_url, eveTok.access_token, "mark_read", { message_ids: [id], agent_name: "claude" })).data.marked, 0);

  // read-only tokens can read mail but not send
  const ro = await connect(s, sam, me.mcp_url, { clientName: "Gemini", scope: "memory.read" });
  assert.equal((await tool(me.mcp_url, ro.access_token, "send_message", { to: "muse", subject: "x", body: "y" })).isError, true);
  assert.equal((await tool(me.mcp_url, ro.access_token, "check_inbox", { agent_name: "gemini" })).isError, false);
});
