/**
 * B2 canonical-line ports, SaaS surface (the self-host surface ports are
 * verbatim from the live box build; see the B2 port report):
 *  - read_memory (the "readtool" build) — full text by id, paged, tenant-scoped.
 *  - RFC 9207 `iss` on the authorize redirect (approve path).
 *  - /mailbox-status in SaaS mode is tenant-scoped: the caller's verified
 *    OAuth/API-key credential supplies the tenant, and Courier unread mail
 *    is counted only inside that tenant.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, api, connect, tool, type Saas } from "./helpers.ts";

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

test("read_memory returns the full text in pages", async () => {
  const alice = await signIn(s, "alice@example.com");
  const me = (await api(s, alice)("/api/me")).body;
  const tok = await connect(s, alice, me.mcp_url);
  const content = "FULLTEXT-MARKER " + "lorem ipsum dolor sit amet ".repeat(400); // ~10.8k chars
  const saved = await tool(me.mcp_url, tok.access_token, "save_memory", { content, source: "claude.ai" });
  assert.equal(saved.isError, false, saved.text);
  const id = saved.data.message_id;
  assert.ok(Number.isInteger(id));

  const found = await tool(me.mcp_url, tok.access_token, "search_memory", { query: "FULLTEXT-MARKER" });
  assert.equal(found.data.results[0].message_id, id);
  assert.ok(found.data.results[0].snippet.length <= 300, "search still returns snippets only");

  const page1 = await tool(me.mcp_url, tok.access_token, "read_memory", { message_id: id });
  assert.equal(page1.isError, false, page1.text);
  assert.equal(page1.data.text_length, content.length);
  assert.equal(page1.data.returned_chars, 8000);
  assert.equal(page1.data.next_offset, 8000);

  const page2 = await tool(me.mcp_url, tok.access_token, "read_memory", { message_id: id, offset: page1.data.next_offset });
  assert.equal(page2.data.next_offset, null);
  assert.equal(page1.data.text + page2.data.text, content, "pages reassemble into the full text");

  const missing = await tool(me.mcp_url, tok.access_token, "read_memory", { message_id: 99999999 });
  assert.match(String(missing.data.error ?? ""), /No message found/);
});

test("read_memory cannot cross tenants", async () => {
  const alice = await signIn(s, "alice2@example.com");
  const aMe = (await api(s, alice)("/api/me")).body;
  const aTok = await connect(s, alice, aMe.mcp_url);
  const saved = await tool(aMe.mcp_url, aTok.access_token, "save_memory", { content: "alice-only note", source: "claude.ai" });
  assert.equal(saved.isError, false, saved.text);
  const id = saved.data.message_id;

  const bob = await signIn(s, "bob@example.com");
  const bMe = (await api(s, bob)("/api/me")).body;
  const bTok = await connect(s, bob, bMe.mcp_url);
  const stolen = await tool(bMe.mcp_url, bTok.access_token, "read_memory", { message_id: id });
  assert.match(String(stolen.data.error ?? ""), /No message found/, "another tenant's id reads as missing, never as data");
});

test("authorize redirect carries the RFC 9207 iss parameter", async () => {
  const carol = await signIn(s, "carol@example.com");
  const me = (await api(s, carol)("/api/me")).body;
  const tok = await connect(s, carol, me.mcp_url);
  const back = new URL(tok.redirectUrl);
  assert.equal(back.searchParams.get("iss"), s.base);
  assert.equal(back.searchParams.get("state"), "st8");
});

test("SaaS /mailbox-status rejects unauthenticated calls", async () => {
  const missing = await fetch(`${s.base}/mailbox-status`);
  assert.equal(missing.status, 401);
  const bogus = await fetch(`${s.base}/mailbox-status`, { headers: { Authorization: "Bearer anything" } });
  assert.equal(bogus.status, 401);
});

test("SaaS /mailbox-status returns only the caller's tenant Courier unread counts", async () => {
  const status = async (token: string) => {
    const r = await fetch(`${s.base}/mailbox-status`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json();
    return { status: r.status, body, byAgent: new Map<string, any>((body.mailboxes ?? []).map((m: any) => [m.agent, m])) };
  };

  // Tenant A: direct mail for Claude and Gemini, then a Claude broadcast.
  const alice = await signIn(s, "mailbox-alice@example.com");
  const aMe = (await api(s, alice)("/api/me")).body;
  const aMuse = await connect(s, alice, aMe.mcp_url, { clientName: "Muse" });
  const aClaude = await connect(s, alice, aMe.mcp_url, { clientName: "Claude" });
  await tool(aMe.mcp_url, aMuse.access_token, "send_message", { to: "claude", subject: "A-CLAUDE-WAITING", body: "Tenant A direct mail." });
  await tool(aMe.mcp_url, aMuse.access_token, "send_message", { to: "gemini", subject: "A-GEMINI-WAITING", body: "Tenant A direct mail." });
  await tool(aMe.mcp_url, aClaude.access_token, "send_message", { to: "all", subject: "A-BROADCAST-WAITING", body: "Tenant A broadcast." });

  // Tenant B: same recipient names, different subjects. None may appear in A.
  const bob = await signIn(s, "mailbox-bob@example.com");
  const bMe = (await api(s, bob)("/api/me")).body;
  const bMuse = await connect(s, bob, bMe.mcp_url, { clientName: "Muse" });
  await tool(bMe.mcp_url, bMuse.access_token, "send_message", { to: "claude", subject: "B-ONLY-CLAUDE", body: "Tenant B direct mail." });
  await tool(bMe.mcp_url, bMuse.access_token, "send_message", { to: "gemini", subject: "B-ONLY-GEMINI", body: "Tenant B direct mail." });

  const a = await status(aMuse.access_token);
  assert.equal(a.status, 200);
  assert.ok(a.body.generated_at);
  assert.equal(a.byAgent.get("claude")?.count, 1, "Claude's own broadcast is not waiting for Claude");
  assert.equal(a.byAgent.get("claude")?.newest.subject, "A-CLAUDE-WAITING");
  assert.equal(a.byAgent.get("gemini")?.count, 2, "direct mail plus another agent's broadcast");
  assert.equal(a.byAgent.get("gemini")?.newest.subject, "A-BROADCAST-WAITING");
  assert.equal(a.byAgent.get("muse")?.count, 1, "the broadcast is waiting for Muse");
  assert.equal(a.byAgent.get("muse")?.newest.subject, "A-BROADCAST-WAITING");
  assert.ok(!JSON.stringify(a.body).includes("B-ONLY"), "tenant B subjects never cross into tenant A");

  const b = await status(bMuse.access_token);
  assert.equal(b.status, 200);
  assert.equal(b.byAgent.get("claude")?.count, 1);
  assert.equal(b.byAgent.get("claude")?.newest.subject, "B-ONLY-CLAUDE");
  assert.equal(b.byAgent.get("gemini")?.count, 1);
  assert.equal(b.byAgent.get("gemini")?.newest.subject, "B-ONLY-GEMINI");
  assert.ok(!JSON.stringify(b.body).includes("A-"), "tenant A subjects never cross into tenant B");

  // The same tenant can be reached with a dedicated mailbox.read API key;
  // a Flags-only key is not a mailbox credential.
  const aKey = await api(s, alice)("/api/keys", { method: "POST", body: JSON.stringify({ name: "Doorbell", scopes: ["mailbox.read"] }) });
  assert.equal(aKey.status, 201);
  assert.deepEqual(aKey.body.scopes, ["mailbox.read"]);
  const viaKey = await status(aKey.body.key);
  assert.equal(viaKey.status, 200);
  assert.equal(viaKey.byAgent.get("gemini")?.count, 2);
  const bFlagsKey = await api(s, bob)("/api/keys", { method: "POST", body: JSON.stringify({ name: "Flags only", scopes: ["flags.read"] }) });
  assert.equal(bFlagsKey.status, 201);
  assert.equal((await status(bFlagsKey.body.key)).status, 401);

  // Courier read state drives the count: once Claude reads its direct mail,
  // Claude's mailbox disappears while the other tenant A mailboxes remain.
  const inbox = await tool(aMe.mcp_url, aClaude.access_token, "check_inbox", {});
  const direct = inbox.data.messages.find((m: any) => m.subject === "A-CLAUDE-WAITING");
  assert.ok(direct, "Claude inbox contains the direct message");
  await tool(aMe.mcp_url, aClaude.access_token, "mark_read", { message_ids: [direct.id] });
  const afterRead = await status(aMuse.access_token);
  assert.equal(afterRead.byAgent.has("claude"), false);
  assert.equal(afterRead.byAgent.get("gemini")?.count, 2);
});
