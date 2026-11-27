# Scribe

Scribe is one shared memory for every AI you use, a mailbox where your AIs
leave each other letters, and a pair of hands on your own computer. Any AI
that can speak MCP can use it.

Your AIs connect to Scribe's memory and mailbox through Scribe's own door
(`https://scribe.dairyforge.com/mcp`), and the owner approves each
connection with the Scribe passphrase.

The PC program is **Scribe**: the Windows installer is
named Scribe and pairs your PC through the Scribe hands hub,
using your Scribe passphrase or a 10-minute pairing code.

This repository holds **all of Scribe** — the PC program, the memory server,
the door and the Guard — under the Business Source License 1.1 (see LICENSE).

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

- **Free** — $0: 3 AIs, 1,000 memories
- **Solo** — $5/month or $50/year
- **Team** — $12 per person/month
- **Self-Hosted** — custom

Checkout is not open yet; these plans apply when public sign-up launches.
See [scribe.dairyforge.com](https://scribe.dairyforge.com) for details.

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
and new rules re-file the unsorted tray. The self-host server also builds a small knowledge
graph (`entities`, `links`; tool `graph_neighbors`; migration `server/migrations/008_graph.sql`).
Details: [docs/LIBRARIAN-AUDIT-FIXES.md](docs/LIBRARIAN-AUDIT-FIXES.md).

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
