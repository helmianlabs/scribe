# Helmian Scribe — Flags API

For services that report or read flags (Helmian Guard extension, other bots). Flags are
problems worth a human's attention: a secret or personal number in a chat, harmful code an
AI suggested, hedging/evasion, a privacy leak.

## Pipeline

Every saved memory and every reported flag goes through the same steps:
1. **Scan, locally** (`src/flags/scanner.ts`, no network). Secrets and PII are **replaced** with `[REDACTED:<rule>]` before anything is stored, logged or sent. Harmful code and hedging are flagged, not removed.
2. **Optional moderation** (OpenAI, only if `OPENAI_API_KEY` is set), on the already-redacted text. Errors and timeouts mean "no finding".
3. **Store** per tenant in `flags`.
4. **Alert** at or above the tenant's threshold (default `high`): email via Resend, and/or a signed webhook. With no keys configured, alerts are a no-op that reports `stubbed`.

### Scanner rules

| Category | Severity | Rules (rule id) |
|---|---|---|
| secret (redacted) | critical/high | `secret.private_key`, `aws_access_key`, `aws_secret_key`, `github_token`, `anthropic_key`, `openai_key`, `stripe_key`, `stripe_webhook_secret`, `slack_token`, `google_api_key`, `resend_key`, `jwt`, `bearer_token`, `connection_string_password`, `password_assignment` (placeholders like `****`, `${VAR}`, `<your-token>` are ignored) |
| pii (redacted) | high | `pii.card_number` (Luhn-checked), `pii.ssn`, `pii.ssn_labeled` |
| harmful_code | critical/high/medium | `harmful.rm_rf_root`, `fork_bomb`, `disk_wipe`, `chmod_777_root`, `reverse_shell`, `pipe_to_shell` (curl/wget piped to a shell from a host not on the installer allow-list; extend with `FLAGS_SAFE_INSTALL_HOSTS`), `powershell_download_exec`, `obfuscated_eval`, `credential_exfiltration`, `drop_database`, `disable_security` |
| hedging | low | `hedging.phrases` ("as an AI", "I can't verify", "I may be wrong", refusals, knowledge-cutoff talk, …) |
| moderation | high/medium | `moderation.openai` |

Callers may also report categories `privacy` and `other`.

## Authentication

- **Service API key** (for Guard and other services): the tenant owner creates one on the dashboard or with `POST /api/keys {"name":"Guard extension","scopes":["flags.write","flags.read"]}` (signed-in session). The key (`smk_…`) is shown once and stored only as a SHA-256 hash. Send `Authorization: Bearer smk_…`. Keys work **only** on the `/api/flags*` endpoints, plus `GET /mailbox-status` when created with the separate `mailbox.read` scope. Revoke: `DELETE /api/keys/<id>`.
- **Signed-in session** (dashboard): cookie + `X-Requested-With` header + same origin.
- **MCP** (connected AIs): tools `report_flag` (needs `memory.write`) and `list_flags`.

Every API-key call counts toward the tenant's daily call limit (402 when over).

## Endpoints

Base: `PUBLIC_URL` (e.g. `https://memory.example.com`).

### `POST /api/flags` — report (scope `flags.write`)
```json
{
  "severity": "high",                 // low | medium | high | critical
  "category": "privacy",              // secret | pii | harmful_code | hedging | privacy | moderation | other
  "reason": "User pasted a card number into ChatGPT",   // 3-1000 chars, plain words
  "source_ai": "chatgpt",             // which AI produced / received the content
  "excerpt": "my card is 4242 4242 4242 4242",           // optional, ≤5000 chars, REDACTED before storage
  "url": "https://chatgpt.com/c/123", // optional
  "rule": "guard.redact.card",        // optional, your own rule id
  "reporter": "guard-extension/0.3",  // optional, appended to the key name
  "context": { "browser": "chrome" }  // optional object, redacted, ≤4 KB
}
```
`201`:
```json
{ "flags": [ { "id": 12, "severity": "high", "category": "privacy", "origin": "api", "excerpt": "my card is [REDACTED:card_number]", "reporter": "key:Guard extension (guard-extension/0.3)", "created_at": "…" },
             { "id": 13, "severity": "high", "category": "pii", "rule": "pii.card_number", "origin": "scanner", … } ],
  "redactions": 1,
  "alert": { "sent": true, "email": "sent", "webhook": "skipped" } }
```
The server's own scan of the excerpt adds extra flags (it can upgrade what the reporter saw). `400` on a bad body, `401` bad/revoked key or missing scope, `402` over the daily limit.

### `GET /api/flags` — list (scope `flags.read`)
Query: `min_severity`, `category`, `since` (ISO-8601), `limit` (1-500, default 50). Newest first.
```json
{ "installed": true, "flags": [ { "id": 13, "tenant_id": "…", "severity": "high", "category": "pii", "rule": "pii.card_number", "origin": "scanner", "source_ai": "chatgpt", "reporter": "server", "reason": "A payment card number was found.", "excerpt": "my card is [REDACTED:card_number]", "message_id": null, "context": {}, "created_at": "2026-10-22T09:30:00.000Z" } ] }
```
Polling: pass the newest `created_at` you have as `since`.

### `POST /api/flags/scan` — scan without storing (scope `flags.read`)
`{"text": "…"}` (≤50,000 chars) → `{"redacted": "…", "redactions": 1, "findings": [{"category","rule","severity","reason","snippet"?}]}`. Use it to redact text before it leaves the browser with the same rules the server uses. Nothing is stored.

## Alert webhook

Set per tenant on the dashboard or `POST /api/alerts {"alert_webhook_url":"https://…","alert_email":"…","alert_min_severity":"high"}` (owner session). Server-wide fallback: `ALERT_WEBHOOK_URL`. Signing secret: `ALERT_WEBHOOK_SECRET` (without it, webhooks are stubbed). Only `https` URLs (http only with `ALERT_ALLOW_HTTP_WEBHOOK=1`, for local testing). 5 s timeout, no retries yet.

```
POST <your url>
Content-Type: application/json
X-Memory-Signature: t=1792660000,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{ "type": "flags.raised", "tenant_id": "…", "created_at": "…",
  "flags": [ { "id": 12, "severity": "critical", "category": "secret", "rule": "secret.github_token", "reason": "A GitHub token was found.", "source_ai": "claude.ai", "excerpt": "token [REDACTED:github_token]" } ] }
```
Verify: recompute the HMAC over `"<t>.<raw body>"`, compare in constant time, reject if `t` is more than 5 minutes old. Reference: `verifyWebhookSignature` in `src/flags/alerts.ts`.

## MCP tools

- `report_flag(severity, category, reason, source_ai, reporter?, excerpt?, url?)` — same as `POST /api/flags`.
- `list_flags(min_severity?, category?, since?, limit?)` — same as `GET /api/flags`.
- `save_memory` returns `redactions`, `flags` (what fired) and `flag_ids`.

## Self-host mode

`report_flag` / `list_flags` and save-time redaction work in self-host mode (`SCRIBE_MODE=single`, the default) too (tenant `self`, needs `004_flags.sql`). Alerts there go to `ALERT_EMAIL_TO` / `ALERT_WEBHOOK_URL`. The REST endpoints are SaaS-mode only for now.

## Guard integration checklist (for the Guard bot)
1. Owner creates an API key named for the extension; the extension stores it in `chrome.storage.local`.
2. Extension keeps redacting locally (`redact.js`) before anything leaves the browser; optionally cross-check with `POST /api/flags/scan`.
3. On a local flag, `POST /api/flags` with `source_ai` = the chat site (`claude.ai`, `chatgpt`, `gemini`, `grok`), `url`, and the **already redacted** excerpt.
4. Show alerts by polling `GET /api/flags?since=…&min_severity=high`, or run a small receiver for the webhook.
