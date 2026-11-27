/** Server-rendered pages (no inline scripts; CSP script-src 'self'). */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `:root {
  --bg: #ffffff;
  --bg-subtle: #f8fafc;
  --surface: #ffffff;
  --surface-hover: #f1f5f9;
  --surface-border: #e2e8f0;
  --text: #0f172a;
  --text-muted: #475569;
  --text-dim: #64748b;
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --accent-cyan: #0284c7;
  --accent-emerald: #059669;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --popular-border: #2563eb;
  --popular-bg: #eff6ff;
  --nav-bg: rgba(255, 255, 255, 0.85);
  color-scheme: light;
}

[data-theme="dark"] {
  --bg: #070c18;
  --bg-subtle: #0d1527;
  --surface: #0f1a30;
  --surface-hover: #162442;
  --surface-border: #1e2e4a;
  --text: #f8fafc;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --primary: #3b82f6;
  --primary-hover: #2563eb;
  --accent-cyan: #38bdf8;
  --accent-emerald: #10b981;
  --card-shadow: 0 4px 20px rgba(0,0,0,0.3);
  --popular-border: #3b82f6;
  --popular-bg: #111e38;
  --nav-bg: rgba(7, 12, 24, 0.85);
  color-scheme: dark;
}

* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  background: var(--bg);
  color: var(--text);
  margin: 0;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.2s ease, color 0.2s ease;
}
a { color: var(--primary); text-decoration: none; transition: color 0.15s ease; }
a:hover { color: var(--primary-hover); text-decoration: underline; }

header.top-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  backdrop-filter: blur(12px);
  background: var(--nav-bg);
  border-bottom: 1px solid var(--surface-border);
  padding: 14px 24px;
}
.nav-container {
  max-width: 1040px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.brand {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand span.accent {
  color: var(--primary);
}
.nav-badge {
  font-size: 11px;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.12);
  color: var(--accent-emerald);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 9999px;
  padding: 2px 8px;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 18px;
}
.nav-links a {
  color: var(--text-muted);
  font-size: 14px;
  font-weight: 500;
}
.nav-links a:hover {
  color: var(--text);
  text-decoration: none;
}
.theme-toggle {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text-muted);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  margin: 0;
}
.theme-toggle:hover {
  color: var(--text);
  border-color: var(--primary);
}

main {
  max-width: 1040px;
  margin: 0 auto;
  padding: 40px 20px 80px;
}

.hero {
  text-align: center;
  padding: 40px 0 30px;
}
.badge-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  background: rgba(37, 99, 235, 0.08);
  color: var(--primary);
  border: 1px solid rgba(37, 99, 235, 0.2);
  padding: 5px 14px;
  border-radius: 9999px;
  margin-bottom: 20px;
}
h1.hero-title {
  font-size: clamp(32px, 5vw, 46px);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin: 0 0 16px;
  color: var(--text);
}
p.hero-sub {
  font-size: 18px;
  color: var(--text-muted);
  max-width: 680px;
  margin: 0 auto 28px;
  line-height: 1.5;
}
.hero-cta {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
button, a.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 22px;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  text-decoration: none !important;
}
button.primary, a.btn.primary {
  background: var(--primary);
  color: #fff;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}
button.primary:hover, a.btn.primary:hover {
  background: var(--primary-hover);
  transform: translateY(-1px);
}
button.ghost, a.btn.ghost {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--surface-border);
}
button.ghost:hover, a.btn.ghost:hover {
  background: var(--surface-hover);
  border-color: var(--text-dim);
}
button.danger { background: #b91c1c; color: #fff; }

.card {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  padding: 28px;
  margin: 0 0 20px;
  box-shadow: var(--card-shadow);
}
.card h1 { font-size: 24px; margin: 0 0 10px; color: var(--text); }
.card h2 { font-size: 18px; margin: 24px 0 10px; color: var(--text); }
.card p.sub { color: var(--text-muted); font-size: 15px; margin: 0 0 16px; }
.muted { color: var(--text-dim); font-size: 13px; }
.err { color: #dc2626; font-weight: 500; }
.ok { color: #16a34a; font-weight: 500; }

code, .mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  background: var(--bg-subtle);
  border: 1px solid var(--surface-border);
  border-radius: 6px;
  padding: 2px 7px;
  word-break: break-all;
  color: var(--text);
}
input, select {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--surface-border);
  background: var(--bg-subtle);
  color: var(--text);
  font-size: 15px;
  margin: 6px 0 16px;
  outline: none;
  transition: border-color 0.15s ease;
}
input:focus, select:focus {
  border-color: var(--primary);
}

.section-title {
  text-align: center;
  margin: 60px 0 24px;
}
.section-title h2 {
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 8px;
}
.section-title p {
  color: var(--text-muted);
  font-size: 16px;
  margin: 0;
}

.how-it-works-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
  margin: 40px 0 60px;
}
.step-card {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--card-shadow);
}
.step-num {
  font-size: 13px;
  font-weight: 700;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}
.step-card h3 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--text);
}
.step-card p {
  color: var(--text-muted);
  font-size: 14px;
  margin: 0;
  line-height: 1.5;
}

.plans {
  display: grid;
  gap: 20px;
  margin: 24px 0;
}
@media (min-width: 768px) {
  .plans { grid-template-columns: 1fr 1fr 1fr; }
}
.plan {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.plan.popular {
  border-color: var(--popular-border);
  background: var(--popular-bg);
  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.12);
}
.popular-badge {
  position: absolute;
  top: -12px;
  right: 20px;
  background: var(--primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 9999px;
  letter-spacing: 0.05em;
}
.plan h2 { margin: 0 0 8px; font-size: 20px; color: var(--text); }
.plan .price {
  font-size: 32px;
  font-weight: 800;
  margin: 12px 0 6px;
  color: var(--text);
}
.plan .price span {
  font-size: 15px;
  font-weight: 400;
  color: var(--text-muted);
}
.plan ul.features-list {
  list-style: none;
  padding: 0;
  margin: 20px 0;
  font-size: 14px;
  color: var(--text-muted);
}
.plan ul.features-list li {
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.plan ul.features-list li::before {
  content: "✓";
  color: var(--accent-emerald);
  font-weight: 700;
}

.faq-section {
  max-width: 800px;
  margin: 60px auto 40px;
}
.faq-item {
  border-bottom: 1px solid var(--surface-border);
  padding: 20px 0;
}
.faq-item h3 {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--text);
}
.faq-item p {
  color: var(--text-muted);
  font-size: 14px;
  margin: 0;
  line-height: 1.6;
}

.trust-banner {
  background: var(--bg-subtle);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  padding: 18px 20px;
  margin-top: 30px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

footer {
  border-top: 1px solid var(--surface-border);
  background: var(--bg-subtle);
  padding: 40px 20px;
  margin-top: 60px;
  color: var(--text-dim);
  font-size: 14px;
}
.footer-container {
  max-width: 1040px;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}
.footer-links {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.footer-links a {
  color: var(--text-muted);
}
.footer-links a:hover {
  color: var(--text);
}
table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 12px 0; }
td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--surface-border); vertical-align: top; }
th { color: var(--text-muted); font-weight: 600; }
.sev-critical { color: #dc2626; }
.sev-high { color: #ea580c; }
.sev-medium { color: #ca8a04; }
.sev-low { color: #64748b; }
`;

export const CONTACT_EMAIL = "helmianlabs@gmail.com";

const NAV_BAR = `<header class="top-nav">
  <div class="nav-container">
    <a href="/" class="brand">
      <span class="accent">Scribe</span>Mem
      <span class="nav-badge">MCP Native</span>
    </a>
    <nav class="nav-links">
      <a href="/#how-it-works">How It Works</a>
      <a href="/pricing">Pricing</a>
      <a href="/getting-started">Docs</a>
      <a href="/login">Sign in</a>
      <button type="button" id="theme-toggle" class="theme-toggle" aria-label="Toggle theme">🌓 <span id="theme-label">Theme</span></button>
      <form method="POST" action="/try" style="margin:0;display:inline">
        <button type="submit" class="primary" style="padding:7px 14px;font-size:13px">Try Free</button>
      </form>
    </nav>
  </div>
</header>`;

const FOOTER = `<footer>
  <div class="footer-container">
    <div>
      <p style="margin:0 0 6px;color:var(--text);font-weight:600">Scribe Memory &bull; Operated by DairyForge LLC</p>
      <p style="margin:0">Questions or support: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
    <div class="footer-links">
      <a href="/pricing">Pricing</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds</a>
      <a href="https://github.com/helmianlabs/scribe" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</footer>`;

export function layout(title: string, body: string, scripts: string[] = []): string {
  const allScripts = ["/static/theme.js", ...scripts];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  ${NAV_BAR}
  <main>${body}</main>
  ${FOOTER}
  ${allScripts.map((s) => `<script src="${esc(s)}"></script>`).join("")}
</body>
</html>`;
}

export function signInPage(opts: { returnTo?: string | null; error?: string; sent?: string; emailSignIn?: boolean }): string {
  if (opts.sent) {
    return layout("Check your email — Scribe Memory", `<div class="card" style="max-width:560px;margin:40px auto">
      <h1>Check your email</h1>
      <p class="sub">We sent a one-time sign-in link to <b>${esc(opts.sent)}</b>. Click the link in your email to open your dashboard.</p>
    </div>`);
  }
  const emailOn = opts.emailSignIn !== false;
  const emailBlock = emailOn ? `
    <h2 style="font-size:16px;margin:24px 0 8px;color:var(--text)">Or sign in with email</h2>
    <p class="sub">Enter your email and we'll send a magic link. New here? The same link creates your account.</p>
    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
    <form method="POST" action="/auth/start">
      <input type="hidden" name="return_to" value="${esc(opts.returnTo ?? "")}">
      <label for="email" style="font-size:14px;color:var(--text-muted)">Email address</label>
      <input id="email" name="email" type="email" autocomplete="email" placeholder="name@company.com" required>
      <button type="submit" class="ghost" style="width:100%">Email me a sign-in link</button>
    </form>` : `
    <p class="sub">Email sign-in is not on yet. You can still try Scribe Memory without an account.</p>
    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}`;

  return layout("Sign in — Scribe Memory", `<div class="card" style="max-width:560px;margin:40px auto">
    <div style="text-align:center;margin-bottom:24px">
      <h1>Sign in to Scribe Memory</h1>
      <p class="sub">One memory every AI you use (Claude, ChatGPT and Cursor) can read and write.</p>
    </div>
    <form method="POST" action="/try">
      <button type="submit" class="primary" style="width:100%;margin-bottom:12px">Try without signing up</button>
    </form>
    <p class="muted" style="text-align:center">Creates a private, walled-off memory tenant instantly. No password required.</p>
    ${emailBlock}
  </div>`);
}

export interface InstallCommands {
  mcp_url: string;
  one_line: string;
  cursor_json: string;
  claude: string;
  chatgpt: string;
}

export function installCommands(mcpUrl: string, token?: string): InstallCommands {
  const header = token ? ` --header "Authorization: Bearer ${token}"` : "";
  const one = `claude mcp add --transport http scribemem ${mcpUrl}${header}`;
  const cursor = token
    ? JSON.stringify({ mcpServers: { scribemem: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    : JSON.stringify({ mcpServers: { scribemem: { url: mcpUrl } } }, null, 2);
  const claude = `Claude Desktop: Settings → Connectors → Add custom connector. Paste this address:\n${mcpUrl}\nApprove when Claude opens the consent page.`;
  const chatgpt = `ChatGPT: Settings → Connectors → Create. Paste this address:\n${mcpUrl}\nApprove when ChatGPT opens the consent page.`;
  return { mcp_url: mcpUrl, one_line: one, cursor_json: cursor, claude, chatgpt };
}

export function tryPage(): string {
  return layout("Try Scribe Memory — Instant AI Memory", `<div class="card" style="max-width:620px;margin:40px auto;text-align:center">
    <h1>Try Scribe Memory in Seconds</h1>
    <p class="sub">No email, no password. We'll create a private memory for you and show the one-line install for Claude, ChatGPT and Cursor.</p>
    <form method="POST" action="/try">
      <button type="submit" class="primary" style="font-size:16px;padding:14px 28px">Create my memory</button>
    </form>
    <p class="muted" style="margin-top:20px">Free tier: 1,000 memories and 500 calls a day. You can sign in with email later to keep this memory.</p>
  </div>`);
}

export function tryReadyPage(o: { mcpUrl: string; token: string; expiresIn: number; install: InstallCommands }): string {
  const days = Math.round(o.expiresIn / 86400);
  return layout("Your Scribe Memory is ready", `<div class="card" style="max-width:760px;margin:30px auto">
    <div class="badge-pill">✓ Memory Ready</div>
    <h1>Your memory is ready</h1>
    <p class="sub">This address is yours alone. Copy the one-line command, or paste the address into Claude, ChatGPT or Cursor.</p>
    
    <div style="margin:20px 0">
      <label style="font-size:13px;font-weight:600;color:var(--text-muted)">Memory address</label>
      <p style="margin-top:4px"><code>${esc(o.mcpUrl)}</code></p>
    </div>

    <div style="margin:20px 0">
      <label style="font-size:13px;font-weight:600;color:var(--text-muted)">One-line install (Claude Code)</label>
      <p style="margin-top:4px"><code>${esc(o.install.one_line)}</code></p>
    </div>

    <div style="margin:20px 0">
      <label style="font-size:13px;font-weight:600;color:var(--text-muted)">Cursor (~/.cursor/mcp.json)</label>
      <pre class="mono" style="white-space:pre-wrap;padding:14px;display:block;margin-top:4px">${esc(o.install.cursor_json)}</pre>
    </div>

    <div style="margin:20px 0;background:var(--bg-subtle);border:1px solid var(--surface-border);border-radius:8px;padding:16px">
      <p style="margin:0 0 6px;font-weight:600;font-size:14px;color:var(--text)">Desktop Connectors</p>
      <p class="muted" style="margin:0 0 6px">${esc(o.install.claude)}</p>
      <p class="muted" style="margin:0">${esc(o.install.chatgpt)}</p>
    </div>

    <p class="muted">The temporary access token lasts ${days} days. After that, open <a href="/dashboard">your dashboard</a> and approve the connection.</p>
    <p class="err" style="font-size:13px">Treat the token like a password. Anyone with it can read and write this memory.</p>
    <div style="margin-top:24px">
      <a href="/dashboard" class="btn primary">Open the dashboard</a>
    </div>
  </div>`);
}

export function verifyPage(token: string): string {
  return layout("Sign in — Scribe Memory", `<div class="card" style="max-width:480px;margin:40px auto;text-align:center">
    <h1>Finish signing in</h1>
    <p class="sub">Press the button to sign in on this device.</p>
    <form method="POST" action="/auth/verify">
      <input type="hidden" name="token" value="${esc(token)}">
      <button type="submit" class="primary" style="width:100%">Sign in</button>
    </form>
  </div>`);
}

export function messagePage(title: string, msg: string): string {
  return layout(title, `<div class="card" style="max-width:560px;margin:40px auto;text-align:center">
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(msg)}</p>
    <a href="/login" class="btn ghost">Sign in</a>
  </div>`);
}

export function consentPage(o: { pendingId: string; clientName: string; email: string; tenants: Array<{ id: string; name: string; slug: string }>; fixedTenant?: { id: string; name: string } | null; scopes: string[]; error?: string }): string {
  const write = o.scopes.includes("memory.write");
  const choose = o.fixedTenant
    ? `<input type="hidden" name="tenant_id" value="${esc(o.fixedTenant.id)}"><p>Memory: <b>${esc(o.fixedTenant.name)}</b></p>`
    : `<label for="tenant_id" style="font-size:14px;color:var(--text-muted)">Which memory?</label><select id="tenant_id" name="tenant_id">${o.tenants.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>`;
  return layout("Authorize Scribe Memory access", `<div class="card" style="max-width:580px;margin:40px auto">
    <div class="badge-pill">MCP Authorization</div>
    <h1>Authorize Scribe Memory access</h1>
    <p class="sub"><b>${esc(o.clientName)}</b> wants to ${write ? "search your Helmian Scribe memory and save new memories to it" : "search your Helmian Scribe memory (read only)"}.</p>
    <p class="muted">Signed in as ${esc(o.email)}. <a href="/logout">Not you?</a></p>
    ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
    <form method="POST" action="/consent">
      <input type="hidden" name="pending_id" value="${esc(o.pendingId)}">
      ${choose}
      <div style="display:flex;gap:10px;margin-top:20px">
        <button type="submit" name="action" value="approve" class="primary" style="flex:1">Approve</button>
        <button type="submit" name="action" value="deny" class="ghost" style="flex:1">Deny</button>
      </div>
    </form>
    <p class="muted" style="margin-top:20px;text-align:center">You can disconnect any time from the AI app, or revoke everything from your dashboard.</p>
  </div>`);
}

export function dashboardPage(): string {
  return layout("Helmian Scribe", `<div id="app"><div class="card"><h1>Helmian Scribe</h1><p class="sub">Loading…</p></div></div>`, ["/static/dashboard.js"]);
}

export function gettingStartedPage(): string {
  return layout("Getting started — Helmian Scribe", `<div class="card">
    <div class="badge-pill">Documentation</div>
    <h1>Getting started</h1>
    <p class="sub">Three short steps and your AIs share one memory — including the conversations you have already had. The full guide lives in the docs (GETTING-STARTED.md); this page is the short version.</p>
    
    <h2>1 &bull; Your memory address</h2>
    <p>Your <a href="/dashboard">dashboard</a> shows your memory address. That is the only thing you ever copy.</p>
    
    <h2>2 &bull; Connect your AI</h2>
    <p>In Claude, ChatGPT, Grok or Gemini, add a custom connector and paste your memory address. The app sends you back here to approve — that approval is the whole setup. Then ask your AI: <i>"Search my memory for…"</i></p>
    
    <h2>3 &bull; Bring your old conversations</h2>
    <p><b>Claude:</b> open Settings → Privacy → <b>Export data</b>. Claude emails you a download link — download the .zip, don't open it.</p>
    <p><b>ChatGPT:</b> open Settings → Data controls → <b>Export data</b> → Export. ChatGPT emails you a download link — download the .zip, don't open it.</p>
    <p><b>Gemini:</b> Google Takeout exports are not importable yet — we're honest about that rather than guess at your history. Your Gemini chats stay in Gemini for now.</p>
    <p>Then come back here, go to your <a href="/dashboard">dashboard</a>, pick the .zip under <b>Bring your old chats with you</b> and press <b>Import history</b>. Your old conversations land in your memory, titled and dated, searchable by every AI you connect. Uploading the same file twice is safe — nothing is duplicated. Secrets are scrubbed before anything is stored, exactly like every other save.</p>
    <p class="muted">Limits: one export file up to 50 MB and 2,000 conversations at a time. If your plan's storage fills up mid-import, the import stops safely — upgrade and upload the same file again to continue.</p>
  </div>`);
}

export function mockBillingPage(): string {
  return layout("Helmian Scribe billing (test stub)", `<div class="card" style="max-width:600px;margin:40px auto;text-align:center">
    <h1>Billing is not connected yet</h1>
    <p class="sub">This server has no payment provider key, so checkout is a stub. Nothing was charged. Set PAYMENT_PROVIDER and the matching test or sandbox key (Stripe sk_test_…, or a Paddle sandbox key) to try checkout.</p>
    <a href="/dashboard" class="btn primary">Back to dashboard</a>
  </div>`);
}

export function paddlePayPage(opts: { token: string; environment: "sandbox" | "production" }): string {
  return layout("Helmian Scribe checkout", `<div class="card" id="pay" data-token="${esc(opts.token)}" data-env="${esc(opts.environment)}" style="max-width:600px;margin:40px auto;text-align:center">
    <h1>Opening checkout…</h1>
    <p class="sub" id="paystatus">If nothing opens, allow pop-ups and frames from paddle.com, then reload this page.</p>
    <a href="/dashboard" class="btn ghost">Back to dashboard</a>
  </div>`,
  ["https://cdn.paddle.com/paddle/v2/paddle.js", "/static/paddle-pay.js"]);
}

export const PLANS_HTML = `<div class="plans" id="plans">
  <div class="card plan">
    <div>
      <h2>Free</h2>
      <p class="price">$0</p>
      <p class="sub">1,000 memories and 500 calls a day. Try it with no account.</p>
      <p class="muted">A private memory for the AIs you already use.</p>
      <ul class="features-list">
        <li>1,000 memories limit</li>
        <li>500 calls a day</li>
        <li>Connect Claude, ChatGPT and Cursor</li>
        <li>Automatic secret scrubbing</li>
      </ul>
    </div>
    <form method="POST" action="/try">
      <button type="submit" class="ghost" style="width:100%">Try Free</button>
    </form>
  </div>

  <div class="card plan popular">
    <div class="popular-badge">Most Popular</div>
    <div>
      <h2>Personal</h2>
      <p class="price">$8 <span>/ month</span></p>
      <p class="sub">Or $80 a year. Unlimited memories for one person.</p>
      <p class="muted">One memory every AI you connect can read and write.</p>
      <ul class="features-list">
        <li>Unlimited memories</li>
        <li>Full semantic search & recall</li>
        <li>Import chat history from Claude & ChatGPT</li>
        <li>Export your memories anytime</li>
      </ul>
    </div>
    <a href="/login" class="btn primary" style="width:100%">Choose Personal</a>
  </div>

  <div class="card plan">
    <div>
      <h2>Team</h2>
      <p class="price">$15 <span>/ seat / month</span></p>
      <p class="sub">Unlimited memories, billed per seat.</p>
      <p class="muted">A shared memory for a crew and their AIs.</p>
      <ul class="features-list">
        <li>Everything in Personal</li>
        <li>Shared team knowledge graph</li>
        <li>Centralized billing via Paddle</li>
        <li>Cross-assistant coordination</li>
      </ul>
    </div>
    <a href="/login" class="btn ghost" style="width:100%">Choose Team</a>
  </div>
</div>`;

export function homePage(): string {
  return layout("Scribe Memory", `
    <div class="hero">
      <div class="badge-pill">
        <span>⚡</span> Scribe Memory &bull; Model Context Protocol Native
      </div>
      <h1 class="hero-title">One memory every AI you use can read and write</h1>
      <p class="hero-sub">
        Scribe Memory connects Claude, ChatGPT, and Cursor over MCP so they share what they learn across sessions. What one assistant learns can be recalled by the others, so you do not have to explain the same things again.
      </p>
      <div class="hero-cta">
        <form method="POST" action="/try" style="margin:0">
          <button type="submit" class="primary" style="font-size:16px;padding:14px 28px">Try without signing up</button>
        </form>
        <a href="/login" class="btn ghost" style="font-size:16px;padding:14px 24px">Sign in</a>
      </div>
      <p class="muted" style="margin-top:16px">
        Scribe Memory is a hosted memory service for AI assistants, operated by DairyForge LLC. Your memory is private to your account and walled off from everyone else. Questions or support: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
      </p>
    </div>

    <div class="section-title" id="how-it-works">
      <h2>How It Works</h2>
      <p>Three steps to a unified memory across your AI assistants.</p>
    </div>

    <div class="how-it-works-grid">
      <div class="step-card">
        <div class="step-num">Step 1</div>
        <h3>Connect your AIs over MCP</h3>
        <p>Paste your private Scribe Memory address into Claude, ChatGPT, or Cursor as an MCP connector. Setup takes 30 seconds with no complex configuration.</p>
      </div>
      <div class="step-card">
        <div class="step-num">Step 2</div>
        <h3>They save what they learn</h3>
        <p>Whenever an assistant solves a problem, discovers project patterns, or receives your preferences, it automatically saves the memory to your private bank.</p>
      </div>
      <div class="step-card">
        <div class="step-num">Step 3</div>
        <h3>Any of them can recall it</h3>
        <p>Switch between Claude Code, Cursor, and ChatGPT freely. Any assistant recalls past memories instantly via semantic search without repeated prompting.</p>
      </div>
    </div>

    <div class="section-title">
      <h2>Plans & Pricing</h2>
      <p>Simple, transparent pricing. Start free with no account.</p>
    </div>

    ${PLANS_HTML}

    <div class="trust-banner">
      <p style="margin:0 0 6px">
        Prices are in US dollars. Paid plans are billed by <a href="https://www.paddle.com" target="_blank" rel="noopener"><b>Paddle.com</b></a>, the merchant of record. Paddle handles payments, taxes and refunds.
      </p>
      <p style="margin:0">
        See <a href="/refunds">Refunds</a> for the <b>14-day refund window</b>.
      </p>
    </div>

    <div class="faq-section">
      <div class="section-title" style="margin:40px 0 20px">
        <h2>Frequently Asked Questions</h2>
      </div>
      <div class="faq-item">
        <h3>Is my data private?</h3>
        <p>Yes. Your memory is private to your account and walled off from everyone else. Secrets, API keys, and sensitive tokens are automatically scrubbed before anything is stored.</p>
      </div>
      <div class="faq-item">
        <h3>Which AIs work with Scribe Memory?</h3>
        <p>Any client or assistant that supports the Model Context Protocol (MCP) or custom connectors, including Claude Code, Cursor, Claude Desktop, ChatGPT, and Gemini CLI.</p>
      </div>
      <div class="faq-item">
        <h3>Can I cancel or get a refund?</h3>
        <p>You can cancel your subscription anytime from your dashboard. Paid plans include an unconditional 14-day refund window processed through Paddle.com.</p>
      </div>
    </div>
  `);
}

export function pricingPage(): string {
  return layout("Pricing — Scribe Memory", `
    <div class="section-title" style="margin-top:20px">
      <div class="badge-pill">Pricing</div>
      <h2>Simple, Transparent Plans</h2>
      <p class="sub">Every plan includes a private memory your AIs can share. Prices are in US dollars.</p>
    </div>

    ${PLANS_HTML}

    <div class="card" style="max-width:840px;margin:40px auto">
      <h2 style="margin-top:0">Billing & Guarantee</h2>
      <p>Paid checkout is billed by <a href="https://www.paddle.com" target="_blank" rel="noopener"><b>Paddle.com</b></a>, the merchant of record. Paddle handles payments, taxes and refunds.</p>
      <p>Personal is <b>$8</b> a month, or <b>$80</b> a year. Team is <b>$15</b> per seat per month (<b>$15 per seat</b>). The Free plan is <b>$0</b>, with a limit of <b>1,000 memories</b>.</p>
      <p>Refunds: you can ask for a refund within <b>14 days</b> of a charge. Details are on the <a href="/refunds">Refund policy</a> page.</p>
      <p>Questions: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
      <p style="margin-top:20px"><a href="/try">Try without signing up</a> &middot; <a href="/login">Sign in</a></p>
    </div>
  `);
}

export function termsPage(): string {
  return layout("Terms of Service — Scribe Memory", `<div class="card" style="max-width:840px;margin:30px auto">
    <div class="badge-pill">Legal</div>
    <h1>Terms of Service</h1>
    <p class="muted">Effective date: November 27, 2026</p>
    <p>These terms cover the hosted Scribe Memory service at scribemem.helmian.cloud. The service is operated by DairyForge LLC.</p>
    <h2>The service</h2>
    <p>Scribe Memory is a hosted memory service for AI assistants. You get a private memory. You and the assistants you connect can save notes, facts and files there, and look them up later. The Free plan has a limit of 1,000 memories. Paid plans and prices are listed on the <a href="/pricing">pricing</a> page.</p>
    <h2>Your account</h2>
    <p>You can start without an account, or sign in with your email. You are responsible for the email you use and for what you and your assistants save in your memory. Do not try to reach another person's memory, overload the service, or use it for anything illegal.</p>
    <h2>Payments</h2>
    <p>When you buy a Personal or Team plan, <a href="https://www.paddle.com" target="_blank" rel="noopener"><b>Paddle.com</b></a> is the merchant of record. Paddle handles the payment, taxes, invoices and refunds. DairyForge LLC does not take or store your card details. Refunds are described in the <a href="/refunds">Refund policy</a>.</p>
    <h2>Changes and ending use</h2>
    <p>We may change the service or these terms. When we do, we will post the new terms on this page. You can stop using the service at any time. We may suspend or close an account that breaks these terms.</p>
    <p>Questions: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
  </div>`);
}

export function privacyPage(): string {
  return layout("Privacy Policy — Scribe Memory", `<div class="card" style="max-width:840px;margin:30px auto">
    <div class="badge-pill">Privacy</div>
    <h1>Privacy Policy</h1>
    <p class="muted">Effective date: November 27, 2026</p>
    <p>This policy covers the hosted Scribe Memory service at scribemem.helmian.cloud, operated by DairyForge LLC. Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
    <h2>What we collect</h2>
    <p>If you sign in, we store the email address you give us. If you try the service without an account, we create a private guest memory for you. We store the memories, files and settings that you and your connected assistants save. We also keep technical logs needed to run and secure the service, such as connection times and error reports.</p>
    <h2>Payments</h2>
    <p>If you buy a plan, <a href="https://www.paddle.com" target="_blank" rel="noopener"><b>Paddle.com</b></a> is the merchant of record and handles payment details. We do not store your full card number. Paddle's own privacy policy applies to the payment information you give Paddle.</p>
    <h2>How we use this</h2>
    <p>We use this information to provide your memory, sign you in, apply plan limits, and keep the service secure. We do not sell your memories or your email. Your memory is stored in a space for your account; other customers cannot read it. We use infrastructure providers (hosting and database) to run the service.</p>
    <h2>Cookies and your choices</h2>
    <p>We use a sign-in cookie so you can stay signed in. You can export your memories from the dashboard. To ask us to delete your account, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
    <p>If we change this policy, we will post the update on this page.</p>
  </div>`);
}

export function refundsPage(): string {
  return layout("Refund Policy — Scribe Memory", `<div class="card" style="max-width:840px;margin:30px auto">
    <div class="badge-pill">Refunds</div>
    <h1>Refund Policy</h1>
    <p class="muted">Effective date: November 27, 2026</p>
    <p>This policy covers paid Personal and Team plans for the hosted Scribe Memory service, operated by DairyForge LLC.</p>
    <p>If you buy a plan and you are not satisfied, you can ask for a refund within <b>14 days</b> of the charge.</p>
    <p><a href="https://www.paddle.com" target="_blank" rel="noopener"><b>Paddle.com</b></a> is the merchant of record. Paddle handles payments, taxes and refunds.</p>
    <p>To request a refund, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and include the email address used on the purchase. We will work with Paddle to process the refund.</p>
    <p>After 14 days, refunds are decided case by case. The Free plan has no charge, so there is nothing to refund.</p>
    <p>Prices are listed on the <a href="/pricing">pricing</a> page. Questions: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
  </div>`);
}

export const THEME_JS = `(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');
  root.setAttribute('data-theme', initial);

  function sync(theme) {
    const lbl = document.getElementById('theme-label');
    if (lbl) lbl.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  function init() {
    sync(root.getAttribute('data-theme') || 'light');
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.onclick = () => {
        const cur = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = cur === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        sync(next);
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

/** Content-Security-Policy for /billing/pay only. */
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
  app.append($('<div class="card"><h1>' + esc(t.name) + '</h1><p class="sub">Signed in as ' + esc(me.user.email) + ' · <a href="/logout">Sign out</a></p>' +
    '<h2>Your memory address</h2><p>Paste this into Claude, ChatGPT, Grok, Gemini or your coding tools as a custom connector:</p><p><code>' + esc(me.mcp_url) + '</code></p>' +
    '<p class="muted">The AI app will open a page here asking you to approve. That is the only step.</p></div>'));
  app.append($('<div class="card"><h2>Plan: ' + esc(p.name) + (t.plan_status !== 'active' ? ' (' + esc(t.plan_status) + ')' : '') + '</h2>' +
    '<p>' + u.memories.toLocaleString() + (p.maxMemories === null ? ' memories (no limit)' : ' of ' + p.maxMemories.toLocaleString() + ' memories') + ' · ' + mb(u.bytes) + ' of ' + mb(p.maxBytes) + ' stored</p>' +
    '<p>' + u.calls_today.toLocaleString() + ' of ' + p.maxCallsPerDay.toLocaleString() + ' calls today (resets at midnight UTC)</p>' +
    (me.tenant.plan === 'free' ? '<button class="primary" data-plan="personal" data-interval="month">Personal $' + me.plans.personal.priceUsdMonthly + '/month</button><button class="ghost" data-plan="personal" data-interval="year">Personal $' + me.plans.personal.priceUsdYearly + '/year</button>' +
      '<p style="margin-top:14px">Team, $' + me.plans.team.priceUsdMonthly + ' per seat per month: <input id="seats" type="number" min="1" max="' + me.max_seats + '" value="2" style="width:80px;display:inline-block"> seats <button class="ghost" data-plan="team" data-interval="month">Choose Team</button></p>' : '') +
    (me.tenant.plan === 'team' ? '<p>' + t.seats + ' seat' + (t.seats === 1 ? '' : 's') + ' <input id="newseats" type="number" min="1" max="' + me.max_seats + '" value="' + t.seats + '" style="width:80px;display:inline-block"> <button class="ghost" id="setseats">Change seats</button></p>' : '') +
    '<button class="ghost" id="portal">Manage billing</button>' +
    '<p class="muted">Billing mode: ' + esc(me.billing_mode) + '</p></div>'));
  app.append($('<div class="card"><h2>Flags</h2>' + (flags.length ? '<table><tr><th>When</th><th>Severity</th><th>What</th><th>From</th></tr>' + flags.map((f) => '<tr><td>' + esc(new Date(f.created_at).toLocaleString()) + '</td><td class="sev-' + esc(f.severity) + '">' + esc(f.severity) + '</td><td>' + esc(f.reason) + (f.excerpt ? '<br><span class="mono">' + esc(f.excerpt.slice(0, 160)) + '</span>' : '') + '</td><td>' + esc(f.source_ai || '') + '</td></tr>').join('') + '</table>' : '<p class="muted">No flags yet. Secrets and personal numbers are redacted before anything is stored.</p>') +
    '<h2 style="margin-top:16px">Alerts</h2><label>Email</label><input id="ae" value="' + esc(t.alert_email || '') + '"><label>Webhook (https)</label><input id="aw" value="' + esc(t.alert_webhook_url || '') + '"><label>Alert at</label><select id="as">' + ['low','medium','high','critical'].map((s) => '<option' + (s === t.alert_min_severity ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><button id="savealerts">Save alerts</button></div>'));
  app.append($('<div class="card"><h2>API keys (for Helmian Guard and other services)</h2>' + (keys.length ? '<table>' + keys.map((k) => '<tr><td>' + esc(k.name) + '</td><td class="mono">' + esc(k.prefix) + '…</td><td>' + (k.revoked_at ? 'revoked' : '<button class="ghost" data-revoke="' + esc(k.id) + '">Revoke</button>') + '</td></tr>').join('') + '</table>' : '<p class="muted">None yet.</p>') + '<input id="kn" placeholder="Key name, e.g. Guard extension"><button id="newkey">Create key</button><p id="keyout"></p></div>'));
  app.append($('<div class="card"><h2>Bring your old chats with you</h2><p>Export your history from Claude or ChatGPT and upload the .zip here — your old conversations land in this memory, titled and dated, searchable by every AI you connect. Uploading the same file twice is safe: nothing is duplicated.</p><p><a href="/getting-started">Step-by-step guide: how to export from Claude or ChatGPT</a></p><input type="file" id="impfile" accept=".zip"><button id="impgo">Import history</button><p id="impout"></p></div>'));
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
