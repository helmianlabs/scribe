/**
 * Persistent per-tenant daily call cap. The counter is usage_daily in the database (not per process), the increment is a single
 * guarded statement, a refused call is not counted, and the day is the UTC day. Chosen numbers (not Troy's): Free 500,
 * Personal 10,000, Team 10,000 per seat. Small overrides keep the suite fast; the real numbers are pinned in the first tests.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSaas, signIn, upgrade, api, connect, tool, type Saas } from "./helpers.ts";
import { CALLS_PER_DAY, PLANS, planFor, TEAM_MAX_SEATS } from "../src/saas/plans.ts";
import { secondsToUtcMidnight } from "../src/saas/memory.ts";

test("the chosen caps are Free 500, Personal 10,000, Team 10,000 per seat", () => {
  assert.deepEqual({ ...CALLS_PER_DAY }, { free: 500, personal: 10_000, teamPerSeat: 10_000 });
  assert.equal(PLANS.free.maxCallsPerDay, 500);
  assert.equal(PLANS.personal.maxCallsPerDay, 10_000);
  assert.equal(planFor("team", undefined, 1).maxCallsPerDay, 10_000);
  assert.equal(planFor("team", undefined, 7).maxCallsPerDay, 70_000);
  assert.equal(planFor("team", undefined, 7).maxMembers, 7);
  assert.equal(planFor("team", undefined, 100_000).maxCallsPerDay, 10_000 * TEAM_MAX_SEATS, "seats are clamped");
  assert.equal(planFor("team", undefined, 0).maxCallsPerDay, 10_000, "a bad seat count is one seat");
  assert.equal(planFor("free", undefined, 9).maxCallsPerDay, 500, "seats only scale Team");
  assert.equal(planFor("team", { team: { maxCallsPerDay: 12 } }, 5).maxCallsPerDay, 12, "an override wins");
});

test("secondsToUtcMidnight counts down to 00:00 UTC", () => {
  assert.equal(secondsToUtcMidnight(new Date("2026-11-26T23:59:00Z")), 60);
  assert.equal(secondsToUtcMidnight(new Date("2026-11-26T00:00:00Z")), 86_400);
});

let s: Saas;
before(async () => { s = await startSaas({ limitsOverride: { free: { maxCallsPerDay: 5 }, personal: { maxCallsPerDay: 8 } } }); });
after(async () => { await s.close(); });

async function account(email: string, plan?: "personal" | "team") {
  const cookie = await signIn(s, email);
  if (plan) await upgrade(s, cookie, plan);
  const me = (await api(s, cookie)("/api/me")).body;
  const tok = await connect(s, cookie, me.mcp_url); // consent and token exchange are not MCP tool calls
  return { cookie, me, call: (name: string, args: Record<string, unknown> = {}) => tool(me.mcp_url, tok.access_token, name, args) };
}
const callsToday = async (cookie: string) => (await api(s, cookie)("/api/me")).body.usage.calls_today as number;

test("Free: the call after the cap is refused with a plain message, and is not counted", async () => {
  const a = await account("cap-free@example.com");
  for (let i = 0; i < 5; i++) assert.equal((await a.call("list_flags")).isError, false, `call ${i + 1}`);
  const over = await a.call("list_flags");
  assert.equal(over.isError, true);
  assert.match(over.text, /Daily limit reached/);
  assert.match(over.text, /Free plan allows 5 calls a day/);
  assert.match(over.text, /midnight UTC/);
  assert.match(over.text, /Upgrade to Personal/);
  assert.equal(await callsToday(a.cookie), 5, "the refused call was not counted");
  assert.equal((await a.call("search_memory", { query: "x" })).isError, true, "every tool is capped alike");
});

test("the counter is in the database: it survives a new server, and a new UTC day starts at zero", async () => {
  const a = await account("cap-persist@example.com");
  for (let i = 0; i < 5; i++) await a.call("list_flags");
  assert.equal((await a.call("list_flags")).isError, true);
  const row = await s.pg.query<any>("SELECT tenant_id, day::text AS day, calls FROM usage_daily WHERE tenant_id = $1", [a.me.tenant.id]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].calls, 5);
  const utcToday = (await s.pg.query<any>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0].d;
  assert.equal(row.rows[0].day, utcToday, "keyed by the UTC day");
  // A second app instance over the same database sees the same count: nothing is held in process memory.
  const { createSaasApp } = await import("../src/saas/app.ts");
  const { createServer } = await import("node:http");
  const second = createSaasApp({ db: s.db, cfg: s.cfg } as never);
  const srv = createServer(second.app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const cookie2 = await signIn(s, "cap-persist@example.com"); // same account, signed in through the first instance
  const me2 = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Cookie: cookie2 } })).json() as any;
  assert.equal(me2.usage.calls_today, 5);
  await new Promise<void>((r) => srv.close(() => r()));
  // "Tomorrow": move the row back a day. The cap no longer applies to it.
  await s.pg.query("UPDATE usage_daily SET day = day - 1 WHERE tenant_id = $1", [a.me.tenant.id]);
  assert.equal((await a.call("list_flags")).isError, false);
  assert.equal(await callsToday(a.cookie), 1);
});

test("concurrent calls cannot jointly pass the cap", async () => {
  const a = await account("cap-race@example.com");
  const rs = await Promise.all(Array.from({ length: 12 }, () => a.call("list_flags")));
  assert.equal(rs.filter((r) => !r.isError).length, 5);
  assert.equal(await callsToday(a.cookie), 5);
});

test("Personal has its own, higher cap; Team's scales with seats", async () => {
  const p = await account("cap-personal@example.com", "personal");
  for (let i = 0; i < 8; i++) assert.equal((await p.call("list_flags")).isError, false);
  const over = await p.call("list_flags");
  assert.equal(over.isError, true);
  assert.match(over.text, /Personal plan allows 8 calls a day/);
  assert.doesNotMatch(over.text, /Upgrade to Personal/);

  const t = await account("cap-team@example.com", "team");
  await s.pg.query("UPDATE tenants SET seats = 3 WHERE id = $1", [t.me.tenant.id]);
  const me = (await api(s, t.cookie)("/api/me")).body;
  assert.equal(me.plan.maxCallsPerDay, 30_000);
  assert.equal(me.plan.maxMembers, 3);
});

test("API-key calls to the flags API are capped with HTTP 429 and Retry-After; the dashboard session is not capped", async () => {
  const a = await account("cap-api@example.com");
  const k = await api(s, a.cookie)("/api/keys", { method: "POST", body: JSON.stringify({ name: "k", scopes: ["flags.read", "flags.write"] }) });
  const key = k.body.key;
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${s.base}/api/flags`, { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  const over = await fetch(`${s.base}/api/flags`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(over.status, 429);
  assert.equal((await over.json() as any).limit, "calls");
  const retry = Number(over.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 86_400, `Retry-After ${retry}`);
  assert.equal((await api(s, a.cookie)("/api/flags")).status, 200, "the signed-in dashboard is not metered");
  assert.equal((await api(s, a.cookie)("/api/export")).status, 200, "export still works at the cap");
});

test("history import counts as a call", async () => {
  const a = await account("cap-import@example.com", "personal");
  for (let i = 0; i < 8; i++) await a.call("list_flags");
  const r = await fetch(`${s.base}/api/import`, { method: "POST", headers: { Cookie: a.cookie, Origin: s.base, "X-Requested-With": "test", "Content-Type": "application/zip" }, body: Buffer.from("PK") });
  assert.equal(r.status, 429);
});
