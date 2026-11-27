/**
 * Public pricing and legal pages required for Paddle website approval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSaas } from "./helpers.ts";

const PAGES = [
  { path: "/", title: /Scribe Memory/, extra: [/helmianlabs@gmail.com/, /\$8/, /\$80/, /\$15/, /1,000 memories/, /Paddle\.com/, /\/terms/, /\/privacy/, /\/refunds/, /\/pricing/] },
  { path: "/pricing", title: /Pricing/, extra: [/\$8/, /\$80/, /\$15 per seat/, /1,000 memories/, /Paddle\.com/, /14 days/] },
  { path: "/terms", title: /Terms of Service/, extra: [/DairyForge LLC/, /Paddle\.com/, /merchant of record/, /helmianlabs@gmail.com/] },
  { path: "/privacy", title: /Privacy Policy/, extra: [/DairyForge LLC/, /Paddle\.com/, /helmianlabs@gmail.com/] },
  { path: "/refunds", title: /Refund Policy/, extra: [/14 days/, /Paddle\.com/, /merchant of record/, /helmianlabs@gmail.com/] },
] as const;

test("legal and pricing pages return HTML 200 with required copy and a footer", async () => {
  const s = await startSaas();
  try {
    for (const page of PAGES) {
      const r = await fetch(`${s.base}${page.path}`, { headers: { Accept: "text/html" } });
      assert.equal(r.status, 200, `${page.path} status`);
      assert.match(r.headers.get("content-type") ?? "", /text\/html/);
      const html = await r.text();
      assert.match(html, page.title, `${page.path} title`);
      assert.match(html, /<footer>/, `${page.path} footer`);
      assert.match(html, /href="\/pricing"/);
      assert.match(html, /href="\/terms"/);
      assert.match(html, /href="\/privacy"/);
      assert.match(html, /href="\/refunds"/);
      assert.match(html, /helmianlabs@gmail.com/);
      assert.match(html, /id="theme-toggle"/, `${page.path} theme toggle`);
      for (const re of page.extra) assert.match(html, re, `${page.path} ${re}`);
    }

    // Theme script is served and functional.
    const themeJs = await fetch(`${s.base}/static/theme.js`);
    assert.equal(themeJs.status, 200);
    assert.match(themeJs.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await themeJs.text(), /localStorage\.setItem\('theme'/);

    // Footer is on existing HTML pages too.
    const login = await fetch(`${s.base}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /<footer>/);

    // JSON clients still get the status payload.
    const json = await fetch(`${s.base}/`, { headers: { Accept: "application/json" } });
    assert.equal(json.status, 200);
    assert.match(json.headers.get("content-type") ?? "", /application\/json/);
    const body = await json.json() as { name: string; try: string; pricing: string };
    assert.equal(body.name, "scribe-memory");
    assert.ok(body.try.endsWith("/try"));
    assert.ok(body.pricing.endsWith("/pricing"));

    const health = await fetch(`${s.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
  } finally {
    await s.close();
  }
});
