/**
 * Ranked recall, the novelty filter, the sentence splitter and optional meaning-based search for the PERSONAL
 * single-user server, on an in-process Postgres (PGlite) with the claude_memory base schema. No network, no model.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { searchRanked, matchingSentenceList, centeredSnippet, searchModeFromEnv, type Q } from "../src/recall.ts";
import { passages, storeEmbeddings, semanticSearch, backfillEmbeddings, embedderFromEnv, semanticModeFromEnv, type Embedder } from "../src/embeddings.ts";

const MIG = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
// The claude_memory base tables exactly as live (no FKs, no defaults except the id sequence).
const BASE = `
CREATE TABLE conversations (uuid TEXT PRIMARY KEY, name TEXT, project_uuid TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, message_count INT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_uuid TEXT, turn_index INT, sender TEXT, text TEXT, created_at TIMESTAMPTZ);
INSERT INTO conversations (uuid, name, created_at) VALUES ('c1', 'Shared Memory — test', now());`;

let db: PGlite;
let q: Q;
beforeEach(async () => { db = new PGlite(); await db.exec(BASE); q = db as unknown as Q; });

let day = 0;
async function save(text: string, daysAgo?: number): Promise<number> {
  const ago = daysAgo ?? 1000 - ++day; // later saves are newer by default
  const r = await db.query<{ id: number }>(
    "INSERT INTO messages (conversation_uuid, turn_index, sender, text, created_at) VALUES ('c1', 0, 'test', $1, now() - ($2 || ' days')::interval) RETURNING id",
    [text, String(ago)]);
  return Number(r.rows[0].id);
}
const ids = (r: { results: { id: number }[] }) => r.results.map((x) => x.id);

// ------------------------------------------------------------------ sentence splitter (the decimal bug)
test("a decimal point does not end a sentence", () => {
  const t = "Our target margin is 12.5% on dedicated lanes. Fuel is separate. The margin floor is 9.75 percent.";
  assert.deepEqual(matchingSentenceList(t, "margin"), [
    "Our target margin is 12.5% on dedicated lanes.",
    "The margin floor is 9.75 percent.",
  ]);
});

test("snippets are centred on the match, not the first 300 characters", () => {
  const t = "x ".repeat(400) + "The detention rate is $75 per hour after two hours. " + "y ".repeat(400);
  const { snippet, whole } = centeredSnippet(t, "detention rate");
  assert.equal(whole, false);
  assert.ok(snippet.includes("detention rate is $75"), snippet);
  assert.ok(snippet.length <= 300);
});

// ------------------------------------------------------------------ ranking
test("relevance beats recency, and a short note is returned whole", async () => {
  const gold = await save("Saadi pricing decision: $2.10 per mile flat for the Saadi account.", 400);
  for (let i = 0; i < 30; i++) await save(`Weekly note ${i}: called a few carriers, nothing about pricing models yet, maybe later.`, i);
  const r = await searchRanked(q, { query: "Saadi pricing", limit: 5 });
  assert.equal(r.results[0].id, gold);
  assert.equal(r.results[0].whole, true);
});

test("old substring matches are still found (lower tier)", async () => {
  const id = await save("Load ref ABX-55917 delivered late, detention billed.");
  const r = await searchRanked(q, { query: "X-559", limit: 5 });
  assert.deepEqual(ids(r), [id]);
});

test("since filter and token budget", async () => {
  await save("reefer temperature note one", 100);
  const recent = await save("reefer temperature note two", 1);
  const r = await searchRanked(q, { query: "reefer", since: new Date(Date.now() - 10 * 86400000).toISOString(), limit: 10 });
  assert.deepEqual(ids(r), [recent]);
  for (let i = 0; i < 40; i++) await save(`reefer ${i} ` + "unique words here ".repeat(10) + i);
  const small = await searchRanked(q, { query: "reefer", limit: 40, maxTokens: 300 });
  assert.ok(small.returned < 40 && small.est_tokens <= 300 + 200, `${small.returned} ${small.est_tokens}`);
});

// ------------------------------------------------------------------ novelty filter (the T11 fix)
test("repeated notes fold together; the memory with something new is not crowded out", async () => {
  for (let i = 0; i < 25; i++) await save(`Reminder ${i}: check the margin report every Friday.`);
  const long = "Quarterly planning notes. " + "Lots of unrelated discussion about trucks and drivers. ".repeat(20) +
    "We agreed the minimum gross margin on brokered loads is 14 percent. " + "More unrelated discussion. ".repeat(20);
  const gold = await save(long, 900); // oldest, long, and ts_rank penalises its length
  const r = await searchRanked(q, { query: "margin", limit: 5 });
  assert.ok(ids(r).includes(gold), JSON.stringify(r.results.map((x) => x.snippet)));
  const owner = r.results.find((x) => (x.similar_hidden ?? 0) > 0);
  assert.ok(owner && owner.similar_hidden! >= 20);
  assert.ok(r.results.find((x) => x.id === gold)!.snippet.includes("14 percent"));
  const off = await searchRanked(q, { query: "margin", limit: 5, diverse: false });
  assert.ok(!ids(off).includes(gold), "without the filter the gold memory is crowded out (proves the test bites)");
});

// ------------------------------------------------------------------ switches
test("defaults: ranked search on, meaning search off", () => {
  assert.equal(searchModeFromEnv({}), "ranked");
  assert.equal(searchModeFromEnv({ SCRIBE_SEARCH: "substring" }), "substring");
  assert.equal(embedderFromEnv({}), undefined);
  assert.equal(embedderFromEnv({ SCRIBE_EMBEDDINGS: "1" }), undefined);
  assert.ok(embedderFromEnv({ SCRIBE_EMBEDDINGS: "local" }));
  assert.equal(semanticModeFromEnv({}), "fallback");
  assert.equal(semanticModeFromEnv({ SCRIBE_EMBEDDINGS_MODE: "blend" }), "blend");
});

// ------------------------------------------------------------------ migrations (written for claude_memory; not applied anywhere real)
test("p001: full-text index is additive, idempotent, reversible, and matches the search expression", async () => {
  await save("one"); await save("two");
  const sql = MIG("p001_fts_index.sql");
  await db.exec(sql); await db.exec(sql);
  const idx = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_text_fts'");
  assert.equal(idx.rows.length, 1);
  assert.match(idx.rows[0].indexdef, /to_tsvector\('english'::regconfig, COALESCE\(text, ''::text\)\)/);
  assert.ok(readFileSync(new URL("../src/recall.ts", import.meta.url), "utf8").includes("to_tsvector('english', coalesce(m.text, ''))"));
  assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM messages")).rows[0].n, 2);
  await db.exec(MIG("p001_fts_index.down.sql"));
  assert.equal((await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'messages_text_fts'")).rows.length, 0);
});

test("p002: one new table, grants to the two server roles, no tenant column, reversible", async () => {
  await save("keep me");
  await db.exec("CREATE ROLE memory_ro_hz; CREATE ROLE memory_rw;");
  const sql = MIG("p002_memory_embeddings.sql");
  await db.exec(sql); await db.exec(sql);
  const cols = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'memory_embeddings'")).rows.map((r) => r.column_name);
  assert.ok(!cols.includes("tenant_id"));
  const grants = (await db.query<{ grantee: string; privilege_type: string }>(
    "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'memory_embeddings' AND grantee IN ('memory_ro_hz','memory_rw') ORDER BY 1,2")).rows;
  assert.deepEqual(grants.map((g) => `${g.grantee}:${g.privilege_type}`), ["memory_ro_hz:SELECT", "memory_rw:INSERT", "memory_rw:SELECT"]);
  await db.exec(MIG("p002_memory_embeddings.down.sql"));
  assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM messages")).rows[0].n, 1);
});

test("p002 applies on a database without the roles too", async () => {
  await db.exec(MIG("p002_memory_embeddings.sql"));
  assert.equal((await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'memory_embeddings'")).rows.length, 1);
});

test("hosted-only migrations are not shipped with the personal server", () => {
  const files = ["p001_fts_index.sql", "p002_memory_embeddings.sql"].map(MIG).join("\n");
  assert.ok(!/tenant_id|ROW LEVEL SECURITY|memory_app/i.test(files.replace(/^--.*$/gm, "")));
});

// ------------------------------------------------------------------ meaning-based search (fake model, no download)
const GROUPS = [["signature", "sign off", "sign-off", "signed off"], ["invoice", "bill", "billing"], ["zebra"]];
const fake = (calls?: { n: number }): Embedder => ({
  model: "fake-test-model",
  async embed(texts) {
    if (calls) calls.n += texts.length;
    return texts.map((t) => {
      const l = t.toLowerCase();
      const v = GROUPS.map((g) => (g.some((w) => l.includes(w)) ? 1 : 0));
      v.push(0.05);
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  },
});
const broken: Embedder = { model: "broken", async embed() { throw new Error("model missing"); } };

test("passages split long text on sentence ends", () => {
  const t = "A sentence here. ".repeat(80);
  const p = passages(t, 500);
  assert.ok(p.length > 1 && p.every((x) => x.text.length <= 1000));
  assert.deepEqual(passages("short", 500), [{ start: 0, text: "short" }]);
});

test("without p002, meaning search and vector storage fail soft", async () => {
  const id = await save("Dispatcher must get the customer's signature on the BOL.");
  assert.equal(await storeEmbeddings(q, id, "x", fake()), 0);
  assert.deepEqual(await semanticSearch(q, "sign off", fake()), []);
  const r = await searchRanked(q, { query: "sign off on paperwork", limit: 5, embedder: fake() });
  assert.ok(Array.isArray(r.results));
});

test("fallback mode: a meaning-only match is found when the words find nothing; broken model = words only", async () => {
  await db.exec(MIG("p002_memory_embeddings.sql"));
  const gold = await save("Dispatcher must get the customer's signature on the BOL before the truck leaves.");
  for (let i = 0; i < 10; i++) await save(`Zebra striping on trailer ${i}.`);
  const e = fake();
  const b = await backfillEmbeddings(q, q, e, 50);
  assert.equal(b.embedded, 11);
  const r = await searchRanked(q, { query: "who has to sign off", limit: 5, embedder: e, semanticMode: "fallback" });
  assert.equal(r.results[0]?.id, gold);
  const words = await searchRanked(q, { query: "who has to sign off", limit: 5 });
  assert.ok(!ids(words).includes(gold));
  const br = await searchRanked(q, { query: "who has to sign off", limit: 5, embedder: broken });
  assert.deepEqual(ids(br), ids(words));
});

test("fallback mode does not call the model when words already find enough", async () => {
  await db.exec(MIG("p002_memory_embeddings.sql"));
  for (let i = 0; i < 5; i++) await save(`Invoice ${i} sent to the customer.`);
  const calls = { n: 0 };
  await searchRanked(q, { query: "invoice", limit: 5, embedder: fake(calls), semanticMode: "fallback" });
  assert.equal(calls.n, 0);
});

test("blend mode fuses word and meaning ranks", async () => {
  await db.exec(MIG("p002_memory_embeddings.sql"));
  const word = await save("Billing question from Acme about invoice 7.");
  const meaning = await save("Customer asked to be billed monthly instead of per load.");
  await backfillEmbeddings(q, q, fake(), 50);
  const r = await searchRanked(q, { query: "invoice", limit: 5, embedder: fake(), semanticMode: "blend" });
  assert.ok(ids(r).includes(word) && ids(r).includes(meaning));
});
