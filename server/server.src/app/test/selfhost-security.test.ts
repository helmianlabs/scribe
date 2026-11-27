/**
 * Self-host server (single.ts) security: consent lockout per source, empty POST /consent is a 400 (it was a 500),
 * and OAuth tokens are stored hashed with a migration from the old plain-token file. Runs the real server as a
 * child process (the OAuth provider is module-level state configured from the environment).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createLockout } from "../src/lockout.ts";

// same definition as hashToken() in src/oauth-provider.ts (importing it here would load the server config)
const hashToken = (t: string) => createHash("sha256").update(t).digest("base64url");
const kids: ChildProcess[] = [];
const dirs: string[] = [];
after(() => { for (const k of kids) k.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

async function boot(stateJson?: object) {
  const dir = mkdtempSync(join(tmpdir(), "single-sec-")); dirs.push(dir);
  const stateFile = join(dir, "oauth-state.json");
  if (stateJson) writeFileSync(stateFile, JSON.stringify(stateJson));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/single.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, AUTH_PASSPHRASE: "right-pass",
      DATABASE_URL: "postgres://x:y@127.0.0.1:1/z", DATABASE_WRITE_URL: "postgres://x:y@127.0.0.1:1/z", OAUTH_STATE_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20000);
    const seen = (b: Buffer) => { if (String(b).includes("listening")) { clearTimeout(t); resolve(); } };
    child.stdout!.on("data", seen); child.stderr!.on("data", seen);
    child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  return { base: `http://127.0.0.1:${port}`, stateFile, child };
}

async function pendingId(base: string): Promise<string> {
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "t", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json() as any;
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "memory.read", state: "s" });
  const html = await (await fetch(`${base}/authorize?${q}`)).text();
  return /name="pending_id" value="([^"]+)"/.exec(html)![1];
}
const post = (base: string, body: Record<string, string>, ip: string) => fetch(`${base}/consent`, { method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams(body) });

test("lockout helper: per source, bounded, reset on success", () => {
  let t = 0; const l = createLockout({ now: () => t, maxEntries: 2 });
  for (let i = 0; i < 4; i++) assert.equal(l.fail("a"), false);
  assert.equal(l.fail("a"), true); assert.ok(l.lockedFor("a") > 0); assert.equal(l.lockedFor("b"), 0);
  t += 16 * 60_000; assert.equal(l.lockedFor("a"), 0);
  for (const k of ["c", "d", "e", "f"]) l.fail(k);
  assert.ok(l.size() <= 3); l.succeed("f"); assert.equal(l.lockedFor("f"), 0);
});

test("single.ts /consent: empty POST is 400 (not 500); bad source locked out, owner elsewhere not; tokens stored hashed", async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const s = await boot({ version: 1, clients: [], accessTokens: [{ token: "legacy-access", clientId: "c", scopes: ["memory.read"], expiresAt: exp }], refreshTokens: [{ token: "legacy-refresh", clientId: "c", scopes: ["memory.read"], expiresAt: exp }] });

  // empty / non-form POSTs
  assert.equal((await fetch(`${s.base}/consent`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`${s.base}/consent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await post(s.base, {}, "192.0.2.1")).status, 400);

  // migration: plain tokens leave the disk, the legacy token still works (a bearer call gets past auth)
  await new Promise((r) => setTimeout(r, 300));
  const raw = readFileSync(s.stateFile, "utf8");
  assert.ok(!raw.includes("legacy-access") && !raw.includes("legacy-refresh"));
  assert.ok(raw.includes(hashToken("legacy-access"))); assert.equal(JSON.parse(raw).version, 2);
  const withLegacy = await fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: "Bearer legacy-access", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  const withBogus = await fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: "Bearer bogus", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(withBogus.status, 401); assert.notEqual(withLegacy.status, 401, "migrated token is still accepted");

  // lockout
  const id = await pendingId(s.base);
  for (let i = 0; i < 5; i++) assert.equal((await post(s.base, { pending_id: id, action: "approve", passphrase: "no" }, "203.0.113.5")).status, 401);
  assert.equal((await post(s.base, { pending_id: id, action: "approve", passphrase: "no" }, "203.0.113.5")).status, 429);
  assert.equal((await post(s.base, { pending_id: id, action: "approve", passphrase: "right-pass" }, "203.0.113.5")).status, 429);
  const ok = await post(s.base, { pending_id: id, action: "approve", passphrase: "right-pass" }, "198.51.100.2");
  assert.equal(ok.status, 302); assert.match(ok.headers.get("location")!, /code=/);
});
