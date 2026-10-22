import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverAlert, signWebhook, verifyWebhookSignature } from "../src/flags/alerts.ts";
import { moderate } from "../src/flags/moderation.ts";

const flag = { severity: "critical" as const, category: "secret", reason: "A GitHub token was found.", excerpt: "token [REDACTED:github_token]" };

test("no keys configured: email and webhook are stubbed, nothing is sent", async () => {
  const saved = { ...process.env };
  delete process.env.RESEND_API_KEY; delete process.env.ALERT_WEBHOOK_SECRET; delete process.env.MAIL_FROM;
  let calls = 0;
  const r = await deliverAlert({ tenantId: "t1", email: "a@b.co", webhookUrl: "https://hook.example/x" }, [flag], async () => { calls++; return new Response("ok"); });
  assert.deepEqual(r, { sent: false, email: "stubbed", webhook: "stubbed" });
  assert.equal(calls, 0);
  process.env = saved;
});

test("below threshold: skipped", async () => {
  const r = await deliverAlert({ tenantId: "t1", email: "a@b.co", minSeverity: "high" }, [{ ...flag, severity: "low" }], async () => { throw new Error("should not send"); });
  assert.equal(r.email, "skipped");
});

test("with keys: Resend email + signed webhook; payload only has redacted excerpt", async () => {
  const saved = { ...process.env };
  process.env.RESEND_API_KEY = "re_fake_for_test"; process.env.MAIL_FROM = "alerts@example.com"; process.env.ALERT_WEBHOOK_SECRET = "hooksecret";
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const r = await deliverAlert({ tenantId: "t1", email: "a@b.co", webhookUrl: "https://hook.example/x" }, [flag], async (url, init) => { sent.push({ url, init: init! }); return new Response("{}", { status: 200 }); });
  assert.deepEqual(r, { sent: true, email: "sent", webhook: "sent" });
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  const hook = sent.find((s) => s.url === "https://hook.example/x")!;
  const sig = (hook.init.headers as Record<string, string>)["X-Memory-Signature"];
  assert.ok(verifyWebhookSignature("hooksecret", String(hook.init.body), sig));
  assert.ok(!verifyWebhookSignature("wrong", String(hook.init.body), sig));
  assert.match(String(hook.init.body), /REDACTED:github_token/);
  process.env = saved;
});

test("http webhooks are refused unless explicitly allowed", async () => {
  const saved = { ...process.env };
  process.env.ALERT_WEBHOOK_SECRET = "s"; delete process.env.ALERT_ALLOW_HTTP_WEBHOOK;
  const r = await deliverAlert({ tenantId: "t", webhookUrl: "http://10.0.0.1/hook" }, [flag], async () => { throw new Error("no"); });
  assert.equal(r.webhook, "stubbed");
  process.env = saved;
});

test("signature format", () => {
  assert.match(signWebhook("k", "{}", 1700000000), /^t=1700000000,v1=[0-9a-f]{64}$/);
});

test("moderation is off without OPENAI_API_KEY and fails closed to no-finding", async () => {
  const saved = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(await moderate("x", async () => { throw new Error("no"); }), []);
  process.env.OPENAI_API_KEY = "fake";
  assert.deepEqual(await moderate("x", async () => new Response("err", { status: 500 })), []);
  const f = await moderate("x", async () => new Response(JSON.stringify({ results: [{ flagged: true, categories: { "violence/graphic": true, harassment: false } }] })));
  assert.equal(f[0].severity, "high");
  process.env = saved;
});
