/**
 * Forensic-audit fixes at the server level: the knowledge graph (ported from the live build), the self-host
 * Librarian class (retry, repair, full trail, shelf-name guard, unique ids) and the SaaS tool surface.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Librarian } from "../src/librarian-tools.ts";
import { KnowledgeGraph } from "../src/librarian/index.ts";
import { extractEntities } from "../src/librarian/extract.ts";
import { BASE, freshDb, sql, startSaas, signIn, api, connect, tool, type Saas } from "./helpers.ts";

const pool = (db: PGlite, hook?: (sql: string) => void) => ({ query: async (q: string, p?: unknown[]) => { hook?.(q); return db.query(q, p as any[]); } }) as any;
const msg = async (db: PGlite, text: string, sender = "claude.ai") =>
  Number((await db.query<any>("INSERT INTO messages (conversation_uuid, sender, text, created_at) VALUES ('c1', $1, $2, now()) RETURNING id", [sender, text])).rows[0].id);
const sleepless = { sleep: async () => {} };

test("008_graph.sql: idempotent, reversible, widens an old CHECK, memories untouched", async () => {
  const db = new PGlite();
  await db.exec(BASE); await db.exec(sql("001_librarian.sql")); await db.exec(sql("006_courier.sql"));
  const before = (await db.query<any>("SELECT count(*)::int n FROM messages")).rows[0].n;
  await db.exec(sql("008_graph.sql")); await db.exec(sql("008_graph.sql"));
  await db.query("INSERT INTO entities (kind, name, canonical_key) VALUES ('value','8080','8080')");
  await db.exec(sql("008_graph.down.sql"));
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM messages")).rows[0].n, before);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('entities','entity_aliases','links')")).rows[0].n, 0);
  // a database that ran the production 007 (no 'value' kind) gets the widened CHECK
  await db.exec("CREATE TABLE entities (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('person','agent','project','product','org','place','topic')), name TEXT NOT NULL, canonical_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.exec(sql("008_graph.sql"));
  await db.query("INSERT INTO entities (kind, name, canonical_key) VALUES ('value','9090','9090')");
});

test("knowledge graph: filing a memory builds entities and links, and graph neighbours can be read", async () => {
  const db = await freshDb({ saas: false });
  await db.exec("INSERT INTO conversations(uuid,name) VALUES ('c9','Shared Memory — muse')");
  const lib = new Librarian(pool(db), pool(db), sleepless);
  const id = await msg(db, "Muse and Paul agreed the Kokoro port is 8097 at Forge TMS");
  const filed = await lib.fileSaved({ id, text: "Muse and Paul agreed the Kokoro port is 8097 at Forge TMS", sender: "muse", source: "muse", conversationName: "Shared Memory — muse" });
  assert.equal(filed.recorded, true);
  const g = new KnowledgeGraph(pool(db), pool(db));
  const n = await g.neighbors("muse", 1);
  assert.ok(n.entity, "the writer became an entity");
  assert.ok(n.neighbors.length > 0, "and has linked neighbours");
  assert.ok(extractEntities("The relay endpoint id is ep-relay-77341").some((e) => e.kind === "value"));
  assert.ok(extractEntities("Brendan Smith signed the contract").some((e) => e.kind === "person"));
});

test("self-host Librarian: failed filing is retried then reported, not swallowed; refileUnsorted repairs it", async () => {
  const db = await freshDb({ saas: false });
  const id = await msg(db, "Brendan at Banyan called");
  let failing = 2;
  const lib = new Librarian(pool(db), pool(db, (q) => { if (/INSERT INTO memory_filings/.test(q) && failing-- > 0) throw new Error("connection reset"); }), sleepless);
  const f = await lib.fileSaved({ id, text: "Brendan at Banyan called", sender: "claude.ai", conversationName: "x" });
  assert.equal(f.category, "people"); assert.equal(f.recorded, true, "recorded on the third try");

  const id2 = await msg(db, "Giltner trucking");
  const errs: string[] = []; const origErr = console.error; console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  try {
    const dead = new Librarian(pool(db), pool(db, (q) => { if (/INSERT INTO memory_filings/.test(q)) throw new Error("database down"); }), sleepless);
    const f2 = await dead.fileSaved({ id: id2, text: "Giltner trucking", sender: "claude.ai" });
    assert.equal(f2.recorded, false); assert.match(f2.error!, /database down/);
  } finally { console.error = origErr; }
  assert.equal(errs.length, 1, "the failure was logged"); assert.match(errs[0], /could not record the filing/);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM memory_unsorted WHERE message_id=$1", [id2])).rows[0].n, 1);
  const res = await lib.refileUnsorted();
  assert.equal(res.refiled, 1);
  assert.equal((await db.query<any>("SELECT category FROM memory_current_filing WHERE message_id=$1", [id2])).rows[0].category, "organizations");
});

test("self-host Librarian: full trail, move refresh, shelf guard, unique rule ids, tray re-file after a rule", async () => {
  const db = await freshDb({ saas: false });
  const lib = new Librarian(pool(db), pool(db), sleepless);
  const a = await msg(db, "invoice from Giltner trucking for $400");
  await lib.fileSaved({ id: a, text: "invoice from Giltner trucking for $400", sender: "claude.ai" });
  const e: any = await lib.explain(a);
  assert.ok(e.matched_rules.length >= 4); assert.equal(e.matched_rules.filter((x: any) => x.decided).length, 1); assert.equal(e.category, "finance");
  const mv: any = await lib.move(a, "organizations", "troy");
  assert.equal(mv.moved, true);
  const e2: any = await lib.explain(a);
  assert.equal(e2.matched_rules[0].rule_key, "manual.move"); assert.equal(e2.category, "organizations");

  const typo: any = await lib.move(a, "organisations-x", "troy");
  assert.equal(typo.moved, false); assert.equal(typo.needs_confirmation, true);
  assert.equal((await lib.move(a, "organisations-x", "troy", { confirmNewCategory: true }) as any).moved, true);

  const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => lib.addRule(`anything mentioning thing${i} goes in finance`, "troy") as Promise<any>));
  assert.equal(new Set(ids.map((r) => r.rule_key)).size, 6);
  assert.equal(((await lib.addRule("anything mentioning z goes in finnace", "troy")) as any).needs_confirmation, true);

  const b = await msg(db, "Zebra crossing notes"); await lib.fileSaved({ id: b, text: "Zebra crossing notes", sender: "claude.ai" });
  assert.equal((await db.query<any>("SELECT category FROM memory_current_filing WHERE message_id=$1", [b])).rows[0].category, "unsorted");
  const r: any = await lib.addRule("zebra goes in places", "troy");
  assert.equal(r.added, true); assert.equal(r.refiled_unsorted.refiled >= 1, true);
  assert.equal((await db.query<any>("SELECT category FROM memory_current_filing WHERE message_id=$1", [b])).rows[0].category, "places");
});

// ---- SaaS tool surface (real OAuth + MCP over HTTP, PGlite with RLS)
let s: Saas;
before(async () => { s = await startSaas(); });
after(async () => { await s.close(); });

test("SaaS: entity filing, full trail, shelf guard, rule + tray re-file, all through the MCP tools", async () => {
  const cookie = await signIn(s, "audit@example.com");
  const me = (await api(s, cookie)("/api/me")).body;
  const tok = await connect(s, cookie, me.mcp_url);
  const call = (name: string, args: Record<string, unknown>) => tool(me.mcp_url, tok.access_token, name, args);
  const saved = await call("save_memory", { content: "Brendan at Banyan called", source: "claude.ai" });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.data.filed_in, "people"); assert.equal(saved.data.filing_recorded, true);
  const ex = await call("explain_filing", { message_id: saved.data.message_id });
  assert.ok(Array.isArray(ex.data.matched_rules) && ex.data.matched_rules.length >= 1); assert.match(ex.data.trail_summary, /matched/);

  const typo = await call("add_rule", { rule: "anything mentioning stripe goes in finnace", source: "claude.ai" });
  assert.equal(typo.data.added, false); assert.equal(typo.data.needs_confirmation, true);
  const mvTypo = await call("move_memory", { message_id: saved.data.message_id, to_category: "peeple", source: "claude.ai" });
  assert.equal(mvTypo.data.moved, false); assert.ok(mvTypo.data.did_you_mean.includes("people"));

  const z = await call("save_memory", { content: "Zebra crossing notes", source: "claude.ai" });
  assert.equal(z.data.filed_in, "unsorted");
  const rule = await call("add_rule", { rule: "zebra goes in places", source: "claude.ai" });
  assert.equal(rule.data.added, true); assert.ok(rule.data.refiled_unsorted.refiled >= 1);
  const ex2 = await call("explain_filing", { message_id: z.data.message_id });
  assert.equal(ex2.data.category, "places");
  const r2 = await call("add_rule", { rule: "anything mentioning kiwi goes in places", source: "claude.ai" });
  assert.notEqual(r2.data.rule_key, rule.data.rule_key);
});
