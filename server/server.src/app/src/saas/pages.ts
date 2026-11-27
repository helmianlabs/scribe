/** Server-rendered pages (no inline scripts; CSP script-src 'self'). */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `:root{color-scheme:light dark}body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e9eef3;margin:0;line-height:1.5}
main{max-width:760px;margin:0 auto;padding:40px 20px}.card{background:#15191e;border:1px solid #262b31;border-radius:14px;padding:24px;margin:0 0 18px}
h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0 0 10px}p.sub{color:#9aa6b2}code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#0e1216;border:1px solid #2b323a;border-radius:6px;padding:2px 6px;word-break:break-all}
input,select{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;border:1px solid #2b323a;background:#0e1216;color:#e9eef3;font-size:15px}
button{padding:11px 16px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin:6px 6px 0 0}
button.ghost{background:transparent;color:#c7d0d9;border:1px solid #2b323a}button.danger{background:#b91c1c}.err{color:#ff6b6b}.ok{color:#4ade80}.muted{color:#6b7682;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid #262b31;vertical-align:top}.sev-critical{color:#f87171}.sev-high{color:#fb923c}.sev-medium{color:#facc15}.sev-low{color:#9aa6b2}`;

export function layout(title: string, body: string, scripts: string[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${scripts.map((s) => `<script src="${esc(s)}"></script>`).join("")}</body></html>`;
}

export function signInPage(opts: { returnTo?: string | null; error?: string; sent?: string }): string {
  if (opts.sent) {
    return layout("Check your email", `<div class="card"><h1>Check your email</h1><p class="sub">We sent a sign-in link to <b>${esc(opts.sent)}</b>. It works once and expires soon. You can close this tab after you click it.</p></div>`);
  }
  return layout("Sign in", `<div class="card"><h1>Sign in to Helmian Scribe</h1>
<p class="sub">One memory every AI you use (Claude, ChatGPT, Grok, Gemini, your coding tools) can read and write. Enter your email and we'll send you a sign-in link. New here? The same link creates your account.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<form method="POST" action="/auth/start"><input type="hidden" name="return_to" value="${esc(opts.returnTo ?? "")}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button type="submit">Email me a sign-in link</button></form></div>`);
}

export function verifyPage(token: string): string {
  return layout("Sign in", `<div class="card"><h1>Finish signing in</h1><p class="sub">Press the button to sign in on this device.</p>
<form method="POST" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Sign in</button></form></div>`);
}

export function messagePage(title: string, msg: string): string {
  return layout(title, `<div class="card"><h1>${esc(title)}</h1><p class="sub">${esc(msg)}</p><p><a href="/login" style="color:#93c5fd">Sign in</a></p></div>`);
}

export function consentPage(o: { pendingId: string; clientName: string; email: string; tenants: Array<{ id: string; name: string; slug: string }>; fixedTenant?: { id: string; name: string } | null; scopes: string[]; error?: string }): string {
  const write = o.scopes.includes("memory.write");
  const choose = o.fixedTenant
    ? `<input type="hidden" name="tenant_id" value="${esc(o.fixedTenant.id)}"><p>Memory: <b>${esc(o.fixedTenant.name)}</b></p>`
    : `<label for="tenant_id">Which memory?</label><select id="tenant_id" name="tenant_id">${o.tenants.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>`;
  return layout("Authorize Helmian Scribe", `<div class="card"><h1>Authorize Helmian Scribe access</h1>
<p class="sub"><b>${esc(o.clientName)}</b> wants to ${write ? "search your Helmian Scribe memory and save new memories to it" : "search your Helmian Scribe memory (read only)"}.</p>
<p class="muted">Signed in as ${esc(o.email)}. <a href="/logout" style="color:#93c5fd">Not you?</a></p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form method="POST" action="/consent"><input type="hidden" name="pending_id" value="${esc(o.pendingId)}">${choose}
<button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny" class="ghost">Deny</button></form>
<p class="muted">You can disconnect any time from the AI app, or revoke everything from your dashboard.</p></div>`);
}

export function dashboardPage(): string {
  return layout("Helmian Scribe", `<div id="app"><div class="card"><h1>Helmian Scribe</h1><p class="sub">Loading…</p></div></div>`, ["/static/dashboard.js"]);
}

export function gettingStartedPage(): string {
  return layout("Getting started — Helmian Scribe", `<div class="card"><h1>Getting started</h1>
<p class="sub">Three short steps and your AIs share one memory — including the conversations you have already had. The full guide lives in the docs (GETTING-STARTED.md); this page is the short version.</p>
<h2>1 · Your memory address</h2>
<p>Your <a href="/dashboard" style="color:#93c5fd">dashboard</a> shows your memory address. That is the only thing you ever copy.</p>
<h2>2 · Connect your AI</h2>
<p>In Claude, ChatGPT, Grok or Gemini, add a custom connector and paste your memory address. The app sends you back here to approve — that approval is the whole setup. Then ask your AI: <i>"Search my memory for…"</i></p>
<h2>3 · Bring your old conversations</h2>
<p><b>Claude:</b> open Settings → Privacy → <b>Export data</b>. Claude emails you a download link — download the .zip, don't open it.</p>
<p><b>ChatGPT:</b> open Settings → Data controls → <b>Export data</b> → Export. ChatGPT emails you a download link — download the .zip, don't open it.</p>
<p><b>Gemini:</b> Google Takeout exports are not importable yet — we're honest about that rather than guess at your history. Your Gemini chats stay in Gemini for now.</p>
<p>Then come back here, go to your <a href="/dashboard" style="color:#93c5fd">dashboard</a>, pick the .zip under <b>Bring your old chats with you</b> and press <b>Import history</b>. Your old conversations land in your memory, titled and dated, searchable by every AI you connect. Uploading the same file twice is safe — nothing is duplicated. Secrets are scrubbed before anything is stored, exactly like every other save.</p>
<p class="muted">Limits: one export file up to 50 MB and 2,000 conversations at a time. If your plan's storage fills up mid-import, the import stops safely — upgrade and upload the same file again to continue.</p></div>`);
}

export function mockBillingPage(): string {
  return layout("Helmian Scribe billing (test stub)", `<div class="card"><h1>Billing is not connected yet</h1><p class="sub">This server has no payment provider key, so checkout is a stub. Nothing was charged. Set PAYMENT_PROVIDER and the matching test or sandbox key (Stripe sk_test_…, or a Paddle sandbox key) to try checkout.</p><p><a href="/dashboard" style="color:#93c5fd">Back to dashboard</a></p></div>`);
}

/** Where Paddle's checkout payment links point (Paddle Billing has no hosted checkout: it opens on a page you serve that includes Paddle.js). */
export function paddlePayPage(opts: { token: string; environment: "sandbox" | "production" }): string {
  return layout("Helmian Scribe checkout", `<div class="card" id="pay" data-token="${esc(opts.token)}" data-env="${esc(opts.environment)}"><h1>Opening checkout…</h1><p class="sub" id="paystatus">If nothing opens, allow pop-ups and frames from paddle.com, then reload this page.</p><p><a href="/dashboard" style="color:#93c5fd">Back to dashboard</a></p></div>`,
    ["https://cdn.paddle.com/paddle/v2/paddle.js", "/static/paddle-pay.js"]);
}

/**
 * Content-Security-Policy for /billing/pay only. Paddle.js and the checkout it opens load from paddle.com hosts. Paddle's
 * documentation index has no CSP list that could be retrieved, so the whole paddle.com family is allowed here and nowhere
 * else. NOT VERIFIED against a live sandbox checkout: if the browser console shows a CSP violation, widen it here.
 */
export const PADDLE_PAY_CSP = "default-src 'none'; script-src 'self' https://cdn.paddle.com https://*.paddle.com; style-src 'unsafe-inline' https://*.paddle.com; connect-src 'self' https://*.paddle.com; frame-src https://*.paddle.com; img-src 'self' data: https://*.paddle.com; font-src https://*.paddle.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PADDLE_PAY_JS = `(() => {
const el = document.getElementById('pay');
const status = document.getElementById('paystatus');
if (!el || !window.Paddle) { if (status) status.textContent = 'Checkout could not load. Reload the page or try again later.'; return; }
if (el.dataset.env === 'sandbox') window.Paddle.Environment.set('sandbox');
let done = false;
window.Paddle.Initialize({
  token: el.dataset.token,
  checkout: { settings: { displayMode: 'overlay', theme: 'dark', successUrl: location.origin + '/dashboard?billing=success' } },
  eventCallback: (e) => {
    if (!e) return;
    if (e.name === 'checkout.completed') done = true;
    if (e.name === 'checkout.closed') location.href = '/dashboard?billing=' + (done ? 'success' : 'cancelled');
  },
});
})();`;

export const DASHBOARD_JS = `(() => {
const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; };
const mb = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const api = async (path, opts = {}) => { const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' }, ...opts }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = { error: t }; } if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; };
async function load() {
  const app = document.getElementById('app');
  let me; try { me = await api('/api/me'); } catch { location.href = '/login?return_to=/dashboard'; return; }
  const t = me.tenant, u = me.usage, p = me.plan;
  const flags = (await api('/api/flags?limit=10')).flags || [];
  const keys = (await api('/api/keys')).keys || [];
  app.innerHTML = '';
  app.append($('<div class="card"><h1>' + esc(t.name) + '</h1><p class="sub">Signed in as ' + esc(me.user.email) + ' · <a href="/logout" style="color:#93c5fd">Sign out</a></p>' +
    '<h2>Your memory address</h2><p>Paste this into Claude, ChatGPT, Grok, Gemini or your coding tools as a custom connector:</p><p><code>' + esc(me.mcp_url) + '</code></p>' +
    '<p class="muted">The AI app will open a page here asking you to approve. That is the only step.</p></div>'));
  app.append($('<div class="card"><h2>Plan: ' + esc(p.name) + (t.plan_status !== 'active' ? ' (' + esc(t.plan_status) + ')' : '') + '</h2>' +
    '<p>' + u.memories.toLocaleString() + (p.maxMemories === null ? ' memories (no limit)' : ' of ' + p.maxMemories.toLocaleString() + ' memories') + ' · ' + mb(u.bytes) + ' of ' + mb(p.maxBytes) + ' stored</p>' +
    '<p>' + u.calls_today.toLocaleString() + ' of ' + p.maxCallsPerDay.toLocaleString() + ' calls today (resets at midnight UTC)</p>' +
    (me.tenant.plan === 'free' ? '<button data-plan="personal" data-interval="month">Personal $' + me.plans.personal.priceUsdMonthly + '/month</button><button data-plan="personal" data-interval="year">Personal $' + me.plans.personal.priceUsdYearly + '/year</button>' +
      '<p style="margin-top:14px">Team, $' + me.plans.team.priceUsdMonthly + ' per seat per month: <input id="seats" type="number" min="1" max="' + me.max_seats + '" value="2" style="width:80px;display:inline-block"> seats <button data-plan="team" data-interval="month">Choose Team</button></p>' : '') +
    (me.tenant.plan === 'team' ? '<p>' + t.seats + ' seat' + (t.seats === 1 ? '' : 's') + ' <input id="newseats" type="number" min="1" max="' + me.max_seats + '" value="' + t.seats + '" style="width:80px;display:inline-block"> <button class="ghost" id="setseats">Change seats</button></p>' : '') +
    '<button class="ghost" id="portal">Manage billing</button>' +
    '<p class="muted">Billing mode: ' + esc(me.billing_mode) + '</p></div>'));
  app.append($('<div class="card"><h2>Flags</h2>' + (flags.length ? '<table><tr><th>When</th><th>Severity</th><th>What</th><th>From</th></tr>' + flags.map((f) => '<tr><td>' + esc(new Date(f.created_at).toLocaleString()) + '</td><td class="sev-' + esc(f.severity) + '">' + esc(f.severity) + '</td><td>' + esc(f.reason) + (f.excerpt ? '<br><span class="mono">' + esc(f.excerpt.slice(0, 160)) + '</span>' : '') + '</td><td>' + esc(f.source_ai || '') + '</td></tr>').join('') + '</table>' : '<p class="muted">No flags yet. Secrets and personal numbers are redacted before anything is stored.</p>') +
    '<h2 style="margin-top:16px">Alerts</h2><label>Email</label><input id="ae" value="' + esc(t.alert_email || '') + '"><label>Webhook (https)</label><input id="aw" value="' + esc(t.alert_webhook_url || '') + '"><label>Alert at</label><select id="as">' + ['low','medium','high','critical'].map((s) => '<option' + (s === t.alert_min_severity ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><button id="savealerts">Save alerts</button></div>'));
  app.append($('<div class="card"><h2>API keys (for Helmian Guard and other services)</h2>' + (keys.length ? '<table>' + keys.map((k) => '<tr><td>' + esc(k.name) + '</td><td class="mono">' + esc(k.prefix) + '…</td><td>' + (k.revoked_at ? 'revoked' : '<button class="ghost" data-revoke="' + esc(k.id) + '">Revoke</button>') + '</td></tr>').join('') + '</table>' : '<p class="muted">None yet.</p>') + '<input id="kn" placeholder="Key name, e.g. Guard extension"><button id="newkey">Create key</button><p id="keyout"></p></div>'));
  app.append($('<div class="card"><h2>Bring your old chats with you</h2><p>Export your history from Claude or ChatGPT and upload the .zip here — your old conversations land in this memory, titled and dated, searchable by every AI you connect. Uploading the same file twice is safe: nothing is duplicated.</p><p><a href="/getting-started" style="color:#93c5fd">Step-by-step guide: how to export from Claude or ChatGPT</a></p><input type="file" id="impfile" accept=".zip"><button id="impgo">Import history</button><p id="impout"></p></div>'));
  app.append($('<div class="card"><h2>Your data</h2><button class="ghost" id="export">Export everything (JSON)</button><button class="danger" id="delall">Delete all memories</button><p class="muted">Delete removes every memory, filing and flag. Your account and billing stay.</p></div>'));
  app.querySelectorAll('[data-plan]').forEach((b) => b.onclick = async () => { try { const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: b.dataset.plan, interval: b.dataset.interval || 'month', seats: b.dataset.plan === 'team' ? Number(document.getElementById('seats').value) : undefined }) }); location.href = r.url; } catch (e) { alert(e.message); } });
  const ss = document.getElementById('setseats'); if (ss) ss.onclick = async () => { try { const r = await api('/api/billing/seats', { method: 'POST', body: JSON.stringify({ seats: Number(document.getElementById('newseats').value) }) }); alert('Requested ' + r.requested + ' seats. It shows here once the payment provider confirms.'); } catch (e) { alert(e.message); } };
  document.getElementById('portal').onclick = async () => { try { location.href = (await api('/api/billing/portal', { method: 'POST' })).url; } catch (e) { alert(e.message); } };
  document.getElementById('savealerts').onclick = async () => { try { await api('/api/alerts', { method: 'POST', body: JSON.stringify({ alert_email: document.getElementById('ae').value || null, alert_webhook_url: document.getElementById('aw').value || null, alert_min_severity: document.getElementById('as').value }) }); load(); } catch (e) { alert(e.message); } };
  document.getElementById('newkey').onclick = async () => { try { const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: document.getElementById('kn').value }) }); document.getElementById('keyout').innerHTML = 'Copy it now, it will not be shown again:<br><code>' + esc(r.key) + '</code>'; } catch (e) { alert(e.message); } };
  app.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { await api('/api/keys/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' }); load(); });
  document.getElementById('impgo').onclick = async () => { const f = document.getElementById('impfile').files[0]; const out = document.getElementById('impout'); if (!f) { out.textContent = 'Pick the .zip file from your export email first.'; return; } out.textContent = 'Importing… a big history can take a minute. Keep this tab open.'; try { const r = await fetch('/api/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip', 'X-Requested-With': 'dashboard' }, body: f }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); out.textContent = 'Done: ' + b.imported + ' conversations imported, ' + b.skipped_duplicates + ' already here, ' + b.failed.length + ' could not be imported.' + (b.failed.length ? ' First problem: ' + b.failed[0].title + ' — ' + b.failed[0].error : '') + (b.note ? ' ' + b.note : ''); load(); } catch (e) { out.textContent = 'Import failed: ' + e.message; } };
  document.getElementById('export').onclick = () => { location.href = '/api/export'; };
  document.getElementById('delall').onclick = async () => { const c = prompt('Type DELETE to remove every memory in this account.'); if (c !== 'DELETE') return; try { const r = await api('/api/delete-all', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }); alert('Deleted.'); load(); } catch (e) { alert(e.message); } };
}
load();
})();`;
