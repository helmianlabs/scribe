import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, classifyAll, distribution, detectShape, parseTags, stripTagLine, notebookLabel,
  PRESETS, PRESET_A, PRESET_B, PRESET_C, PRESET_D, parsePlainRule, learnFromMove, UNSORTED, type MemoryItem,
} from '../src/librarian/index.ts';

const item = (id: number, text: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({ id, text, sender: 'assistant', ...extra });

test('parses the [tags: ...] line and notebook names', () => {
  assert.deepEqual(parseTags('[tags: Hetzner, deploy]\nbody'), ['hetzner', 'deploy']);
  assert.equal(stripTagLine('[tags: a]\nbody'), 'body');
  assert.deepEqual(parseTags('no tags here'), []);
  assert.equal(notebookLabel('Shared Memory — muse'), 'muse');
  assert.equal(notebookLabel('Shared Memory - Claude'), 'claude');
  assert.equal(notebookLabel('Random chat'), null);
});

test('shape detection: pr, commit, error, code, chat', () => {
  assert.equal(detectShape('see https://github.com/sam/forge-tms/pull/12'), 'pr');
  assert.equal(detectShape('pushed commit 7b02805 to main'), 'commit');
  assert.equal(detectShape('TypeError: cannot read properties of undefined'), 'error');
  assert.equal(detectShape('Traceback (most recent call last):\n  File "x.py"'), 'error');
  assert.equal(detectShape('```ts\nconst a = 1\n```'), 'code');
  assert.equal(detectShape('import x from "y";\nconst a = 1;\nexport default a;'), 'code');
  assert.equal(detectShape('Sam wants the reels on FB and IG only.'), 'chat');
});

test('content layer: invoices -> money (preset D finance)', () => {
  const f = classify(item(1, 'Need to send the invoice and check the payment cleared.'), PRESET_D);
  assert.equal(f.category, 'finance');
  assert.equal(f.winningRule, 'content.finance');
  assert.ok(f.tags.includes('money'));
  assert.match(f.explanation, /invoice/);
});

test('project beats topic and shape in preset D', () => {
  const f = classify(item(2, 'Faith N Light Stripe payment for the tumbler went through.'), PRESET_D);
  assert.equal(f.category, 'faith-n-light');
  const g = classify(item(3, '```ts\n// Forge TMS cora tool\nconst x = 1\n```'), PRESET_D);
  assert.equal(g.category, 'forge-tms');
  assert.equal(g.shape, 'code');
  assert.ok(g.tags.includes('code'));
});

test('personal only when no business named (D)', () => {
  assert.equal(classify(item(4, 'Doctor appointment Friday about blood sugar.'), PRESET_D).category, 'personal');
  assert.equal(classify(item(5, 'Order the Faith N Light dad cap.'), PRESET_D).category, 'faith-n-light');
});

test('source layer feeds tags; shape alone files code in D', () => {
  const f = classify(item(6, 'const a = 1;\nconst b = 2;\nreturn a + b;', { conversationName: 'Shared Memory — claude', sender: 'claude' }), PRESET_D);
  assert.equal(f.category, 'code');
  assert.equal(f.source, 'claude');
  assert.ok(f.tags.includes('from:claude'));
});

test('tag on the save line wins over words', () => {
  const f = classify(item(7, '[tags: personal]\nThe deploy to Vercel failed again.'), PRESET_D);
  assert.equal(f.category, 'personal');
  assert.equal(f.winningRule, 'tag.personal');
});

test('unsorted tray: nothing matched, nothing lost', () => {
  const f = classify(item(8, 'Sounds good.'), PRESET_D);
  assert.equal(f.category, UNSORTED);
  assert.equal(f.winningRule, null);
  assert.match(f.explanation, /unsorted tray/);
});

test('whole-word matching: "cora" does not match "coral", "fnl" not inside words', () => {
  assert.notEqual(classify(item(9, 'The coral reef trip.'), PRESET_D).category, 'forge-tms');
  assert.equal(classify(item(10, 'Cora answered the dispatcher.'), PRESET_D).category, 'forge-tms');
});

test('deterministic: same input, same output', () => {
  const i = item(11, 'Helmian runner box on Hetzner needs a deploy.');
  assert.deepEqual(classify(i, PRESET_D), classify(i, PRESET_D));
  assert.equal(classify(i, PRESET_D).category, 'helmian');
});

test('presets A/B/C sort the same item differently', () => {
  const i = item(12, 'DairyForge invoice for the Magic Valley co-op is overdue.');
  assert.equal(classify(i, PRESET_A).category, 'dairyforge-firstuse');
  assert.equal(classify(i, PRESET_B).category, 'money');
  assert.equal(classify(i, PRESET_C).category, 'work/dairyforge-firstuse');
  assert.equal(classify(i, PRESET_D).category, 'dairyforge-firstuse');
  assert.equal(classify(item(13, 'Kids birthday party Saturday.'), PRESET_C).category, 'personal');
  assert.equal(classify(item(14, 'git commit the fix'), PRESET_B).category, 'code');
});

test('every preset rule is valid and every category it files to is declared', () => {
  for (const [k, book] of Object.entries(PRESETS)) {
    const declared = new Set(book.categories.map((c) => c.slug));
    const ids = new Set<string>();
    for (const r of book.rules) {
      assert.ok(!ids.has(r.id), `${k}: duplicate rule id ${r.id}`); ids.add(r.id);
      if (r.category) assert.ok(declared.has(r.category), `${k}: ${r.id} files to undeclared ${r.category}`);
      assert.ok(r.description.length > 0);
    }
  }
});

test('plain-word custom rules', () => {
  const r1 = parsePlainRule('Anything mentioning Saadi or DFA goes in sales leads', 'c1')!;
  assert.deepEqual(r1.when.anyWords, ['Saadi', 'DFA']);
  assert.equal(r1.category, 'sales-leads');
  assert.equal(classify(item(15, 'Call Saadi tomorrow'), PRESET_D, [r1]).category, 'sales-leads');
  const r2 = parsePlainRule('anything from muse goes in muse notes', 'c2')!;
  assert.equal(classify(item(16, 'hello', { conversationName: 'Shared Memory — muse', sender: 'muse' }), PRESET_D, [r2]).category, 'muse-notes');
  // save_memory category notebook files to that project; the words "Shared Memory" alone do not
  assert.equal(classify(item(161, 'new mug idea', { conversationName: 'Shared Memory — faith n light', sender: 'grok' }), PRESET_D).category, 'faith-n-light');
  assert.equal(classify(item(162, 'hello', { conversationName: 'Shared Memory — grok', sender: 'grok' }), PRESET_D).category, 'unsorted');
  assert.equal(classify(item(163, 'hi', { sender: 'human' }), PRESET_D).source, 'claude-archive');
  const r3 = parsePlainRule('errors go in bugs and tag it urgent', 'c3')!;
  const f3 = classify(item(17, 'TypeError: x is undefined'), PRESET_D, [r3]);
  assert.equal(f3.category, 'bugs'); assert.ok(f3.tags.includes('urgent'));
  const r4 = parsePlainRule('anything mentioning tax and receipt goes in taxes', 'c4')!;
  assert.deepEqual(r4.when.allWords, ['tax', 'receipt']);
  assert.equal(parsePlainRule('put stuff somewhere maybe', 'c5'), null);
});

test('learned trigger from a manual move', () => {
  const moved = item(18, 'Notes on the Kokoro voice model latency.');
  assert.equal(classify(moved, PRESET_D).category, UNSORTED);
  const { rule } = learnFromMove(moved, 'helmian', PRESET_D);
  assert.ok(rule, 'a rule is learned');
  assert.equal(rule!.layer, 'learned');
  assert.equal(classify(moved, PRESET_D, [rule!]).category, 'helmian');
  // next item with the learned word now files the same way
  const word = rule!.when.anyWords![0];
  assert.equal(classify(item(19, `More notes on ${word} today.`), PRESET_D, [rule!]).category, 'helmian');
});

test('learning refuses a word that would mis-file reference items', () => {
  const moved = item(20, 'Bryce Stripe');
  const reference = [item(21, 'Bryce sent the Stripe invoice'), item(22, 'Bryce is on the Stripe call about payment')];
  const { rule } = learnFromMove(moved, 'helmian', PRESET_D, [], reference);
  assert.equal(rule, null);
});

test('distribution sums to 100%', () => {
  const f = classifyAll([item(1, 'invoice'), item(2, 'Sounds good'), item(3, 'Forge TMS'), item(4, 'Forge TMS cora')], PRESET_D);
  const d = distribution(f);
  assert.equal(d.reduce((a, b) => a + b.count, 0), 4);
  assert.equal(d[0].category, 'forge-tms');
});

test('conversation context layer: short turns inherit a dominant shelf, mixed chats stay unsorted', async () => {
  const { classifyBatch, CONTEXT_RULE_ID } = await import('../src/librarian/index.ts');
  const conv = 'Route planning';
  const items = [
    item(30, 'Forge TMS load board is slow', { conversationName: conv }),
    item(31, 'Cora missed the route code', { conversationName: conv }),
    item(32, 'dispatcher wants an alert', { conversationName: conv }),
    item(33, 'yeah do that', { conversationName: conv }),
    item(40, 'invoice', { conversationName: 'Mixed' }), item(41, 'Forge TMS', { conversationName: 'Mixed' }),
    item(42, 'Faith N Light', { conversationName: 'Mixed' }), item(43, 'ok', { conversationName: 'Mixed' }),
  ];
  const f = classifyBatch(items, PRESET_D);
  assert.equal(f[3].category, 'forge-tms');
  assert.equal(f[3].winningRule, CONTEXT_RULE_ID);
  assert.match(f[3].explanation, /3 of 3/);
  assert.equal(f[7].category, UNSORTED);
});

test('preset D: infra names alone do not file to a business (Muse migration note)', () => {
  const muse = item(49168, '[tags: librarian, migration, preset-d]\n2026-10-22 (Muse, at Sam\'s go): Migration 001 applied to the claude_memory database (Neon project dairyforge) in the Neon Console - 5 Librarian tables and 3 views created on the production branch; safety branch pre-librarian-20261022 kept as the untouched pre-migration copy. Rulebook preset D recorded in librarian_settings as chosen by Sam. Next step: Paul runs the backfill.', { conversationName: 'Shared Memory — muse', sender: 'muse' });
  const f = classify(muse, PRESET_D);
  assert.notEqual(f.category, 'dairyforge-firstuse');
  assert.equal(f.category, 'shared-memory');
  assert.match(f.explanation, /Ignored as infrastructure names/);
  // Neon project id form, hostnames and paths are ignored too
  for (const t of ['Neon project "dairyforge" (misty-lake-10000001) is out of storage.', 'Pinged dairyforge.replit.app and /workspace/dairyforge/app/src — both up.', 'ssh root@dairyforge.example.com then restart caddy']) {
    assert.notEqual(classify(item(1, t), PRESET_D).category, 'dairyforge-firstuse', t);
  }
  // ...but the business named in plain words still files there
  assert.equal(classify(item(2, 'DairyForge pilot with DFA starts Monday.'), PRESET_D).category, 'dairyforge-firstuse');
  // and in A-C (no ignore list) nothing changed
  assert.equal(classify(item(3, 'Neon project dairyforge'), PRESET_A).category, 'dairyforge-firstuse');
});

test('preset D: truck-driving talk is personal; hauling words file to DairyForge only with product context', () => {
  const drive = classify(item(1, "I'm already unloading the wash, and I'm fueling up, and I'm going to the yard, and then going home."), PRESET_D);
  assert.equal(drive.category, 'personal');
  assert.equal(drive.winningRule, 'content.job-talk');
  assert.equal(classify(item(2, 'Heading home after this load, I was nodding off driving from Mountain Home.'), PRESET_D).category, 'personal');
  assert.equal(classify(item(3, 'Picked up the milk at the dairy, tanker is full, on the road to the plant.'), PRESET_D).category, 'personal');
  // a DairyForge conversation does not pull pure driving talk onto the business shelf
  assert.equal(classify(item(4, 'Traffic on the highway is terrible, running late on my route.', { conversationName: 'DairyForge pilot deal structure' }), PRESET_D).category, 'personal');
  // same hauling words, but about the product -> DairyForge
  const prod = classify(item(5, 'The app should flag the silo meter drift and show it on the dashboard for the dairy.'), PRESET_D);
  assert.equal(prod.category, 'dairyforge-firstuse');
  assert.equal(prod.winningRule, 'content.project-context.dairyforge-firstuse');
  assert.equal(classify(item(6, 'Wash tag scan: if first use is over 72 hours the trailer is blocked.'), PRESET_D).category, 'dairyforge-firstuse');
  // a personal word never beats a named business
  assert.equal(classify(item(7, 'Told my wife the DFA pitch went well.'), PRESET_D).category, 'dairyforge-firstuse');
  // "Big Sister" is Claude, not family
  assert.notEqual(classify(item(8, 'Copy this to Big Sister so Claude can review it.'), PRESET_D).category, 'personal');
});
