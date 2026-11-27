# Personal (single-user) Scribe memory server

This folder is the source of the owner's own memory server, the one that runs on the production host as the
`claude-memory-mcp-scribe` container (built on the host from `/opt/scribe-build/graph-src`) over the single-user
`claude_memory` database. It is **not** the hosted multi-tenant service in `server/server.src/app`.

**Origin.** The first commit that adds this folder is a verbatim copy of `/opt/scribe-build/graph-src` as it was on
2026-11-27 after the `scribe:unread-20261127` deploy (the 2026-11-26 snapshot in
`live-snapshots/2026-11-26-hetzner/memory-server-scribe` plus that day's `/mailbox/unread` change). Copied read-only;
no `node_modules`, `dist`, env files or `*.bak*` files. Until now this code lived only on the host.

Build: `npm ci && npm run build` (or the `Dockerfile`). Tests: `npm test` (in-process Postgres, no network).
