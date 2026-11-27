/**
 * Hosted plan limits (owner-approved tiers, 2026-11-26):
 *   Free      1,000 memories, 50 MB, 3 typed rules, no learning / entity shelves / graph / import / daily backups
 *   Personal  $8 per month or $80 per year, unlimited memories and rules, 5 GB, every feature
 *   Team      $15 per seat
 * The pure plan table is checked directly. Enforcement is checked end to end with small overrides so the suite stays fast.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, upgrade, api, connect, tool, type Saas } from "./helpers.ts";
import { PLANS, planFor, MB, GB } from "../src/saas/plans.ts";

test("the plan table is exactly the approved tiers, and the retired numbers are gone", () => {
  const f = PLANS.free;
  assert.deepEqual([f.priceUsdMonthly, f.maxMemories, f.maxBytes, f.maxTypedRules], [0, 1000, 50 * MB, 3]);
  assert.deepEqual(f.features, { learning: false, entityShelves: false, graph: false, importHistory: false, dailyBackups: false });
  const p = PLANS.personal;
  assert.deepEqual([p.priceUsdMonthly, p.priceUsdYearly, p.maxMemories, p.maxBytes, p.maxTypedRules], [8, 80, null, 5 * GB, null]);
  assert.ok(Object.values(p.features).every(Boolean));
  assert.deepEqual([PLANS.team.priceUsdMonthly, PLANS.team.perSeat], [15, true]);
  assert.deepEqual(Object.keys(PLANS), ["free", "personal", "team"]);
  assert.ok(!JSON.stringify(PLANS).includes("callsPerDay"));
  const prices = Object.values(PLANS).flatMap((x) => [x.priceUsdMonthly, x.priceUsdYearly]);
  assert.ok(!prices.includes(49), "the old Team $49 is gone");
  assert.ok(![2000, 300].includes(PLANS.free.maxMemories as number));
});

test("a stored 'pro' plan (pre-migration rows, old Stripe metadata) reads as Personal; unknown ids read as Free", () => {
  assert.equal(planFor("pro").id, "personal");
  assert.equal(planFor("nonsense").id, "free");
  assert.equal(planFor(null).id, "free");
});

let s: Saas;
before(async () => { s = await startSaas({ limitsOverride: { free: { maxMemories: 3, maxBytes: 600, maxTypedRules: 1 } } }); });
after(async () => { await s.close(); });

async function account(email: string, plan?: "personal" | "team") {
  const cookie = await signIn(s, email);
  if (plan) await upgrade(s, cookie, plan);
  const me = (await api(s, cookie)("/api/me")).body;
  const tok = await connect(s, cookie, me.mcp_url);
  return { cookie, me, call: (name: string, args: Record<string, unknown> = {}) => tool(me.mcp_url, tok.access_token, name, args) };
}
const save = (a: Awaited<ReturnType<typeof account>>, content: string) => a.call("save_memory", { content, source: "claude.ai" });

test("Free: the memory cap stops saves with a plain message, while search, read and export still work", async () => {
  const a = await account("pl-mem@example.com");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await save(a, `note number ${i}`); assert.equal(r.isError, false, r.text); ids.push(r.data.message_id); }
  const over = await save(a, "note number 3");
  assert.equal(over.isError, true);
  assert.match(over.text, /Memory limit reached/);
  assert.match(over.text, /Free plan holds 3 memories/);
  assert.match(over.text, /Search, read and export still work/);
  assert.equal((await a.call("read_memory", { message_id: ids[0] })).isError, false);
  assert.equal((await a.call("search_memory", { query: "note" })).isError, false);
  assert.equal((await api(s, a.cookie)("/api/me")).body.usage.memories, 3, "the refused save stored nothing");
  const exp = await api(s, a.cookie)("/api/export");
  assert.equal(exp.status, 200);
});

test("Free: the storage cap counts bytes, rolls a refused save back, and frees space on delete-all", async () => {
  const a = await account("pl-bytes@example.com");
  assert.equal((await save(a, "x".repeat(400))).isError, false);
  const over = await save(a, "y".repeat(400));
  assert.equal(over.isError, true);
  assert.match(over.text, /Storage limit reached/);
  const u = (await api(s, a.cookie)("/api/me")).body.usage;
  assert.equal(u.memories, 1);
  assert.ok(u.bytes >= 400 && u.bytes < 600, `bytes ${u.bytes}`);
  // a smaller save still fits: the refused one did not leave bytes behind
  assert.equal((await save(a, "z".repeat(100))).isError, false);
  await api(s, a.cookie)("/api/delete-all", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) });
  assert.equal((await api(s, a.cookie)("/api/me")).body.usage.bytes, 0);
  assert.equal((await save(a, "w".repeat(400))).isError, false);
});

test("Free: concurrent saves cannot jointly overshoot the memory cap", async () => {
  const a = await account("pl-race@example.com");
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => save(a, `race ${i}`)));
  assert.equal(rs.filter((r) => !r.isError).length, 3);
  assert.equal((await api(s, a.cookie)("/api/me")).body.usage.memories, 3);
});

test("Free: the typed-rule cap refuses the next rule; Personal has no rule cap", async () => {
  const a = await account("pl-rules@example.com");
  const ok = await a.call("add_rule", { rule: "anything mentioning kiwi goes in unsorted", source: "claude.ai" });
  assert.equal(ok.data.added, true, ok.text);
  const over = await a.call("add_rule", { rule: "anything mentioning mango goes in unsorted", source: "claude.ai" });
  assert.equal(over.isError, true);
  assert.match(over.text, /Rule limit reached/);
  assert.match(over.text, /Upgrade to Personal/);
  const p = await account("pl-rules-p@example.com", "personal");
  for (const w of ["kiwi", "mango", "plum", "fig", "lime"]) {
    const r = await p.call("add_rule", { rule: `anything mentioning ${w} goes in unsorted`, source: "claude.ai" });
    assert.equal(r.data.added, true, r.text);
  }
});

test("Free has no people/places/companies shelves; Personal files into them", async () => {
  const free = await account("pl-shelf-f@example.com");
  const pers = await account("pl-shelf-p@example.com", "personal");
  const f = await save(free, "Brendan at Banyan called");
  const p = await save(pers, "Brendan at Banyan called");
  assert.equal(p.data.filed_in, "people");
  assert.notEqual(f.data.filed_in, "people", "Free does not get the entity shelves");
  assert.equal(f.data.filing_recorded, true, "Free still gets librarian filing with the why-trail");
  assert.equal((await free.call("explain_filing", { message_id: f.data.message_id })).isError, false);
});

test("Free: learning from a manual move is off; Personal learns a rule from it", async () => {
  const free = await account("pl-learn-f@example.com");
  const pers = await account("pl-learn-p@example.com", "personal");
  const out: any[] = [];
  for (const a of [free, pers]) {
    const m = await save(a, "grapefruit supply chain notes");
    const mv = await a.call("move_memory", { message_id: m.data.message_id, to_category: "business", source: "claude.ai" });
    out.push(mv.data);
  }
  assert.equal(out[0].moved, true);
  assert.equal(out[0].learned_rule ?? null, null, "Free learns nothing from a move");
  assert.match(out[0].note, /Personal plan/);
  assert.ok(out[1].learned_rule, `Personal learns a rule: ${JSON.stringify(out[1])}`);
});

test("import is a Personal feature: Free gets a 402 with limit 'feature'", async () => {
  const free = await signIn(s, "pl-imp-f@example.com");
  const r = await fetch(`${s.base}/api/import`, { method: "POST", headers: { Cookie: free, Origin: s.base, "X-Requested-With": "test", "Content-Type": "application/zip" }, body: Buffer.from("PK") });
  assert.equal(r.status, 402);
  const b: any = await r.json();
  assert.equal(b.limit, "feature");
  assert.match(b.error, /Personal plan/);
});

test("Personal has no memory cap, and its overrides do not leak from Free's", async () => {
  const a = await account("pl-unl@example.com", "personal");
  for (let i = 0; i < 6; i++) assert.equal((await save(a, `personal note ${i}`)).isError, false);
  const me = (await api(s, a.cookie)("/api/me")).body;
  assert.equal(me.plan.id, "personal");
  assert.equal(me.plan.maxMemories, null);
  assert.equal(me.plan.maxBytes, 5 * GB);
});

test("checkout: only Personal (monthly or yearly) and Team (monthly) can be bought; 'pro' is no longer a plan", async () => {
  const a = await signIn(s, "pl-co@example.com");
  const co = (body: object) => api(s, a)("/api/billing/checkout", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await co({ plan: "personal" })).status, 200);
  const y = await co({ plan: "personal", interval: "year" });
  assert.equal(y.status, 200);
  assert.match(y.body.url, /year/);
  assert.equal((await co({ plan: "team" })).status, 200);
  assert.notEqual((await co({ plan: "team", interval: "year" })).status, 200, "Team has no yearly price");
  assert.notEqual((await co({ plan: "pro" })).status, 200);
  assert.notEqual((await co({ plan: "free" })).status, 200);
});
