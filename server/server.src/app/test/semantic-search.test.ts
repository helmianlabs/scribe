/**
 * Meaning-based search (migration 012, src/saas/embeddings.ts) and the novelty filter in ranked search.
 * A tiny deterministic fake embedder stands in for the local model, so CI needs no model download.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, upgrade, api, connect, tool, freshDb, sql, type Saas } from "./helpers.ts";
import { passages, storeEmbeddings, semanticSearch, backfillEmbeddings, embedderFromEnv, semanticModeFromEnv, type Embedder } from "../src/saas/embeddings.ts";
import { matchingSentenceList } from "../src/saas/recall.ts";
import { pgliteDb } from "../src/saas/db.ts";

/** Concept dimensions: words in the same group mean the same thing to this fake model. */
const GROUPS = [["signature", "sign off", "sign-off", "signed off"], ["invoice", "bill", "billing"], ["dog", "puppy", "canine"], ["zebra"]];
const fake = (calls?: { n: number }): Embedder => ({
  model: "fake-test-model",
  async embed(texts) {
    if (calls) calls.n += texts.length;
    return texts.map((t) => {
      const l = t.toLowerCase();
      const v = GROUPS.map((g) => (g.some((w) => l.includes(w)) ? 1 : 0));
      v.push(0.05); // a small shared component so every vector is non-zero
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  },
});
const broken: Embedder = { model: "broken", async embed() { throw new Error("model missing"); } };

let s: Saas;
before(async () => { s = await startSaas({}, { embedder: fake() }); });
after(async () => { await s.close(); });

async function account(srv: Saas, email: string) {
  const cookie = await signIn(srv, email);
  await upgrade(srv, cookie, "personal");
  const me = (await api(srv, cookie)("/api/me")).body;
  const tok = await connect(srv, cookie, me.mcp_url);
  return (name: string, args: Record<string, unknown> = {}) => tool(me.mcp_url, tok.access_token, name, args);
}
const saveText = async (call: Function, content: string) => {
  const r = await call("save_memory", { content, source: "claude.ai" });
  assert.equal(r.isError, false, r.text);
  return r.data.message_id as number;
};

test("sentence splitting: a decimal point or version number does not end a sentence", () => {
  assert.deepEqual(matchingSentenceList("Floor margin of 10.2 percent here. Other line. Q3 margin was 17.2 percent.", "margin"),
    ["Floor margin of 10.2 percent here.", "Q3 margin was 17.2 percent."]);
});

test("passages: short text is one passage; long text is cut on sentence ends near the size", () => {
  assert.deepEqual(passages("One short memory."), [{ start: 0, text: "One short memory." }]);
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} has a few words.`).join(" ");
  const p = passages(long, 200);
  assert.ok(p.length > 3);
  assert.ok(p.every((x) => x.text.length <= 400));
  assert.ok(p.every((x) => long.slice(x.start).startsWith(x.text.slice(0, 20))), "start offsets point at the passage");
  assert.deepEqual(passages(""), []);
});

test("novelty filter: notes that only repeat already-shown sentences are folded, a note with something new is shown", async () => {
  const call = await account(s, "sem-novel@example.com");
  for (let i = 0; i < 8; i++) {
    await saveText(call, `Pricing discussion: quote each lane with a floor margin of ${i + 2}.5 percent. Unrelated filler ${i} about the yard.`);
    await saveText(call, `Bookkeeping note: keep the margin report by lane clean. Other filler ${i}. Pricing discussion: quote each lane with a floor margin of ${i + 3}.1 percent.`);
  }
  const distinct = await saveText(call, "Long review. " + "Filler words that say nothing. ".repeat(30) + "Q3 review: the Boise to Spokane lane had the highest margin at 17.2 percent.");
  const r = await call("search_memory", { query: "margin" });
  const ids = r.data.results.map((x: any) => x.message_id);
  assert.ok(ids.includes(distinct), "the long note with a new margin fact is shown");
  assert.ok(r.data.results.length <= 4, `repeats folded: ${r.data.results.length} results`);
  assert.ok(r.data.results.some((x: any) => (x.similar_hidden ?? 0) >= 5));
});

test("fallback mode (default): a memory with no shared words is found by meaning when the words find nothing", async () => {
  const call = await account(s, "sem-fallback@example.com");
  const gold = await saveText(call, "Writing preference for Dana: short emails, and sign off with 'Thanks, Dana'.");
  await saveText(call, "The invoice batch went out on Friday.");
  const r = await call("search_memory", { query: "signature" });
  assert.equal(r.data.results[0]?.message_id, gold);
  // When the words do find enough, meaning-based search is not consulted and results are words-only.
  for (let i = 0; i < 4; i++) await saveText(call, `Zebra note ${i}: a plain word match.`);
  const w = await call("search_memory", { query: "zebra" });
  assert.ok(w.data.results.every((x: any) => /zebra/i.test(x.snippet)));
});

test("blend mode fuses meaning and word ranks; mode comes from SCRIBE_EMBEDDINGS_MODE", async () => {
  assert.equal(semanticModeFromEnv({}), "fallback");
  assert.equal(semanticModeFromEnv({ SCRIBE_EMBEDDINGS_MODE: "blend" }), "blend");
  assert.equal(embedderFromEnv({}), undefined, "embeddings are off unless SCRIBE_EMBEDDINGS=local");
  assert.equal(embedderFromEnv({ SCRIBE_EMBEDDINGS: "local" })?.model, "Xenova/all-MiniLM-L6-v2");
  const prev = process.env.SCRIBE_EMBEDDINGS_MODE;
  process.env.SCRIBE_EMBEDDINGS_MODE = "blend";
  try {
    const call = await account(s, "sem-blend@example.com");
    const puppy = await saveText(call, "The puppy needs its shots in March.");
    const dog = await saveText(call, "Dog food order: two bags a month.");
    const r = await call("search_memory", { query: "dog" });
    const ids = r.data.results.map((x: any) => x.message_id);
    assert.ok(ids.includes(dog) && ids.includes(puppy), "word match and meaning match both returned");
    assert.equal(ids[0], dog, "the memory found both ways ranks first");
  } finally { if (prev === undefined) delete process.env.SCRIBE_EMBEDDINGS_MODE; else process.env.SCRIBE_EMBEDDINGS_MODE = prev; }
});

test("embeddings are stored per tenant and never cross accounts", async () => {
  const alice = await account(s, "sem-alice@example.com");
  const bob = await account(s, "sem-bob@example.com");
  await saveText(alice, "Alice: sign off every letter with Cheers.");
  const r = await bob("search_memory", { query: "signature" });
  assert.equal(r.data.total, 0, "Bob never sees Alice's memory by meaning either");
  const rows = await s.pg.query("SELECT DISTINCT tenant_id FROM memory_embeddings");
  assert.ok(rows.rows.length >= 2, "vectors carry their tenant");
});

test("fail-soft: a broken model or a missing table never breaks saving; search falls back to words", async () => {
  const s2 = await startSaas({}, { embedder: broken });
  try {
    const call = await account(s2, "sem-broken@example.com");
    const id = await saveText(call, "Broken model test: zebra crossing notes.");
    const r = await call("search_memory", { query: "zebra" });
    assert.equal(r.data.results[0].message_id, id);
    assert.equal((await s2.pg.query("SELECT count(*)::int AS n FROM memory_embeddings")).rows[0].n, 0);
  } finally { await s2.close(); }
  // Table missing (012 not applied): storing and searching return nothing instead of throwing, and the transaction survives.
  const pg = await freshDb();
  await pg.exec(sql("012_memory_embeddings.down.sql"));
  const db = pgliteDb(pg, "memory_app");
  await db.tenant("self", async (q) => {
    const m = (await q.query("INSERT INTO messages (tenant_id, conversation_uuid, sender, text, created_at) VALUES ('self','c1','x','sign off with Cheers', now()) RETURNING id")).rows[0];
    assert.equal(await storeEmbeddings(q, "self", Number(m.id), "sign off with Cheers", fake()), 0);
    assert.deepEqual(await semanticSearch(q, "self", "signature", fake()), []);
    assert.equal((await q.query("SELECT count(*)::int AS n FROM messages WHERE id = $1", [m.id])).rows[0].n, 1, "transaction still usable");
  });
});

test("backfill embeds memories saved before embeddings were on, once", async () => {
  const pg = await freshDb();
  const db = pgliteDb(pg, "memory_app");
  const calls = { n: 0 };
  await db.tenant("self", async (q) => {
    for (const t of ["first sign off note", "second invoice note", "third dog note"]) await q.query("INSERT INTO messages (tenant_id, conversation_uuid, sender, text, created_at) VALUES ('self','c1','x',$1, now())", [t]);
    const n1 = await backfillEmbeddings(q, "self", fake(calls));
    assert.ok(n1 >= 3);
    assert.equal(await backfillEmbeddings(q, "self", fake(calls)), 0, "nothing left to do");
    const hits = await semanticSearch(q, "self", "signature", fake());
    assert.ok(hits.length >= 1);
  });
});

test("migration 012 is reversible and re-appliable, with RLS forced", async () => {
  const pg = await freshDb();
  const reg = async () => (await pg.query("SELECT to_regclass('memory_embeddings') AS r")).rows[0] as { r: string | null };
  assert.ok((await reg()).r);
  await pg.exec(sql("012_memory_embeddings.down.sql"));
  assert.equal((await reg()).r, null);
  await pg.exec(sql("012_memory_embeddings.sql"));
  const rls = await pg.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'memory_embeddings'");
  assert.deepEqual([rls.rows[0].relrowsecurity, rls.rows[0].relforcerowsecurity], [true, true]);
});
