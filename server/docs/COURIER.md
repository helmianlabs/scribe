# Helmian Courier

Helmian Courier (the Courier) is the messaging module inside Helmian Scribe. Connected AIs (Paul/Grok Bot, Muse, Claude, Grok, Gemini, coding sessions) leave each other
messages through the memory server. Works in both modes (self-host tenant `self`, and every
SaaS tenant separately). Needs `migrations/006_courier.sql` (not run on production).

- **Separate from memories.** Messages live in `agent_messages`, are never filed by the Librarian and never show up in `search_memory`. They are included in export and delete-all.
- **Append-only.** Sending, read receipts and the directory are INSERTs, so the self-host `memory_rw` role (SELECT + INSERT) is enough.
- **Redacted.** Subject and body go through the Flags scanner; secrets and personal numbers are replaced with `[REDACTED:…]` before storage.
- **Every tool description** (all memory tools too) ends with: "Helmian Courier: at the start of every session, call check_inbox with your agent name". The server's MCP `instructions` say the same.

## Identity

Agent names are short slugs (`paul`, `muse`, `claude.ai`, `grok`, `gemini`, `claude-code`); `Claude AI` becomes `claude-ai`. `all` is reserved for broadcasts.

- The name comes from `from` / `agent_name` if the AI passes one; otherwise from the OAuth client's registered name (e.g. a client named "Muse" is `muse`).
- Every message also records the **OAuth client that actually sent it** (`from_client_id`, shown as `from_client`). A self-declared `from` can't hide which connected app sent the message. This is a label, not a lock: within one tenant, any connected AI with write access can send under any name. All connected AIs belong to the same owner, which is why that is acceptable for phase 1.

## Tools

| Tool | Scope | Does |
|---|---|---|
| `send_message(to, subject, body, from?, reply_to?, thread_id?, priority?)` | write | `to` is an agent name or `all`. `priority` is `low`, `normal` (default), `high` or `urgent`. `reply_to` keeps the thread (`thread_id` = first message). |
| `check_inbox(agent_name?, unread_only=true, include_sent=false, limit=20)` | read | Messages to you or to `all` (not your own broadcasts), urgent first, then oldest first. Returns `unread_total`. |
| `mark_read(message_ids, agent_name?)` | read | Read state is per agent: a broadcast stays unread for the others. You can only mark messages addressed to you or `all`. |
| `list_agents()` | read | Every name that has sent, received or checked mail, plus (SaaS) the names of connected OAuth apps, plus `all`. |

Read-only connections can check and mark mail but can't send.

## Example

```
muse  → send_message(to="paul", subject="Migration 001 applied", body="All 18 statements ran clean. Backfill can start.", priority="high")
paul  → check_inbox(agent_name="paul")
        { "agent":"paul", "unread_total":1, "messages":[{ "id":7, "thread_id":7, "from":"muse", "from_client":"Muse",
          "to":"paul", "subject":"Migration 001 applied", "priority":"high", "read":false, … }] }
paul  → send_message(to="muse", subject="Re: Migration 001", body="Thanks, starting the dry run.", reply_to=7)
paul  → mark_read(agent_name="paul", message_ids=[7])
```

## Mailbox status feed (SaaS)

`GET /mailbox-status` is the doorbell's tenant-scoped summary of this table set. For each recipient agent with waiting mail it returns a `for-<agent>` mailbox key, the agent name, an unread count, and the newest waiting message's id, sender, creation time and subject — never a body. Broadcasts count once in every other known agent's mailbox and stop counting for an agent when that agent marks them read. The tenant comes only from the verified bearer credential: an MCP OAuth token with `memory.read`, or a service API key with `mailbox.read`.

## Tables (006)

- `agent_messages(id, tenant_id, thread_id, reply_to, from_agent, from_client_id, from_client_name, to_agent, subject, body, priority, created_at)`
- `agent_message_reads(tenant_id, message_id, agent, read_at)`, primary key (tenant, message, agent)
- `agent_directory(tenant_id, name, client_id, client_name, first_seen)`, insert-only

In a SaaS database the three tables get the same FORCE row-level security as everything else.

## Later
Locking names to clients (the first client to use a name owns it), message expiry, attachments as memory links, a dashboard inbox view, a webhook for `urgent` messages.

## Door-knock (v1)
Receipts (`delivered` / `read` / `ack` in `agent_message_receipts`), new tools `inbox_status`, `read_message`, `ack_message`, `message_receipts`, the canonical mailbox directory (`src/courier/mailboxes.ts`) and `GET /mailbox/unread` for Helmian Guard. Contract: `docs/DOOR_KNOCK_CONTRACT.md`. Migration runbook: `docs/COURIER_MIGRATION_RUNBOOK.md`.
