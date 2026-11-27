/**
 * Recall quality (migration 011): ranked full-text search with match-centred snippets and a token budget,
 * supersede (corrections replace old facts but keep history), the recall log (reads/confirms strengthen,
 * unused memories fade, never deleted), and the generic default Librarian vocabulary for hosted tenants.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, upgrade, api, connect, tool, freshDb, sql, type Saas } from "./helpers.ts";
import { centeredSnippet, matchingSentences, usageFactor, SNIPPET_CHARS } from "../src/saas/recall.ts";
import { classify, PRESETS, OWNER_PRESETS, GENERIC_VOCAB, OWNER_VOCAB } from "../src/librarian/index.ts";

let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

async function account(email: string) {
  const cookie = await signIn(s, email);
  await upgrade(s, cookie, "personal");
  const me = (await api(s, cookie)("/api/me")).body;
  const tok = await connect(s, cookie, me.mcp_url);
  const call = (name: string, args: Record<string, unknown> = {}) => tool(me.mcp_url, tok.access_token, name, args);
  return { call, tenantId: me.tenant_id as string | undefined };
}
const save = async (a: { call: Function }, content: string, extra: Record<string, unknown> = {}) => {
  const r = await a.call("save_memory", { content, source: "claude.ai", ...extra });
  assert.equal(r.isError, false, r.text);
  return r.data.message_id as number;
};

// ---------------------------------------------------------------- snippets (unit)
test("snippet: short memories come back whole; long ones are centred on the match, never over the limit", () => {
  assert.deepEqual(centeredSnippet("Short note about the Tacoma lease.", "Tacoma"), { snippet: "Short note about the Tacoma lease.", whole: true });
  const long = "Filler sentence about nothing in particular. ".repeat(20) + "The Tacoma lease is 18 months at $4,850. " + "More filler text follows here. ".repeat(20);
  const r = centeredSnippet(long, "Tacoma lease");
  assert.equal(r.whole, false);
  assert.ok(r.snippet.length <= SNIPPET_CHARS);
  assert.match(r.snippet, /Tacoma lease is 18 months at \$4,850/);
  assert.ok(r.snippet.startsWith("…") && r.snippet.endsWith("…"));
});

test("snippet: a memory that mentions the subject in two places shows both places", () => {
  const long = "Rate check on Tacoma to Fresno held at 3.15 a mile. " + "Unrelated filler words keep going on. ".repeat(12) + "Decision on the Tacoma warehouse: sign the short lease. " + "Tail filler. ".repeat(20);
  const r = centeredSnippet(long, "Tacoma");
  assert.ok(r.snippet.length <= SNIPPET_CHARS);
  assert.match(r.snippet, /Tacoma to Fresno/);
  assert.match(r.snippet, /Tacoma warehouse: sign the short lease/);
});

test("matching sentences: only the sentences that mention the query", () => {
  assert.equal(matchingSentences("Alpha one. Beta two mentions zebra. Gamma three.", "zebra").trim(), "Beta two mentions zebra.");
});

// ---------------------------------------------------------------- strengthening and fading (unit)
test("usage factor: reads strengthen (capped), unused memories fade slowly to a floor, never to zero", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const fresh = usageFactor(0, null, now, now);
  assert.equal(fresh, 1);
  assert.ok(usageFactor(3, now, now, now) > 1, "reads strengthen");
  assert.ok(usageFactor(1000, now, now, now) <= 2, "strength is capped");
  const yearOld = new Date(now.getTime() - 365 * 86_400_000);
  const faded = usageFactor(0, null, yearOld, now);
  assert.ok(faded < 1 && faded >= 0.6, `a year unused fades but keeps a floor (${faded})`);
  assert.equal(usageFactor(0, null, new Date(now.getTime() - 20 * 86_400_000), now), 1, "no fading in the first 30 days");
  assert.ok(usageFactor(0, yearOld, yearOld, now) < usageFactor(0, now, yearOld, now), "a recent recall resets the fade");
});

// ---------------------------------------------------------------- ranked search (end to end)
test("search: best match first (not newest first), numeric total, token budget respected, snippets centred", async () => {
  const a = await account("rq-rank@example.com");
  const target = await save(a, "Insurance: the Keystone Mutual policy renews March 14. Annual premium is $18,400.");
  for (let i = 0; i < 12; i++) await save(a, `Note ${i}: a call about policy questions for the ${["north", "south", "east", "west"][i % 4]} office, item ${i * 7}.`);
  const r = await a.call("search_memory", { query: "policy renews premium" });
  assert.equal(r.isError, false, r.text);
  assert.equal(typeof r.data.total, "number");
  assert.equal(r.data.results[0].message_id, target, "the memory matching all the words ranks first, though it is the oldest");
  assert.equal(r.data.results[0].whole, true);
  const tight = await a.call("search_memory", { query: "policy", max_tokens: 150 });
  assert.ok(tight.data.returned >= 1);
  assert.ok(tight.data.est_tokens <= 150 || tight.data.returned === 1, "stays inside the budget (always at least one result)");
  assert.ok(tight.data.returned < tight.data.total, "the budget cut the list");
  // Substring-only matches are still found (back-compatible with the old ILIKE search).
  const sub = await a.call("search_memory", { query: "Mutu" });
  assert.equal(sub.data.results[0]?.message_id, target);
});

test("search: near-duplicate notes are folded and counted, so distinct memories are not crowded out", async () => {
  const a = await account("rq-fold@example.com");
  for (let i = 0; i < 6; i++) await save(a, `Bookkeeping note: categorize lumper fees separately so the margin report by lane stays clean. (copy ${i})`);
  const distinct = await save(a, "Q3 review: the Boise to Spokane lane had the highest margin at 17.2 percent.");
  const r = await a.call("search_memory", { query: "margin" });
  const ids = r.data.results.map((x: any) => x.message_id);
  assert.ok(ids.includes(distinct));
  assert.equal(r.data.results.length, 2, JSON.stringify(r.data.results.map((x: any) => x.snippet)));
  assert.equal(r.data.results.find((x: any) => x.message_id !== distinct).similar_hidden, 5);
});

// ---------------------------------------------------------------- supersede
test("supersede: a correction hides the old fact from search but keeps it in history, both ways linked", async () => {
  const a = await account("rq-supersede@example.com");
  const oldId = await save(a, "Dispatch software: we dispatch on RouteBook.");
  const saved = await a.call("save_memory", { content: "Dispatch software: switched to LoadPilot on September 3.", source: "claude.ai", replaces: [oldId] });
  assert.equal(saved.isError, false, saved.text);
  assert.deepEqual(saved.data.replaces, [oldId]);
  const newId = saved.data.message_id;
  const r = await a.call("search_memory", { query: "dispatch software" });
  assert.deepEqual(r.data.results.map((x: any) => x.message_id), [newId], "the replaced memory is hidden by default");
  assert.deepEqual(r.data.results[0].replaces, [oldId]);
  const h = await a.call("search_memory", { query: "dispatch software", include_history: true });
  const old = h.data.results.find((x: any) => x.message_id === oldId);
  assert.equal(old.superseded_by, newId, "history is kept and points at the replacement");
  const rd = await a.call("read_memory", { message_id: oldId });
  assert.equal(rd.data.superseded_by.message_id, newId);
  assert.match(rd.data.text, /RouteBook/, "nothing was edited or deleted");
  const rn = await a.call("read_memory", { message_id: newId });
  assert.deepEqual(rn.data.replaces.map((x: any) => x.message_id), [oldId]);
});

test("supersede: self-links and loops are refused; unknown ids save nothing", async () => {
  const a = await account("rq-loop@example.com");
  const x = await save(a, "Fact version one about the zinc order.");
  const y = await save(a, "Fact version two about the zinc order.");
  assert.equal((await a.call("supersede_memory", { old_message_id: x, new_message_id: x })).isError, true);
  assert.equal((await a.call("supersede_memory", { old_message_id: x, new_message_id: y })).isError, false);
  const again = await a.call("supersede_memory", { old_message_id: x, new_message_id: y });
  assert.equal(again.isError, false, "a repeat is a harmless no-op");
  const loop = await a.call("supersede_memory", { old_message_id: y, new_message_id: x });
  assert.equal(loop.isError, true);
  assert.match(loop.text, /loop/i);
  const before = (await a.call("search_memory", { query: "zinc", include_history: true })).data.total;
  const bad = await a.call("save_memory", { content: "Fact version three about the zinc order.", source: "claude.ai", replaces: [999999] });
  assert.equal(bad.isError, true);
  assert.equal((await a.call("search_memory", { query: "zinc", include_history: true })).data.total, before, "nothing was saved");
});

test("supersede and confirm are tenant-isolated: another account's ids do not exist for you", async () => {
  const alice = await account("rq-alice@example.com");
  const bob = await account("rq-bob@example.com");
  const aid = await save(alice, "Alice private fact about the walnut contract.");
  const bid = await save(bob, "Bob fact about the walnut contract.");
  const r = await bob.call("supersede_memory", { old_message_id: aid, new_message_id: bid });
  assert.equal(r.isError, true);
  assert.match(r.text, new RegExp(`No memory with id ${aid}`));
  assert.equal((await bob.call("save_memory", { content: "Bob correction.", source: "claude.ai", replaces: [aid] })).isError, true);
  assert.match((await bob.call("confirm_memory", { message_id: aid })).text, /No memory/);
  const still = await alice.call("search_memory", { query: "walnut" });
  assert.deepEqual(still.data.results.map((x: any) => x.message_id), [aid], "Alice's memory is untouched and still current");
  const n = await s.pg.query("SELECT count(*)::int AS n FROM memory_supersessions WHERE old_message_id = $1", [aid]);
  assert.equal(n.rows[0].n, 0);
});

// ---------------------------------------------------------------- recall log
test("recall log: reading and confirming are logged and lift a memory above an equally relevant one", async () => {
  const a = await account("rq-recall@example.com");
  const older = await save(a, "Zebra plan: buy oak boards Monday.");
  const newer = await save(a, "Zebra plan: sell old chairs Friday.");
  const first = await a.call("search_memory", { query: "zebra plan" });
  assert.equal(first.data.results[0].message_id, newer, "equal relevance: newest first");
  await a.call("read_memory", { message_id: older });
  const c = await a.call("confirm_memory", { message_id: older });
  assert.equal(c.data.confirmed, true);
  const second = await a.call("search_memory", { query: "zebra plan" });
  assert.equal(second.data.results[0].message_id, older, "the recalled memory now ranks first");
  const log = await s.pg.query("SELECT kind FROM memory_recalls WHERE message_id = $1 ORDER BY id", [older]);
  assert.deepEqual(log.rows.map((x: any) => x.kind), ["read", "confirm"]);
  // A second page of a long read is not counted again.
  const long = await save(a, "Long zebra note. " + "x".repeat(9000));
  await a.call("read_memory", { message_id: long, offset: 8000 });
  assert.equal((await s.pg.query("SELECT count(*)::int AS n FROM memory_recalls WHERE message_id = $1", [long])).rows[0].n, 0);
});

test("read-only tokens can search and read but cannot supersede or confirm", async () => {
  const cookie = await signIn(s, "rq-ro@example.com");
  await upgrade(s, cookie, "personal");
  const me = (await api(s, cookie)("/api/me")).body;
  const ro = await connect(s, cookie, me.mcp_url, { scope: "memory.read" });
  const r1 = await tool(me.mcp_url, ro.access_token, "supersede_memory", { old_message_id: 1, new_message_id: 2 });
  const r2 = await tool(me.mcp_url, ro.access_token, "confirm_memory", { message_id: 1 });
  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
});

// ---------------------------------------------------------------- migration 011
test("migration 011 is reversible and re-appliable", async () => {
  const pg = await freshDb();
  const has = async (t: string) => (await pg.query(`SELECT to_regclass('${t}') AS r`)).rows[0] as { r: string | null };
  assert.ok((await has("memory_recalls")).r && (await has("memory_supersessions")).r && (await has("messages_text_fts")).r);
  await pg.exec(sql("011_recall_quality.down.sql"));
  assert.equal((await has("memory_recalls")).r, null);
  assert.equal((await has("memory_supersessions")).r, null);
  assert.equal((await has("messages_text_fts")).r, null);
  assert.ok((await pg.query("SELECT count(*) FROM messages")).rows.length, "messages untouched");
  await pg.exec(sql("011_recall_quality.sql"));
  assert.ok((await has("memory_recalls")).r);
  const rls = await pg.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('memory_recalls','memory_supersessions') ORDER BY relname");
  assert.deepEqual(rls.rows.map((x: any) => [x.relname, x.relrowsecurity, x.relforcerowsecurity]), [["memory_recalls", true, true], ["memory_supersessions", true, true]]);
});

// ---------------------------------------------------------------- generic vocabulary
const OWNER_TERMS = ["faith-n-light", "helmian", "dairyforge", "forge-tms", "caldmere", "thinkinbuddy", "big sister", "diabetes", "insulin", "blood sugar", "jarvis", "muse", "milk", "tanker", "sam"];

test("hosted default vocabulary is generic: no owner shelves, names, nicknames, health words or day job", () => {
  const generic = JSON.stringify(GENERIC_VOCAB).toLowerCase();
  for (const t of OWNER_TERMS) assert.ok(!new RegExp(`\\b${t}\\b`).test(generic), `generic vocabulary contains "${t}"`);
  const books = JSON.stringify(PRESETS).toLowerCase();
  for (const t of ["faith-n-light", "dairyforge", "forge-tms", "big sister", "diabetes", "helmian"]) assert.ok(!books.includes(t), `generic presets mention "${t}"`);
  assert.equal(Object.keys(GENERIC_VOCAB.projects).length, 0);
  assert.ok(!PRESETS.D.categories.some((c) => c.slug === "forge-tms"));
  assert.notEqual(classify({ id: 1, text: "Cora answered the dispatcher." }, PRESETS.D).category, "forge-tms");
  assert.notEqual(classify({ id: 2, text: "Doctor appointment about blood sugar." }, PRESETS.D).category, undefined);
  // Every rule in every generic preset has a non-empty trigger list (an empty list would match everything).
  for (const b of Object.values(PRESETS)) for (const r of b.rules) assert.ok(!(r.when.anyWords && r.when.anyWords.length === 0), `${b.id} ${r.id}`);
});

test("the owner's own install keeps its vocabulary when selected (owner pack)", () => {
  assert.ok(Object.keys(OWNER_VOCAB.projects).includes("forge-tms"));
  assert.equal(classify({ id: 1, text: "Cora answered the dispatcher." }, OWNER_PRESETS.D).category, "forge-tms");
  assert.equal(OWNER_PRESETS.D.id, PRESETS.D.id, "same rulebook ids, so stored settings keep working");
});

test("a new hosted tenant files with the generic shelves", async () => {
  const a = await account("rq-vocab@example.com");
  const r = await a.call("save_memory", { content: "Forge TMS load board: Cora answered the dispatcher.", source: "claude.ai" });
  assert.equal(r.isError, false, r.text);
  assert.notEqual(r.data.filed_in, "forge-tms");
});
