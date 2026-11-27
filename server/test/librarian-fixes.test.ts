// Tests for the forensic-audit fixes: learning, chaining, grammar, shelf-name checks, entity rules,
// full rule trail, retry + repair path, unique rule ids under concurrency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  checkCategory, classify, classifyBatch, knownCategories, learnFromMove, MAX_CHAIN_PASSES, parsePlainRule, planBackfill, PRESET_D, PRESETS,
  trailOf, UNSORTED, withRetry, type MemoryItem, type Rule, type Rulebook,
} from '../src/librarian/index.ts';
import { addPlainRule, explainFiling, fileMessage, moveMemory, refileUnsorted } from '../src/server/librarian-store.ts';

const item = (id: number, text: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({ id, text, ...extra });
const cat = (text: string, extra: Rule[] = []) => classify(item(1, text), PRESET_D, extra);

// ---------------------------------------------------------------- 2. learning is not blocked by unsorted look-alikes
test('learning: an unsorted memory that shares the word does not block the lesson; a real conflict still does', () => {
  const moved = item(1, 'Notes on the Kokoro voice model latency.');
  const unsortedTwin = item(2, 'Kokoro again, nothing else to say');
  assert.equal(classify(unsortedTwin, PRESET_D).category, UNSORTED);
  const { rule } = learnFromMove(moved, 'helmian', PRESET_D, [], [moved, unsortedTwin]);
  assert.ok(rule, 'a rule is learned even though another unsorted memory shares the word');
  assert.equal(classify(unsortedTwin, PRESET_D, [rule!]).category, 'helmian', 'and the look-alike now files too');

  // A memory that is really filed elsewhere IS a conflict for that word.
  const filedElsewhere = item(3, 'Kokoro deploy checklist for the docker build'); // files in code
  assert.equal(classify(filedElsewhere, PRESET_D).category, 'code');
  const res = learnFromMove(moved, 'helmian', PRESET_D, [], [moved, filedElsewhere]);
  assert.ok(!res.rule || res.rule.when.anyWords![0] !== 'kokoro', 'the conflicting word is not chosen');
});

// ---------------------------------------------------------------- 5. rule chaining
const rule = (id: string, over: Partial<Rule>): Rule => ({ id, layer: 'custom', priority: 900, description: id, when: {}, ...over } as Rule);

test('chaining: tags added by rule A are visible to rule B (custom/learned rules), bounded, and loop-free', () => {
  const a = rule('custom.a', { when: { anyWords: ['banyan'] }, addTags: ['customer'] });
  const b = rule('custom.b', { when: { tags: ['customer'] }, category: 'customers', priority: 901 });
  const f = cat('Banyan sent the contract', [a, b]);
  assert.equal(f.category, 'customers');
  assert.equal(f.winningRule, 'custom.b');
  const hitB = f.hits.find((h) => h.ruleId === 'custom.b')!;
  assert.equal(hitB.pass, 2);
  assert.match(hitB.via!.join(' '), /customer \(from rule custom\.a\)/);
  assert.match(hitB.matched.join(' '), /added by rule custom\.a/);

  // a chain three rules deep
  const c1 = rule('custom.c1', { when: { anyWords: ['zork'] }, addTags: ['t1'] });
  const c2 = rule('custom.c2', { when: { tags: ['t1'] }, addTags: ['t2'] });
  const c3 = rule('custom.c3', { when: { tags: ['t2'] }, category: 'deep', priority: 905 });
  assert.equal(cat('zork', [c1, c2, c3]).category, 'deep');

  // loops: X -> Y -> X. Every rule fires once and the engine stops.
  const x = rule('custom.x', { when: { anyWords: ['loop'], tags: undefined }, addTags: ['ty'] });
  const x2 = rule('custom.x2', { when: { tags: ['tx'] }, addTags: ['ty'] });
  const y = rule('custom.y', { when: { tags: ['ty'] }, addTags: ['tx'] });
  const z = rule('custom.z', { when: { tags: ['tx'] }, category: 'looped', priority: 950 });
  const loop = cat('loop', [x, x2, y, z]);
  assert.equal(loop.category, 'looped');
  assert.equal(loop.hits.filter((h) => h.ruleId === 'custom.y').length, 1, 'no rule fires twice');
  assert.ok(Math.max(...loop.hits.map((h) => h.pass ?? 1)) <= MAX_CHAIN_PASSES);

  // bounded: a chain longer than MAX_CHAIN_PASSES stops at the cap
  const long: Rule[] = [rule('custom.l0', { when: { anyWords: ['go'] }, addTags: ['l1'] })];
  for (let i = 1; i <= MAX_CHAIN_PASSES + 2; i++) long.push(rule(`custom.l${i}`, { when: { tags: [`l${i}`] }, addTags: [`l${i + 1}`], ...(i === MAX_CHAIN_PASSES + 2 ? { category: 'toofar' } : {}) }));
  assert.notEqual(cat('go', long).category, 'toofar', 'a chain deeper than the cap does not complete');

  // built-in preset rules keep seeing only written tags: "money" added by a finance word does not trigger the finance tag rule
  assert.equal(cat('Helmian needs a invoice for Brendan').category, 'helmian');
});

// ---------------------------------------------------------------- 6. grammar + shelf names
test('grammar: "X goes in Y" and friends', () => {
  const r = (s: string) => parsePlainRule(s, 'custom.t');
  assert.deepEqual(r('invoices go in finance')!.when.anyWords, ['invoices']);
  assert.equal(r('invoices go in finance')!.category, 'finance');
  assert.deepEqual(r('banyan or giltner goes in organizations')!.when.anyWords, ['banyan', 'giltner']);
  assert.deepEqual(r('brendan and banyan go in people')!.when.allWords, ['brendan', 'banyan']);
  assert.deepEqual(r('put invoices in finance')!.when.anyWords, ['invoices']);
  assert.deepEqual(r('file Samsara under organizations')!.when.anyWords, ['Samsara']);
  assert.deepEqual(r('everything about Stripe goes in finance')!.when.anyWords, ['Stripe']);
  assert.deepEqual(r('anything mentioning chatgpt goes in for-chatgpt and tag it chatgpt')!.addTags, ['chatgpt']); // old form unchanged
  assert.deepEqual(r('errors go in bugs')!.when.shape, ['error']);                                                  // shapes still win
  const ent = r('Banyan is a customer')!;
  assert.equal(ent.category, 'organizations'); assert.deepEqual(ent.when.anyWords, ['Banyan']); assert.deepEqual(ent.addTags, ['organization']);
  assert.equal(r('Jerome is a place')!.category, 'places');
  assert.equal(r('Brendan is a person')!.category, 'people');
  assert.equal(r('this is a mess'), null);
  assert.equal(r('it goes in finance'), null);
  assert.equal(r('hello'), null);
});

test('shelf names: typos are refused with suggestions unless confirmed; mailboxes and known shelves pass', () => {
  const known = knownCategories(PRESET_D, [], ['for-muse', 'testers']);
  assert.deepEqual(checkCategory('finance', known), { ok: true, slug: 'finance', isNew: false });
  const typo = checkCategory('Finnace', known);
  assert.equal(typo.ok, false);
  assert.ok(!typo.ok && typo.didYouMean.includes('finance'));
  assert.match((typo as any).note, /confirm_new_category/);
  assert.deepEqual(checkCategory('finnace', known, true), { ok: true, slug: 'finnace', isNew: true });
  assert.equal(checkCategory('for-grok', known).ok, true, 'a for-<agent> mailbox is an address, not a topic');
  assert.equal(checkCategory('person', known).ok, false);
  assert.ok(!checkCategory('person', known).ok && (checkCategory('person', known) as any).didYouMean.includes('personal'));
  assert.equal(checkCategory('Bad Name!!', known).ok, false);
  assert.equal(checkCategory('people', known).ok, true, 'the new entity shelves are declared in preset D');
});

// ---------------------------------------------------------------- 4. entity shelves + the audit samples
test('audit samples: people, places, organizations; trucking and day-job words no longer outrank money or a company name', () => {
  const want: [string, string][] = [
    ['Brendan at Banyan called', 'people'],
    ['Pick up Brendan from the airport', 'people'],
    ['Lunch with Dr. Patel', 'people'],
    ['Jerome Idaho', 'places'],
    ['Twin Falls Idaho yard', 'places'],
    ['Chobani plant in Twin Falls', 'places'],
    ['Giltner trucking', 'organizations'],
    ['Hauling for Giltner trucking in Jerome Idaho', 'organizations'],
    ['invoice from Giltner trucking for $400', 'finance'],
    ['invoice for hauling milk last week, paid by check', 'finance'],
    // nothing that files today moves:
    ['hauling milk to Jerome tomorrow', 'personal'],
    ['Hauling milk for the new app dashboard', 'dairyforge-firstuse'],
    ['Meeting with Glanbia about the pilot program', 'dairyforge-firstuse'],
    ['Forge TMS dispatch board demo for investor', 'forge-tms'],
    ['Helmian needs a invoice for Brendan', 'helmian'],
    ['Called my wife about the doctor appointment', 'personal'],
    ['Mom called', 'personal'],
    ['Claude called a tool in Python', 'code'],
    ['Deploy needs a fix in March', 'code'],
    // still unsorted: a bare name or a bare vendor carries no clue (teach it with add_rule "X is a customer")
    ['Samsara camera', UNSORTED], ['Glanbia', UNSORTED], ['Brendan', UNSORTED], ['Jerome', UNSORTED], ['Sounds good', UNSORTED],
  ];
  for (const [text, expected] of want) assert.equal(cat(text).category, expected, text);
  // teaching beats the heuristics and applies to every future memory
  const taught = parsePlainRule('Samsara is a customer', 'custom.9')!;
  assert.equal(cat('Samsara camera', [taught]).category, 'organizations');
  assert.equal(cat('Call Banyan', [parsePlainRule('Banyan is a customer', 'custom.10')!]).category, 'organizations');
  // presets A-C are untouched by the entity rules
  for (const k of ['A', 'B', 'C'] as const) assert.ok(!PRESETS[k].rules.some((x) => ['content.person-cue', 'content.person-at-org', 'content.place-cue', 'content.place-words', 'content.org-named', 'content.finance-job'].includes(x.id)));
  // database rules never run patterns
  const sneaky: Rule = { id: 'custom.p', layer: 'custom', priority: 999, description: 'x', category: 'evil', when: { patterns: ['.*'] } };
  assert.equal(cat('anything at all', [sneaky]).category, UNSORTED);
});

// ---------------------------------------------------------------- 5. the full trail
test('trail: every matched rule is listed with its words, and the deciding rule is marked', () => {
  const f = cat('invoice from Giltner trucking for $400');
  const t = trailOf(f.hits, f.winningRule, f.category);
  assert.equal(t.length, f.hits.length);
  assert.ok(t.length >= 4, 'more than just the winner');
  assert.equal(t.filter((s) => s.decided).length, 1);
  assert.equal(t.find((s) => s.decided)!.rule_key, 'content.finance-job');
  assert.ok(t.every((s) => s.why && s.matched.length));
  assert.deepEqual(t.map((s) => s.priority), [...t.map((s) => s.priority)].sort((a, b) => b - a));
});

// ---------------------------------------------------------------- 3. retry + repair, and stored-store behaviour (PGlite)
const BASE = `
CREATE ROLE memory_rw; CREATE ROLE memory_ro_hz;
CREATE TABLE projects (uuid TEXT PRIMARY KEY, name TEXT, raw JSONB);
CREATE TABLE conversations (uuid TEXT PRIMARY KEY, name TEXT, project_uuid TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, message_count INT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_uuid TEXT, turn_index INT, sender TEXT, text TEXT, created_at TIMESTAMPTZ DEFAULT now());
INSERT INTO conversations(uuid,name) VALUES ('c1','Shared Memory — muse');
`;
async function freshStore() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(readFileSync('migrations/001_librarian.sql', 'utf8'));
  return db;
}
async function addMsg(db: PGlite, text: string) {
  return Number((await db.query<any>("INSERT INTO messages(conversation_uuid,sender,text) VALUES ('c1','assistant',$1) RETURNING id", [text])).rows[0].id);
}

test('retry: a transient failure is retried; a permanent one is not; the final failure is reported, never silent', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw Object.assign(new Error('connection reset'), { code: '08006' }); return 'ok'; };
  assert.equal(await withRetry(flaky, { sleep: async () => {} }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('no table'), { code: '42P01' }); }, { sleep: async () => {} }));
  assert.equal(calls, 1, 'missing table is permanent, not retried');
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('down'); }, { attempts: 4, sleep: async () => {} }));
  assert.equal(calls, 4);
});

test('repair: a filing that fails twice is retried and lands; one that always fails is reported and then repaired by refileUnsorted', async () => {
  const db = await freshStore();
  const id = await addMsg(db, 'Brendan at Banyan called');
  let failures = 2;
  const flakyDb = { query: async (sql: string, p?: unknown[]) => { if (/INSERT INTO memory_filings/.test(sql) && failures-- > 0) throw new Error('connection reset'); return db.query(sql, p as any[]); } };
  const f = await fileMessage(flakyDb as any, item(id, 'Brendan at Banyan called', { conversationName: 'Shared Memory — muse' }), { retry: { sleep: async () => {} } });
  assert.equal(f?.category, 'people', 'filed on the third try');
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_filings WHERE message_id=$1', [id])).rows[0].n, 1, 'exactly one filing, no duplicates');

  const id2 = await addMsg(db, 'Giltner trucking');
  const errors: unknown[] = [];
  const deadDb = { query: async (sql: string, p?: unknown[]) => { if (/INSERT INTO memory_filings/.test(sql)) throw new Error('database down'); return db.query(sql, p as any[]); } };
  const none = await fileMessage(deadDb as any, item(id2, 'Giltner trucking'), { retry: { sleep: async () => {} }, onError: (e) => errors.push(e) });
  assert.equal(none, null);
  assert.equal(errors.length, 1, 'the failure was reported, not swallowed');
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_unsorted WHERE message_id=$1', [id2])).rows[0].n, 1, 'it waits in the tray as "not filed yet"');

  const res = await refileUnsorted(db as any);
  assert.equal(res.refiled, 1);
  assert.equal((await db.query<any>('SELECT category FROM memory_current_filing WHERE message_id=$1', [id2])).rows[0].category, 'organizations');
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_unsorted')).rows[0].n, 0);
  assert.equal((await refileUnsorted(db as any)).refiled, 0, 'second run is a no-op');
});

test('a new rule re-files the unsorted tray, and a learned rule from a move does too', async () => {
  const db = await freshStore();
  const a = await addMsg(db, 'Kokoro latency is 900ms');
  const b = await addMsg(db, 'More Kokoro tuning tonight');
  for (const id of [a, b]) await fileMessage(db as any, item(id, id === a ? 'Kokoro latency is 900ms' : 'More Kokoro tuning tonight'), { retry: { sleep: async () => {} } });
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_unsorted')).rows[0].n, 2);
  const added = await addPlainRule(db as any, 'anything mentioning kokoro goes in helmian', 'troy');
  assert.equal(added.ok, true);
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_unsorted')).rows[0].n, 0, 'both tray items were re-filed by the new rule');
  assert.deepEqual((await db.query<any>('SELECT DISTINCT category FROM memory_current_filing')).rows.map((r) => r.category), ['helmian']);

  const c = await addMsg(db, 'Samsara camera install');
  const d = await addMsg(db, 'Samsara again, same camera');
  for (const [id, t] of [[c, 'Samsara camera install'], [d, 'Samsara again, same camera']] as const) await fileMessage(db as any, item(id, t));
  const mv = await moveMemory(db as any, c, 'organizations', 'troy');
  assert.equal(mv.moved, true);
  assert.ok(mv.learned, 'learned a rule although a look-alike (message d) is in the tray');
  assert.equal((await db.query<any>('SELECT category FROM memory_current_filing WHERE message_id=$1', [d])).rows[0].category, 'organizations', 'the look-alike was re-filed');
});

test('explain_filing returns the full matched list, and a move refreshes the stored matches', async () => {
  const db = await freshStore();
  const id = await addMsg(db, 'invoice from Giltner trucking for $400');
  await fileMessage(db as any, item(id, 'invoice from Giltner trucking for $400'));
  const e1: any = await explainFiling(db as any, id);
  assert.ok(e1.matched_rules.length >= 4);
  assert.equal(e1.matched_rules.filter((s: any) => s.decided).length, 1);
  assert.match(e1.trail_summary, /rules matched/);
  assert.equal(e1.hits, undefined);

  const mv = await moveMemory(db as any, id, 'organizations', 'troy');
  assert.equal(mv.moved, true);
  const e2: any = await explainFiling(db as any, id);
  assert.equal(e2.category, 'organizations');
  assert.equal(e2.matched_rules[0].rule_key, 'manual.move', 'the hand move is on the trail');
  assert.ok(e2.matched_rules.length >= e1.matched_rules.length, 'the rest of the trail is the CURRENT match list');
  if (mv.learned) assert.ok(e2.matched_rules.some((s: any) => s.rule_key === mv.learned), 'the rule learned from this move is on the trail');
  assert.deepEqual((await explainFiling(db as any, 424242)).matched_rules, []);
});

test('add_rule: ids are unique under concurrency; unknown shelf names need confirmation', async () => {
  const db = await freshStore();
  const sentences = Array.from({ length: 8 }, (_, i) => `anything mentioning word${i} goes in finance`);
  const out = await Promise.all(sentences.map((s) => addPlainRule(db as any, s, 'troy')));
  const keys = out.map((o) => o.rule!.id);
  assert.equal(new Set(keys).size, 8, `ids ${keys.join(' ')}`);
  const active = (await db.query<any>('SELECT rule_key FROM librarian_active_rules')).rows;
  assert.equal(active.length, 8, 'no rule overwrote another');

  const typo = await addPlainRule(db as any, 'anything mentioning stripe goes in finnace', 'troy');
  assert.equal(typo.ok, false); assert.equal(typo.needs_confirmation, true); assert.ok(typo.did_you_mean!.includes('finance'));
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM librarian_rules')).rows[0].n, 8, 'nothing was written');
  assert.equal((await addPlainRule(db as any, 'anything mentioning stripe goes in finnace', 'troy', { confirmNewCategory: true })).ok, true);
  assert.equal((await addPlainRule(db as any, 'gibberish', 'troy')).ok, false);

  const id = await addMsg(db, 'Notes on the Kokoro latency');
  const mv = await moveMemory(db as any, id, 'finanse', 'troy');
  assert.equal(mv.moved, false); assert.equal(mv.needs_confirmation, true);
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_moves')).rows[0].n, 0);
  assert.equal((await moveMemory(db as any, id, 'for-grok', 'troy')).moved, true, 'a mailbox is a valid destination');
});

// ---------------------------------------------------------------- 3. backfill plan
test('backfill plan: uses custom + learned rules, re-files unsorted, leaves real shelves alone', () => {
  const custom = parsePlainRule('anything mentioning kokoro goes in helmian', 'custom.1')!;
  const learned: Rule = { id: 'learned.helmian.runner', layer: 'learned', when: { anyWords: ['runner'] }, category: 'helmian', priority: 950, description: 'x' };
  const items = [
    item(1, 'never filed: Kokoro latency'),         // new -> custom rule
    item(2, 'in the tray: runner restarted'),        // unsorted now -> learned rule files it
    item(3, 'in the tray: nothing to see'),          // unsorted, still no rule
    item(4, 'Helmian plan for tomorrow'),            // already on a shelf: left alone
    item(5, 'forced: Kokoro again'),                 // already on a shelf but listed
  ];
  const current = new Map([['2', UNSORTED], ['3', UNSORTED], ['4', 'helmian'], ['5', 'code']]);
  const plan = planBackfill(items, current, PRESET_D, [custom, learned], new Set(['5']));
  assert.deepEqual(plan.toWrite.map((f) => [f.itemId, f.category]), [[1, 'helmian'], [2, 'helmian'], [5, 'helmian']]);
  assert.deepEqual({ n: plan.newlyFiled, r: plan.refiledUnsorted, f: plan.forced, s: plan.skipped, u: plan.stillUnsorted }, { n: 1, r: 1, f: 1, s: 1, u: 1 });
  // the old behaviour (preset only) would have left 1 and 2 unsorted
  assert.equal(classifyBatch(items, PRESET_D)[0].category, UNSORTED);
});
