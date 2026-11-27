// Runs the real migration SQL against an in-process Postgres (PGlite) with the original schema,
// then exercises the store glue. Proves: additive only, idempotent, reversible, append-only path works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { fileMessage, recordFiling } from '../src/server/librarian-store.ts';
import { classify, OWNER_PRESETS } from '../src/librarian/index.ts';
const PRESET_D = OWNER_PRESETS.D; // the single-tenant store uses the owner pack by default

const BASE = `
CREATE ROLE memory_rw; CREATE ROLE memory_ro_hz;
CREATE TABLE projects (uuid TEXT PRIMARY KEY, name TEXT, raw JSONB);
-- matches the live claude_memory schema read on 2026-10-22 (no FKs, no CHECKs, no defaults except the id sequence)
CREATE TABLE conversations (uuid TEXT PRIMARY KEY, name TEXT, project_uuid TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, message_count INT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_uuid TEXT, turn_index INT, sender TEXT, text TEXT, created_at TIMESTAMPTZ);
CREATE INDEX idx_messages_created ON messages (created_at); CREATE INDEX idx_messages_conv ON messages (conversation_uuid);
INSERT INTO conversations(uuid,name) VALUES ('c1','Shared Memory — muse'), ('c2','Forge TMS planning');
INSERT INTO messages(conversation_uuid,sender,text) VALUES ('c1','assistant','[tags: hetzner]\nHelmian runner deploy done'), ('c2','human','Sounds good'), ('c2','human','invoice paid');
`;
const up = readFileSync('migrations/001_librarian.sql', 'utf8');
const down = readFileSync('migrations/001_librarian.down.sql', 'utf8');
const snapshot = async (db: PGlite) => (await db.query<{ n: number }>('SELECT count(*)::int n FROM messages')).rows[0].n;

test('migration is additive, idempotent and reversible', async () => {
  const db = new PGlite();
  await db.exec(BASE);
  const before = await snapshot(db);
  await db.exec(up);
  await db.exec(up); // idempotent
  assert.equal(await snapshot(db), before);
  const un = await db.query<{ message_id: number }>('SELECT message_id FROM memory_unsorted ORDER BY message_id');
  assert.equal(un.rows.length, 3, 'all unfiled messages show in the unsorted tray');

  // file message 1 via the store glue, message 3 via backfill path
  const m = (await db.query<any>('SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m JOIN conversations c ON c.uuid=m.conversation_uuid ORDER BY m.id')).rows;
  const f1 = await fileMessage(db as any, { id: m[0].id, text: m[0].text, sender: m[0].sender, conversationName: m[0].conv });
  assert.equal(f1?.category, 'helmian');
  await recordFiling(db as any, m[2].id, classify({ id: m[2].id, text: m[2].text, conversationName: m[2].conv }, PRESET_D), 'backfill');
  const cur = (await db.query<any>('SELECT message_id, category, rule_key FROM memory_current_filing ORDER BY message_id')).rows;
  assert.deepEqual(cur.map((r) => r.category), ['helmian', 'forge-tms']);
  const un2 = await db.query('SELECT message_id FROM memory_unsorted');
  assert.equal(un2.rows.length, 1);

  // a manual move is a new row; history kept
  await recordFiling(db as any, m[0].id, { ...f1!, category: 'code', winningRule: null, explanation: 'Moved by Sam.' }, 'manual');
  assert.equal((await db.query<any>('SELECT category FROM memory_current_filing WHERE message_id=$1', [m[0].id])).rows[0].category, 'code');
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM memory_filings WHERE message_id=$1', [m[0].id])).rows[0].n, 2);

  // grants: memory_rw has no UPDATE/DELETE on librarian tables
  const g = (await db.query<any>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='memory_rw' AND table_name='memory_filings' ORDER BY 1`)).rows.map((r) => r.privilege_type);
  assert.deepEqual(g, ['INSERT', 'SELECT']);

  await db.exec(down);
  assert.equal(await snapshot(db), before, 'down migration leaves memory rows untouched');
  const left = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
  assert.deepEqual(left.rows.map((r: any) => r.table_name), ['conversations', 'messages', 'projects']);
});

test('tool handlers: move learns a trigger, plain rule files new items, unsorted tray shrinks', async () => {
  const { moveMemory, addPlainRule, listUnsorted, explainFiling, fileMessage } = await import('../src/server/librarian-store.ts');
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(up);
  await db.exec(`INSERT INTO messages(conversation_uuid,sender,text) VALUES ('c2','human','Kokoro voice latency is 900ms')`);
  const id = (await db.query<any>(`SELECT id FROM messages WHERE text LIKE 'Kokoro%'`)).rows[0].id;
  const res = await moveMemory(db as any, id, 'helmian', 'sam');
  assert.equal(res.to, 'helmian');
  assert.ok(res.learned, 'learned a trigger');
  assert.equal((await explainFiling(db as any, id)).category, 'helmian');
  await db.exec(`INSERT INTO messages(conversation_uuid,sender,text) VALUES ('c1','assistant','More Kokoro tuning tonight')`);
  const id2 = (await db.query<any>(`SELECT id FROM messages WHERE text LIKE 'More Kokoro%'`)).rows[0].id;
  const f = await fileMessage(db as any, { id: id2, text: 'More Kokoro tuning tonight', conversationName: 'Shared Memory — muse' });
  assert.equal(f?.category, 'helmian');
  const add = await addPlainRule(db as any, 'anything mentioning Bryce goes in testers', 'sam', { confirmNewCategory: true });
  assert.ok(add.ok);
  const f3 = await fileMessage(db as any, { id: 999, text: 'Bryce signed up', conversationName: 'x' });
  assert.equal(f3?.category, 'testers');
  const tray = await listUnsorted(db as any);
  assert.ok(Array.isArray(tray));
});

test('bulk backfill insert files every message once and empties the tray', async () => {
  const { recordFilingsBulk } = await import('../src/server/librarian-store.ts');
  const { classifyBatch } = await import('../src/librarian/index.ts');
  const db = new PGlite();
  await db.exec(BASE); await db.exec(up);
  const m = (await db.query<any>('SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid=m.conversation_uuid ORDER BY m.id')).rows;
  const f = classifyBatch(m.map((x) => ({ id: x.id, text: x.text, sender: x.sender, conversationName: x.conv })), PRESET_D);
  await recordFilingsBulk(db as any, f, 'backfill');
  const n = (await db.query<any>("SELECT count(*)::int n FROM memory_filings WHERE filed_by='backfill'")).rows[0].n;
  assert.equal(n, m.length);
  const tags = (await db.query<any>('SELECT tags FROM memory_filings ORDER BY message_id LIMIT 1')).rows[0].tags;
  assert.ok(Array.isArray(tags));
  const tray = (await db.query<any>('SELECT count(*)::int n FROM memory_unsorted')).rows[0].n;
  assert.equal(tray, f.filter((x) => x.category === 'unsorted').length);
});
