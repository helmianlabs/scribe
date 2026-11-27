/**
 * No-signup try path: guest tenant, first-party token, save/recall, isolation,
 * and email sign-in disabled when the mailer is off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSaas, tool, mcp } from "./helpers.ts";
import { isGuestEmail } from "../src/saas/accounts.ts";

test("POST /try creates an isolated memory and a token that can save and recall", async () => {
  const s = await startSaas();
  try {
    const r = await fetch(`${s.base}/try`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    assert.equal(r.status, 201);
    const body = await r.json() as { mcp_url: string; access_token: string; install: { one_line: string }; dashboard: string };
    assert.match(body.mcp_url, /^http:\/\/127\.0\.0\.1:\d+\/t\/[a-z0-9]+\/mcp$/);
    assert.ok(body.access_token.length > 16);
    assert.ok(body.install.one_line.includes(body.mcp_url));
    assert.ok(body.install.one_line.includes("Authorization: Bearer"));
    assert.ok(r.headers.get("set-cookie")?.includes("smm_session="));

    const saved = await tool(body.mcp_url, body.access_token, "save_memory", {
      content: "The try-path canary is a blue spruce in the yard.",
      source: "cursor",
    });
    assert.equal(saved.isError, false);
    const found = await tool(body.mcp_url, body.access_token, "search_memory", { query: "blue spruce canary" });
    assert.equal(found.isError, false);
    const blob = JSON.stringify(found.data);
    assert.match(blob, /blue spruce/i);

    // A second guest cannot see the first guest's memory.
    const r2 = await fetch(`${s.base}/try`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    const b2 = await r2.json() as { mcp_url: string; access_token: string };
    assert.notEqual(b2.mcp_url, body.mcp_url);
    const other = await tool(b2.mcp_url, b2.access_token, "search_memory", { query: "blue spruce canary" });
    const otherBlob = JSON.stringify(other.data);
    assert.doesNotMatch(otherBlob, /blue spruce/i);

    // Token for tenant A is refused on tenant B's URL.
    const cross = await mcp(b2.mcp_url, body.access_token, "initialize", {});
    assert.equal(cross.status, 403);
  } finally {
    await s.close();
  }
});

test("email sign-in is refused when the mailer is off; /try still works", async () => {
  const s = await startSaas({ mail: { provider: "off", from: null, outboxFile: "/tmp/smm-test-outbox.jsonl" } });
  try {
    const start = await fetch(`${s.base}/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: s.base },
      body: JSON.stringify({ email: "person@example.com" }),
    });
    assert.equal(start.status, 503);
    const err = await start.json() as { error: string; try: string };
    assert.match(err.error, /try/i);
    assert.equal(err.try, "/try");

    const login = await fetch(`${s.base}/login`);
    const html = await login.text();
    assert.match(html, /Try without signing up/);
    assert.doesNotMatch(html, /Email me a sign-in link/);

    const tryGet = await fetch(`${s.base}/try`);
    assert.equal(tryGet.status, 200);
    assert.match(await tryGet.text(), /Create my memory/);
  } finally {
    await s.close();
  }
});
test("guest emails use the reserved invalid domain", () => {
  assert.equal(isGuestEmail("guest-abc@try.scribemem.invalid"), true);
  assert.equal(isGuestEmail("troy@dairyforge.com"), false);
});
