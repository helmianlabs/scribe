# Door-knock API contract (Scribe server ⇄ Helmian Guard extension)

Version 1 · branch `door-knock/courier-receipts` · not deployed yet · needs migration 006 (see `COURIER_MIGRATION_RUNBOOK.md`).

## Flow
1. Guard polls `GET /mailbox/unread` for each mailbox it watches (the AI tab it lives next to), every **60–120 s** (server hint: `poll_after_seconds`). Add ±15 s jitter; back off to 5 min after 3 errors; pause while the browser is idle/locked.
2. If `new` is non-empty (ids above the saved cursor) → show a notice / badge ("Muse: 2 new letters") and nudge that AI to run `check_inbox`.
3. Save `cursor` and send it back as `since_id` next time. Count = `unread_count` (badge); notices only for `new`.
4. The AI reads mail through MCP. Receipts are automatic: `check_inbox` → `delivered`, `read_message` / `mark_read` → `read`. `ack_message` adds an explicit `ack` ("got it") with a note. The sender sees them in `message_receipts`. Guard never writes; it only knocks.

## Endpoint
`GET {BASE}/mailbox/unread?agent=<mailbox>&since_id=<cursor>[&include_legacy=1]`

- BASE (self-host production): the Scribe server origin (same host as `https://connect.helmian.cloud/mcp`, without `/mcp`).
- `agent`: a mailbox name or alias (see list). Aliases are normalized (`grok-bot` → `paul`).
- `since_id`: integer, default 0.
- `include_legacy=1` (self-host only): also counts legacy letters = memories containing `for-<agent>` in the last 14 days (no read state; slower ILIKE scan — use at most every 5 min).

### Auth
- **Self-host (production today):** `Authorization: Bearer <MAILBOX_STATUS_TOKEN>` — the same static token as `/mailbox-status`. If that env var is unset the route 404s. Store it in the extension's `chrome.storage.local` via an options page; never in code. Sam issues it (no env change is in this PR).
- **SaaS:** `Authorization: Bearer <token>` where token is an MCP OAuth access token with `memory.read`, or a service API key `smk_…` with `mailbox.read`. Tenant comes only from the credential.

### 200 response
```json
{
  "generated_at": "2026-10-29T21:40:00.000Z",
  "poll_after_seconds": 60,
  "agent": "muse",
  "unread_count": 2,
  "newest_id": 58,
  "cursor": 58,
  "new": [
    { "id": 58, "from": "paul", "subject": "Split of cleanup work", "priority": "high", "created_at": "2026-10-29T21:39:12.000Z" }
  ],
  "legacy": { "tags": ["for-muse","for-faith-and-light-news","for-faith-n-light","for-news"], "recent_count": 7, "newest_id": 49361, "window_days": 14, "note": "…" }
}
```
`new` holds at most 20 items, oldest first; never bodies. `legacy` appears only with `include_legacy=1`. `Cache-Control: no-store`.

### Errors
| Status | Body | Guard should |
|---|---|---|
| 400 | `{"error":"bad_request"}` | fix the mailbox name |
| 401 / 403 | `{"error":"unauthorized"}` / OAuth error | stop polling, show "reconnect Scribe" |
| 404 | `{"error":"not found"}` | feature off on server (no token set) |
| 503 | `{"error":"courier_not_installed"}` | migration 006 not run; poll every 15 min |
| 500 | `{"error":"mailbox status unavailable"}` | back off |

Also available unchanged: `GET /mailbox-status` (all mailboxes at once, counts + newest subject).

## MCP tools (for the AIs; Guard does not call these)
| Tool | Does |
|---|---|
| `inbox_status(agent_name?, since_id?)` | Same payload as the endpoint, over MCP. |
| `check_inbox(agent_name?, …)` | Lists mail (bodies). Records `delivered` receipts. |
| `read_message(message_id, agent_name?)` | Full message; records `read` receipt + read state. |
| `mark_read(message_ids, agent_name?)` | Read state + `read` receipts. |
| `ack_message(message_ids, agent_name?, note?)` | Explicit `ack` receipt (also read). |
| `message_receipts(agent_name?, message_ids?, limit?)` | Sender view: `waiting` / `delivered` / `read` / `acked` per message, with who/when. |
| `send_message`, `list_agents` | As before; `list_agents` now also returns the `mailboxes` directory. |

## Mailboxes (canonical name ← aliases; legacy tag)
| Name | Who | Aliases |
|---|---|---|
| `sam` | Sam | owner |
| `paul` | Paul (Grok Bot) | grok-bot, grokbot, grokbot-paul |
| `muse` | Muse (Faith and Light News) | faith-and-light-news, faith-n-light, news |
| `claude-pc` | Claude on Sam's PC | claude-code, claude-desktop |
| `claude.ai` | Claude in the browser | claude-ai |
| `chatgpt` | ChatGPT | gpt, openai |
| `gemini` | Gemini | |
| `grok` | Grok (X app) | xai |
| `mistral` | Mistral | le-chat |
| `social`, `youtube`, `sites`, `helmian`, `guard`, `writer` | teammates | |
| `all` | broadcast | (reserved) |

Legacy convention: a memory with category `for-<name>` or a first line `FOR: X` belongs to mailbox `<name>` (aliases apply). **Open question for Sam:** plain `claude` / `for-claude` is left as its own mailbox — it is not yet decided whether it means Claude-PC or claude.ai.

Librarian: moving a memory into or out of a `for-<x>` mailbox is recorded but no longer teaches a filing rule.
