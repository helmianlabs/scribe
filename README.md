<div align="center">

# Scribe Memory

### A memory MCP server for Claude, ChatGPT and Cursor

[![GitHub Repo stars](https://img.shields.io/github/stars/helmianlabs/scribe)](https://github.com/helmianlabs/scribe/stargazers)
[![License: BUSL 1.1](https://img.shields.io/badge/license-BUSL%201.1-blue.svg)](LICENSE)
[![MCP server](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Website](https://img.shields.io/badge/site-scribemem.helmian.cloud-0f766e)](https://scribemem.helmian.cloud)

</div>

Scribe is a source-available memory MCP server (Model Context Protocol) that
gives Claude, ChatGPT, Cursor, and any other MCP client one shared long-term
memory. A librarian sorts memories into folders and keeps a knowledge graph of
the people, places, projects and other entities in those memories. On our test,
recall is 18 of 18, and a full recall uses 61% to 99% fewer tokens than pasting
all memories.

Scribe also gives your AIs a mailbox, and a pair of hands on your own computer.
Any AI that can speak MCP can use it.

## Hosted Scribe Memory (try without an account)

The hosted service is at [scribemem.helmian.cloud](https://scribemem.helmian.cloud).
Open [scribemem.helmian.cloud/try](https://scribemem.helmian.cloud/try) to create a
private memory — no email, no password. The page prints a memory address and a
one-line install command.

```bash
curl -sS -X POST https://scribemem.helmian.cloud/try -H 'Accept: application/json'
```

That returns your `mcp_url`, an access token, and `install.one_line`. For Claude Code:

```bash
claude mcp add --transport http scribe-memory https://scribemem.helmian.cloud/t/<slug>/mcp --header "Authorization: Bearer <token>"
```

- **Cursor:** add the JSON from the try page to `~/.cursor/mcp.json` (or Cursor Settings → MCP).
- **Claude:** Settings → Connectors → Add custom connector, paste the memory address, then Approve.
- **ChatGPT:** Settings → Connectors → Create, paste the memory address, then Approve.

To keep a memory and sign in later, open
[scribemem.helmian.cloud/login](https://scribemem.helmian.cloud/login) and enter
your email. Scribe sends a one-time sign-in link. The same link creates an
account if you are new.

Paid checkout (Personal $8/month, Team $15/seat) is not open yet. The Free plan
limits apply to try memories. Self-host and the Windows app are still in this
repository; they are a separate setup from the hosted service.

## Self-host and the Scribe PC program

This repository holds **all of Scribe** — the PC program, the memory server,
the door and the Guard — under the Business Source License 1.1 (see LICENSE).

For a self-hosted or owner-run setup, AIs connect to Scribe's memory and mailbox
through Scribe's door (`https://scribe.dairyforge.com/mcp`), and the owner
approves each connection with the Scribe passphrase.

The PC program is **Scribe**: the Windows installer is
named Scribe and pairs your PC through the Scribe hands hub,
using your Scribe passphrase or a 10-minute pairing code.

## Screenshots

The Scribe site, where an AI connects in one paste:

![Scribe landing page: one memory every AI you work with can share](https://scribe.helmian.cloud/images/scribe-landing.png)

![Connect your AI to Scribe in one paste, with the steps for each app](https://scribe.helmian.cloud/images/scribe-connect.png)

## What's in this repository

| Folder | What it is |
|---|---|
| `spoke/` | The Scribe PC program (Windows agent), its installer, the agent-os profile kit, and the hands hub that connects your AIs to the PC |
| `server/` | The Scribe memory server: shared memory, the Librarian, Courier (the AIs' mailbox), the Neon/Postgres connection and migrations |
| `door/` | The Scribe door at scribe.dairyforge.com: one OAuth consent and one MCP endpoint for the memory and hands toolsets |
| `live-snapshots/` | Read-only copies of source that was running in production but was not in this repository (kept for reference; not built or tested). See its README |
| `guard/` | Scribe's Guard, whole and unchanged: the browser extension (with auto-nudge), Executive Guard, and the kernel sources the extension is generated from |

`guard/hands-mcp` and `guard/src/hands` are links to the PC program's copies, so
Guard's own cross-checks run here without changing any Guard file.

## Download

See [Releases](https://github.com/helmianlabs/scribe/releases). Each
release is built from this repository's source in GitHub Actions.

- The Windows installer is **not code-signed yet**, so Windows SmartScreen
  warns before it runs (More info, then Run anyway).
- The newest published release is v1.1.0 (`Scribe-Setup-1.1.0-win-x64.exe`, November 26, 2026).

## What it does

- **Remembers once, for every AI.** Every AI you connect reads and writes the
  same shared memory, so what one AI learns, the others can use.
- **Files memories and links the named things in them.** The Librarian shelves
  each memory and builds a knowledge graph of people, places, projects, agents
  and other entities, with proven links (who wrote it, where it was filed, what
  it mentions). On self-host, the read-only `graph_neighbors` tool returns one
  entity and its linked neighbours.
- **Gives your AIs a mailbox.** With Courier, your AIs leave each other
  letters: hand-offs, status and questions, delivered through Scribe.
- **Pairs** your PC once, with your Scribe passphrase or a one-time pairing code,
  and then starts each time you sign in through a
  Windows scheduled task named `Scribe`.
- **Runs approved work** that your AIs send, limited to the
  folders you chose (by default your user folder). Work Scribe's Guard flags
  asks for an approval first. Root-level actions need a signed grant from
  you.
- **Opens your own AI app sign-ins** (for example the ChatGPT, Claude, Grok
  or Gemini command-line tools) on your PC when you ask, so you can use the
  plan you already pay for. The program never sees those passwords.

## Plans

- **Free** — $0: 1,000 memories, 50 MB, 500 calls a day, every MCP connector,
  Librarian filing with the why-trail, 3 typed rules, search and recall, export
- **Personal** — $8/month or $80/year: adds learning, unlimited rules, the
  people, places and companies shelves, unlimited memories, 5 GB, 10,000
  calls a day, and ChatGPT and Claude history import. The Librarian's
  knowledge graph is live on self-host (`graph_neighbors`). On the hosted
  service it is reserved for Personal and Team but is not on the hosted MCP
  yet. Daily backups are also reserved for this tier and are not running yet.
- **Team** — $15 per seat. Paid checkout is not open yet, and there is no
  team invite flow yet.
- **Self-Hosted** — custom

Try the hosted service for free at [scribemem.helmian.cloud/try](https://scribemem.helmian.cloud/try).
Paid checkout is not open yet. The self-host / PC app is documented below.

## Install

1. Download `Scribe-Setup-<version>-win-x64.exe` from
   [Releases](https://github.com/helmianlabs/scribe/releases).
2. Run it (Windows will warn because it is unsigned) and type your Scribe passphrase, or paste a pairing code,
   when asked.

The installer is per-user; no admin rights are needed.

## Uninstall

Windows Settings > Apps > Installed apps > **Scribe** > Uninstall.
This removes the program, the `Scribe` sign-in task and Scribe's
settings files in `%APPDATA%\Scribe`.

## Build from source

```
npm run install:all   # dependencies for the hub, server, server app and door
npm test              # node --check on the PC program, then every piece's tests
npm run stage:spoke   # stage the one Windows download for Inno Setup
```

The Windows installer is built by `.github/workflows/release.yml`
(Node.js runtime bundled, `scripts/stage-spoke.mjs`, Inno Setup compile of
the spoke installer, then SignPath signing once it is set up; it is not
active yet).

## PC paths (settings, no user names in source)

The Hands protocol (`spoke/hands-mcp/src/shared/protocol.mjs`) reads two
machine paths from the environment. Defaults come from the Windows profile,
so on a PC nothing needs setting:

| Setting | Default |
|---|---|
| `HANDS_ACTION_GRANT_PC_ROOT` (PC seat root for standing grants) | `%USERPROFILE%\pc-seat` |
| `HANDS_PROTOCOL_PATH` (the spoke's own protocol file) | `%LOCALAPPDATA%\Programs\Scribe\hands-mcp\src\shared\protocol.mjs` |

On a machine with neither variable (for example a Linux host), standing-grant
coverage fails closed and a person decides. Signed action hashes do not
depend on these paths.

## Owner name settings (no real names in source)

Source uses the neutral stand-in `sam` wherever a person's name used to be.
Two places act on a name at run time; set these on your own machine so your
own setup keeps working:

| Setting | Where | Default | What to set |
|---|---|---|---|
| `SCRIBE_OWNER_MAILBOX` | memory server (Courier) | `sam` | your Courier mailbox name, so letters already addressed to you keep arriving |
| `SCRIBE_OWNER_ALIASES` | memory server (Courier) | none (`owner` always works) | other names people use for you, comma-separated |
| `AGENT_OS_PERSONAL_NAMES` | Spoke (Agent OS template guard) | `sam` | real names that must never ship in templates, comma-separated |

Guard's auto-approver identity is already a setting (`AUTO_APPROVE_PRINCIPAL`,
default `auto-approve`), and approver identities come from
`EXEC_GUARD_APPROVER_TOKENS` (`name=token`, see
`guard/executive-guard/deploy/executive-guard.env.example`).

## Security settings

| Setting | Where | What it does |
|---|---|---|
| `AUTH_PASSPHRASE` | door, memory server | The passphrase typed on the consent screen to connect an AI |
| `APPROVALS_PASSPHRASE` | door (optional) | A **second** passphrase used only to sign in to `/approvals` and decide PC actions. Give AIs `AUTH_PASSPHRASE` only. Unset = the connect passphrase also signs in to approvals (the old behaviour) |
| `DOOR_SCRIBE_HANDS` | door (optional) | `1` makes the `scribe` flavour also front the PC hands (needs `HANDS_BACKEND_RESOURCE`). Default off = memory only |

Wrong passphrases are counted per source address (5 wrong tries lock that address for
15 minutes) on the door's consent and approvals pages and on the self-host server's
consent page. OAuth access and refresh tokens are stored only as SHA-256 hashes; a state
file written by an older version is migrated on first start without signing anyone out.

## Librarian and knowledge graph

The Librarian files every saved memory on a shelf with a fixed, explainable rulebook
(no AI involved). Shelves now include `people`, `places` and `organizations`. `explain_filing`
returns every rule that matched, `add_rule` accepts plain sentences such as
"Giltner goes in organizations", unknown shelf names need `confirm_new_category: true`,
and new rules re-file the unsorted tray.

The Librarian also has a knowledge graph attached. When a memory is filed, the
self-host server records named entities (people, agents, projects, products,
organizations, places, topics and values) and the proven links between them —
who wrote the memory, which shelf it went on, and names mentioned in the text —
with no model calls. The read-only `graph_neighbors` tool returns one entity
and its linked neighbours (relation, direction, and the source that proved the
link). Depth is one hop in v1. Tables and tool: `entities`, `links`,
`graph_neighbors`, migration `server/migrations/008_graph.sql`. The live
self-host Scribe memory MCP exposes this tool today. The hosted service at
scribemem.helmian.cloud files memories and offers `explain_filing`, but does
not yet expose `graph_neighbors` (the Personal and Team plans reserve it as an
entitlement). Details: [docs/LIBRARIAN-AUDIT-FIXES.md](docs/LIBRARIAN-AUDIT-FIXES.md).

## Continuous integration

`.github/workflows/ci.yml` installs every package and runs `npm test` on each push and pull request.

## Code signing

Not active yet: releases so far are unsigned. Signing through
[SignPath.io](https://about.signpath.io/) is planned; see
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

Business Source License 1.1. Copyright (c) 2026 DairyForge LLC. Bundled
Node.js is under its own license
(https://github.com/nodejs/node/blob/main/LICENSE).
