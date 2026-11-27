// Security + parity tests for the door: per-source lockout, a separate approvals passphrase, hashed token storage
// (and migration from the old plain-token state file), scribe-with-hands opt-in, duplicate-consent reissue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createOAuth, hashToken } from '../src/oauth.mjs';
import { createApp, instructionsFor } from '../src/server.mjs';
import { createLockout } from '../src/lockout.mjs';

const BASE_ENV = {
  PUBLIC_URL: 'https://door.example.test', AUTH_PASSPHRASE: 'connect-pass', MEMORY_BACKEND_RESOURCE: 'https://door.example.test/mcp-memory',
  MEMORY_BACKEND_BASE: 'http://127.0.0.1:1', HANDS_BACKEND_BASE: 'http://127.0.0.1:1', HANDS_BACKEND_RESOURCE: 'https://door.example.test/mcp-hands',
};
const stub = { ready: () => false, catalog: async () => [], callTool: async () => { throw new Error('unused'); } };

async function boot(env = {}, dir = mkdtempSync(join(tmpdir(), 'door-sec-'))) {
  const config = loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: 'scribe', ...env });
  const stateFile = join(dir, 'oauth-state.json');
  const oauth = createOAuth({ resourceId: `${config.publicUrl}${config.mcpPath}`, stateFile, scopes: config.scopes, defaultScopes: config.defaultScopes, flavour: config.flavour });
  const app = createApp({ config, oauth, backends: stub });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { config, oauth, stateFile, base: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function pending(oauth) {
  const client = oauth.provider.clientsStore.registerClient({ client_name: 't', redirect_uris: ['https://app.example.test/cb'] });
  let html = '';
  await oauth.provider.authorize(client, { redirectUri: 'https://app.example.test/cb', codeChallenge: 'x', scopes: ['memory.read'], state: 's1' }, { status() { return this; }, set() { return this; }, send(h) { html = h; } });
  return { client, id: /name="pending_id" value="([^"]+)"/.exec(html)[1] };
}
const consent = (b, id, passphrase, ip) => fetch(`${b.base}/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams({ pending_id: id, action: 'approve', passphrase }) });

test('lockout: per-source, resets on success, bounded', () => {
  let t = 0; const l = createLockout({ now: () => t, maxEntries: 3 });
  for (let i = 0; i < 4; i++) assert.equal(l.fail('a'), false);
  assert.equal(l.fail('a'), true); assert.ok(l.lockedFor('a') > 0); assert.equal(l.lockedFor('b'), 0);
  t += 16 * 60 * 1000; assert.equal(l.lockedFor('a'), 0);
  l.fail('b'); l.succeed('b'); assert.equal(l.lockedFor('b'), 0);
  for (const k of ['c', 'd', 'e', 'f', 'g']) l.fail(k);
  assert.ok(l.size() <= 4);
});

test('consent: one bad source is locked out; the owner from another address still gets in', async () => {
  const b = await boot();
  try {
    const p = await pending(b.oauth);
    for (let i = 0; i < 5; i++) assert.equal((await consent(b, p.id, 'wrong', '203.0.113.9')).status, 401);
    assert.equal((await consent(b, p.id, 'wrong', '203.0.113.9')).status, 429);
    assert.equal((await consent(b, p.id, 'connect-pass', '203.0.113.9')).status, 429, 'even the right passphrase is refused while locked');
    const ok = await consent(b, p.id, 'connect-pass', '198.51.100.7');
    assert.equal(ok.status, 302); assert.match(ok.headers.get('location'), /code=/);
  } finally { b.close(); }
});

test('consent: a duplicated POST is re-issued, and an unknown id is a 400', async () => {
  const b = await boot();
  try {
    const p = await pending(b.oauth);
    assert.equal((await consent(b, p.id, 'connect-pass', '198.51.100.1')).status, 302);
    assert.equal((await consent(b, p.id, 'connect-pass', '198.51.100.1')).status, 302);
    assert.equal((await consent(b, 'nope', 'x', '198.51.100.1')).status, 400);
  } finally { b.close(); }
});

test('approvals: APPROVALS_PASSPHRASE signs in; the connect passphrase does not; unset = old behaviour', async () => {
  const login = (b, pass) => fetch(`${b.base}/approvals/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase: pass }) });
  const sep = await boot({ GUARD_APPROVER_TOKEN: 't', APPROVALS_PASSPHRASE: 'approve-pass' });
  try {
    assert.equal((await login(sep, 'connect-pass')).status, 401);
    assert.equal((await login(sep, 'approve-pass')).status, 302);
  } finally { sep.close(); }
  const old = await boot({ GUARD_APPROVER_TOKEN: 't' });
  try { assert.equal((await login(old, 'connect-pass')).status, 302); } finally { old.close(); }
});

test('tokens: stored hashed; a version-1 plain-token state file migrates without signing anyone out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'door-mig-'));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(join(dir, 'oauth-state.json'), JSON.stringify({ version: 1, clients: [], accessTokens: [{ token: 'legacy-access', clientId: 'c', scopes: ['memory.read'], resource: undefined, expiresAt: exp }], refreshTokens: [{ token: 'legacy-refresh', clientId: 'c', scopes: ['memory.read'], expiresAt: exp }] }));
  const b = await boot({}, dir);
  try {
    const info = await b.oauth.provider.verifyAccessToken('legacy-access');
    assert.deepEqual(info.scopes, ['memory.read']);
    await new Promise((r) => setTimeout(r, 50));
    const raw = readFileSync(b.stateFile, 'utf8');
    assert.ok(!raw.includes('legacy-access') && !raw.includes('legacy-refresh'), 'plain tokens are gone from disk');
    assert.ok(raw.includes(hashToken('legacy-access')));
    assert.equal(JSON.parse(raw).version, 2);
    // a freshly issued token is also stored hashed only
    const client = b.oauth.provider.clientsStore.registerClient({ client_name: 'n', redirect_uris: ['https://app.example.test/cb'] });
    const p = await pending(b.oauth); const url = b.oauth.approve(p.id); const code = new URL(url).searchParams.get('code');
    const out = await b.oauth.provider.exchangeAuthorizationCode({ client_id: p.client.client_id }, code, undefined, 'https://app.example.test/cb');
    assert.ok(!readFileSync(b.stateFile, 'utf8').includes(out.access_token));
    assert.equal((await b.oauth.provider.verifyAccessToken(out.access_token)).clientId, p.client.client_id);
    await assert.rejects(() => b.oauth.provider.verifyAccessToken(hashToken(out.access_token)), /Invalid or unknown/);
    void client;
  } finally { b.close(); }
});

test('scribe flavour: memory only by default; DOOR_SCRIBE_HANDS=1 adds the PC hands (live parity)', () => {
  const off = loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: 'scribe' });
  assert.deepEqual(Object.keys(off.backends), ['memory']); assert.doesNotMatch(instructionsFor(off), /HANDS:/);
  const on = loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: 'scribe', DOOR_SCRIBE_HANDS: '1' });
  assert.deepEqual(Object.keys(on.backends).sort(), ['hands', 'memory']);
  assert.deepEqual([...on.scopes], ['memory.read', 'memory.write', 'hands.read', 'hands.act']); assert.match(instructionsFor(on), /HANDS:/);
  assert.throws(() => loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: 'scribe', DOOR_SCRIBE_HANDS: '1', HANDS_BACKEND_RESOURCE: '' }), /HANDS_BACKEND_RESOURCE/);
});
