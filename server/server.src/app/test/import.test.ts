/**
 * B5 — history import (SaaS mode):
 *  - POST /api/import takes a Claude.ai or ChatGPT export .zip (session auth,
 *    tenant from the session only) and files every conversation into the
 *    caller's vault through the normal save pipeline.
 *  - Re-uploading the same export is idempotent (per-conversation dedupe key).
 *  - Imports are tenant-isolated in search AND read.
 *  - Malformed / unknown-shape files are rejected with nothing imported.
 * Fixtures are synthetic, shaped to the two real export formats.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { startSaas, signIn, upgrade, api, connect, tool, type Saas } from "./helpers.ts";
import { crc32 } from "../src/saas/zip.ts";

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

// ------------------------------------------------------------ tiny zip writer (fixtures)
function makeZip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8 }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const method = e.method ?? 0;
    const stored = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ------------------------------------------------------------ fixtures (synthetic)
const CLAUDE_EXPORT = JSON.stringify([
  {
    uuid: "11111111-2222-3333-4444-555555555555",
    name: "Visa gift card plan",
    summary: "",
    created_at: "2025-01-05T09:00:00.000000Z",
    updated_at: "2025-01-06T09:00:00.000000Z",
    account: { uuid: "acct-1" },
    chat_messages: [
      { uuid: "m1", text: "CLAUDE-MARKER-HUMAN how do I use a gift card?", sender: "human", created_at: "2025-01-05T09:00:00.000000Z", attachments: [], files: [] },
      { uuid: "m2", text: "CLAUDE-MARKER-ASSISTANT here is the plan.", sender: "assistant", created_at: "2025-01-05T09:01:00.000000Z", attachments: [], files: [] },
    ],
  },
  {
    uuid: "66666666-7777-8888-9999-000000000000",
    name: "Block style chat",
    created_at: "2025-02-01T10:00:00.000000Z",
    updated_at: "2025-02-01T10:05:00.000000Z",
    account: { uuid: "acct-1" },
    chat_messages: [
      { uuid: "m3", sender: "human", created_at: "2025-02-01T10:00:00.000000Z", content: [{ type: "text", text: "CLAUDE-BLOCKS-QUESTION" }] },
      { uuid: "m4", sender: "assistant", created_at: "2025-02-01T10:01:00.000000Z", content: [{ type: "text", text: "CLAUDE-BLOCKS-ANSWER" }] },
    ],
  },
]);

const GPT_NODE = (id: string, role: string | null, text: string, t: number, parent: string | null, children: string[]) => ({
  id,
  message: role === null ? null : { id: `${id}-msg`, author: { role, name: null, metadata: {} }, create_time: t, update_time: null, content: { content_type: "text", parts: [text] }, status: "finished_successfully", end_turn: true, weight: 1, metadata: {}, recipient: "all" },
  parent, children,
});
const CHATGPT_EXPORT = JSON.stringify([
  {
    title: "Tractor maintenance",
    create_time: 1700000000,
    update_time: 1700003600,
    conversation_id: "gpt-conv-0001",
    current_node: "a2",
    mapping: {
      root: GPT_NODE("root", null, "", 0, null, ["sys"]),
      sys: GPT_NODE("sys", "system", "", 1700000000, "root", ["u1"]),
      u1: GPT_NODE("u1", "user", "GPT-QUESTION-UNIQUE", 1700000010, "sys", ["a1", "a1alt"]),
      a1: GPT_NODE("a1", "assistant", "GPT-ANSWER-UNIQUE", 1700000020, "u1", ["u2"]),
      a1alt: GPT_NODE("a1alt", "assistant", "GPT-ABANDONED-BRANCH", 1700000025, "u1", []),
      u2: GPT_NODE("u2", "user", "GPT-FOLLOWUP-UNIQUE", 1700000030, "a1", ["a2"]),
      a2: GPT_NODE("a2", "assistant", "GPT-FINAL-ANSWER", 1700000040, "u2", []),
    },
  },
]);

const claudeZip = () => makeZip([
  { name: "users.json", data: Buffer.from(JSON.stringify([{ uuid: "acct-1", email_address: "someone@example.com" }])) },
  { name: "conversations.json", data: Buffer.from(CLAUDE_EXPORT) }, // stored
]);
const chatgptZip = () => makeZip([
  { name: "user.json", data: Buffer.from(JSON.stringify({ id: "user-1" })) },
  { name: "conversations.json", data: Buffer.from(CHATGPT_EXPORT), method: 8 }, // deflated
]);

async function upload(cookie: string | null, bytes: Buffer) {
  const r = await fetch(`${s.base}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "X-Requested-With": "test", Origin: s.base, ...(cookie ? { Cookie: cookie } : {}) },
    body: bytes,
  });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}

async function mcpFor(cookie: string) {
  const me = (await api(s, cookie)("/api/me")).body;
  const tok = await connect(s, cookie, me.mcp_url);
  return { me, url: me.mcp_url as string, token: tok.access_token as string };
}

// ------------------------------------------------------------ tests
test("Claude export imports end to end and is searchable + readable", async () => {
  const alice = await signIn(s, "imp-alice@example.com");
  await upgrade(s, alice);
  const up = await upload(alice, claudeZip());
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.format, "claude");
  assert.equal(up.body.conversations_total, 2);
  assert.equal(up.body.imported, 2);
  assert.equal(up.body.skipped_duplicates, 0);
  assert.deepEqual(up.body.failed, []);

  const { url, token } = await mcpFor(alice);
  const found = await tool(url, token, "search_memory", { query: "CLAUDE-MARKER-HUMAN" });
  assert.equal(found.isError, false, found.text);
  assert.equal(found.data.total, 1);
  assert.equal(found.data.results[0].sender, "import-claude");
  assert.equal(found.data.results[0].conversation_name, "Shared Memory — Imported from Claude");

  const full = await tool(url, token, "read_memory", { message_id: found.data.results[0].message_id });
  assert.equal(full.isError, false, full.text);
  assert.match(full.data.text, /# Visa gift card plan/);
  assert.match(full.data.text, /Imported from Claude · chat started 2025-01-05/);
  assert.match(full.data.text, /You · 2025-01-05:/);
  assert.match(full.data.text, /CLAUDE-MARKER-ASSISTANT here is the plan\./);

  // The content-blocks-only conversation (newer export shape) parsed too.
  const blocks = await tool(url, token, "search_memory", { query: "CLAUDE-BLOCKS-ANSWER" });
  assert.equal(blocks.data.total, 1);
});

test("re-uploading the same export imports nothing twice", async () => {
  const alice = await signIn(s, "imp-alice2@example.com");
  await upgrade(s, alice);
  const first = await upload(alice, claudeZip());
  assert.equal(first.body.imported, 2);
  const meBefore = (await api(s, alice)("/api/me")).body;

  const second = await upload(alice, claudeZip());
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.skipped_duplicates, 2);
  const meAfter = (await api(s, alice)("/api/me")).body;
  assert.equal(meAfter.usage.memories, meBefore.usage.memories, "no duplicate memories were stored");
});

test("ChatGPT export imports the live thread only (abandoned branch excluded)", async () => {
  const carol = await signIn(s, "imp-carol@example.com");
  await upgrade(s, carol);
  const up = await upload(carol, chatgptZip());
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.format, "chatgpt");
  assert.equal(up.body.imported, 1);
  assert.deepEqual(up.body.failed, []);

  const { url, token } = await mcpFor(carol);
  const found = await tool(url, token, "search_memory", { query: "GPT-ANSWER-UNIQUE" });
  assert.equal(found.data.total, 1);
  assert.equal(found.data.results[0].sender, "import-chatgpt");
  const full = await tool(url, token, "read_memory", { message_id: found.data.results[0].message_id });
  assert.match(full.data.text, /# Tractor maintenance/);
  assert.match(full.data.text, /Imported from ChatGPT · chat started 2023-11-14/);
  assert.match(full.data.text, /GPT-FINAL-ANSWER/);
  assert.ok(full.data.text.indexOf("GPT-QUESTION-UNIQUE") < full.data.text.indexOf("GPT-FINAL-ANSWER"), "thread order preserved");

  const abandoned = await tool(url, token, "search_memory", { query: "GPT-ABANDONED-BRANCH" });
  assert.equal(abandoned.data.total, 0, "the abandoned fork is not part of the conversation");
});

test("imports are invisible across tenants in search and read", async () => {
  const dave = await signIn(s, "imp-dave@example.com");
  await upgrade(s, dave);
  const upDave = await upload(dave, claudeZip());
  assert.equal(upDave.body.imported, 2);
  const daveMcp = await mcpFor(dave);
  const daveFound = await tool(daveMcp.url, daveMcp.token, "search_memory", { query: "CLAUDE-MARKER-HUMAN" });
  const daveId = daveFound.data.results[0].message_id;

  const erin = await signIn(s, "imp-erin@example.com");
  await upgrade(s, erin);
  const erinMcp = await mcpFor(erin);
  const erinSearch = await tool(erinMcp.url, erinMcp.token, "search_memory", { query: "CLAUDE-MARKER-HUMAN" });
  assert.equal(erinSearch.data.total, 0, "Erin cannot search Dave's import");
  const erinRead = await tool(erinMcp.url, erinMcp.token, "read_memory", { message_id: daveId });
  assert.match(String(erinRead.data.error ?? ""), /No message found/, "Erin cannot read Dave's imported message by id");

  // The same file into Erin's own vault is NOT a duplicate — dedupe is per-tenant.
  const upErin = await upload(erin, claudeZip());
  assert.equal(upErin.body.imported, 2);
  assert.equal(upErin.body.skipped_duplicates, 0);
  const erinFound = await tool(erinMcp.url, erinMcp.token, "search_memory", { query: "CLAUDE-MARKER-HUMAN" });
  assert.equal(erinFound.data.total, 1);
});

test("malformed uploads are rejected and import nothing", async () => {
  const frank = await signIn(s, "imp-frank@example.com");
  await upgrade(s, frank);

  const notZip = await upload(frank, Buffer.from("this is not a zip file at all, just text"));
  assert.equal(notZip.status, 400);
  assert.match(String(notZip.body.error), /ZIP/);

  const wrongShape = await upload(frank, makeZip([{ name: "conversations.json", data: Buffer.from(JSON.stringify([{ hello: "world" }])) }]));
  assert.equal(wrongShape.status, 400);
  assert.match(String(wrongShape.body.error), /neither the Claude nor the ChatGPT/);

  const noConvs = await upload(frank, makeZip([{ name: "readme.txt", data: Buffer.from("hello") }]));
  assert.equal(noConvs.status, 400);
  assert.match(String(noConvs.body.error), /No conversations\.json/);

  const driftedClaude = await upload(frank, makeZip([{ name: "conversations.json", data: Buffer.from(JSON.stringify([
    { uuid: "ok-1", name: "Fine", chat_messages: [{ sender: "human", text: "hello", created_at: "2025-01-01T00:00:00Z" }] },
    { uuid: "x", name: "Drifted", chat_messages: "oops" },
  ])) }]));
  assert.equal(driftedClaude.status, 400);
  assert.match(String(driftedClaude.body.error), /Nothing was imported/);

  const me = (await api(s, frank)("/api/me")).body;
  assert.equal(me.usage.memories, 0, "failed uploads stored nothing");
});

test("import requires a signed-in owner session", async () => {
  const anon = await upload(null, claudeZip());
  assert.equal(anon.status, 401);
});
