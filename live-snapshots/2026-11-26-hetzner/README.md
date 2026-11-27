# Live snapshot — source copied from the running Scribe servers (2026-11-26)

**What this is.** A faithful, read-only copy of the source code that is running on the
production host but was not in this repository. It is stored here *unmodified* (see
"Changes made while copying") so the repo finally holds the code that is deployed.
Nothing in this folder is built, tested or imported by the rest of the repo; it is a
reference snapshot. The follow-up commits in this branch port the missing *features*
into the real source tree.

**How it was obtained (read-only).** SSH to the production host, `tar` streamed to the
audit box's scratch space (nothing was written on the server), plus `docker exec … tar`
for the door's code inside its container. No environment files, `app.env`, OAuth/state
files, databases or logs were copied.

| Snapshot folder | Running container / image (image id) | Source on host |
|---|---|---|
| `scribe-door/` | `scribe-door` = `helmian-door-helmian:1.0.5-gemini` (`sha256:19059f05…`) | extracted from the container, `/srv/helmian-door` (`src/*.mjs` sha256-identical to the running files) |
| `memory-server-scribe/` | `claude-memory-mcp-scribe` = `scribe:doorbellfix-20261124-054644` (`sha256:5e43160a…`) | `/opt/scribe-build/graph-src` |
| `memory-server-sslip/` | `claude-memory-mcp` = `claude-memory-mcp:graphv2-20261123-234748` (`sha256:fbfd7eef…`) — the server behind the `*.sslip.io` address | `/opt/claude-memory-mcp/app` |
| `graph-deploy/` | — | `/opt/graph-fix-deploy` (deploy notes, proof script, migrations 008) and `/root/007_graph.sql` |

**Verified faithful.** Both memory-server source trees were rebuilt here with `tsc`
(`npm install` from each tree's own lock file) and the output compared with the `dist/`
folder inside the running container: **byte-identical** (`diff -rq` empty) for both.
The door source files match the container's files by sha256.

## What the live code has that this repo did not

* `memory-server-*/src/librarian/graph.ts` + `extract.ts` — the **knowledge graph**
  (`entities`, `entity_aliases`, `links` tables) and the `graph_neighbors` MCP tool.
  Tables come from `graph-deploy/007_graph.sql` and `graph-deploy/008_graph_value_kind.sql`
  (the live server applied both; 008 is confirmed applied by `graph-deploy` run log).
* `scribe-door/` — the door's **`scribe` flavour** (reports itself as `scribe-door`,
  offers `hands.read`/`hands.act` scopes), Gemini-strict schema scrub, `Accept` header
  normalisation, and re-issue of a duplicated consent POST.

## What the repo has that the live code does NOT (live is behind)

* Flags/redaction (`flags/service|alerts|moderation`) and `report_flag`/`list_flags`.
* Mailbox-move guard in `move_memory` (moves into `for-<agent>` never teach a rule).
* The door-knock route `GET /mailbox/unread`, `GET /mcp` bearer check
  (the live memory server answers `GET /mcp` without the bearer middleware).
* The whole SaaS/multi-tenant tree (`saas/`) and `single.ts`.

So the live memory server is a **fork that diverged** from this repo, not a superset.
Deploying this repo's server as-is would *gain* flags, door-knock and the bearer check
but *lose* the graph unless the graph port in this branch is used (it is).

## Vocabulary difference (needs the owner's decision)

The live memory server ships a **neutral** vocabulary (`presets.ts`/`vocab.ts`: one
example business, empty day-job word lists, no personal names). This repo's
`librarian/vocab.ts` still ships the owner's own businesses and day-job words. That is
why a phrase like "Giltner trucking" files differently live vs. in the repo.
This branch leaves the repo vocabulary as is and does **not** import the neutral one.

## Changes made while copying

* `graph-deploy/007_graph.sql`: one comment example name replaced by a placeholder
  (`'jdoe1'` / `'Jane Doe'`).
* `memory-server-sslip/.env.example` and `graph-deploy/DEPLOY.md`: the real database host
  name replaced by `<NEON_HOST>` / `<NEON_ENDPOINT>` placeholders. Nothing else.
* Not copied: `app.env`, `*.bak*` files, `dist/`, `node_modules/`, deploy logs, `data/`.
* Secret scan over the whole snapshot found no tokens, passphrases or connection strings.
