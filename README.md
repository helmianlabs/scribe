# Scribe

Scribe is a small program that runs on your Windows PC
and lets the agents you add in [Helmian](https://helmian.cloud) do work on that
PC, such as building and previewing projects, only inside the folders you allow.
It pairs once with a short code and then starts each time you sign in.

This repository holds **all of Scribe**, one program and one download, under the
Business Source License 1.1. The Helmian cloud app is a separate product and is not part of
this repository.

## What's in this repository

| Folder | What it is | Came from (history kept) |
|---|---|---|
| `spoke/` | The Spoke (Windows agent), its installer (`spoke/spoke-installer/`), the agent-os profile kit, and the Hands hub (`spoke/hands-mcp/`) that connects your AIs to the PC and to each AI's Hetzner box | helmianlabs/helmian |
| `server/` | The Scribe memory server: shared memory, the Librarian, Courier, the Neon/Postgres connection and migrations | shared-memory-mcp |
| `door/` | The Scribe door: one OAuth consent and one MCP endpoint for the memory and hands toolsets | helmianlabs/helmian |
| `guard/` | Guard, whole and unchanged: the browser extension (with auto-nudge), Executive Guard, and the kernel sources the extension is generated from | helmianlabs/helmian |

`guard/hands-mcp` and `guard/src/hands` are links to the Spoke copies, so
Guard's own cross-checks run here without changing any Guard file.

## Download

Signed releases: see [Releases](https://github.com/helmianlabs/Scribe/releases).
Each release is built from this repository's source in GitHub Actions.

## What it does

- **Pairs** your PC with your Helmian account using a one-time code from
  helmian.cloud (Settings > "Set up this PC"). The code is used during setup
  and is not stored.
- **Runs approved work** that your Helmian agents send, limited to the folders
  you chose (by default your user folder). Root-level actions need a signed
  grant from you.
- **Opens your own AI app sign-ins** (for example the ChatGPT, Claude, Grok or
  Gemini command-line tools) on your PC when you ask, so you can use the plan
  you already pay for. The spoke never sees those passwords.
- **Starts at sign-in** through a Windows scheduled task named `HelmianSpoke`.

## Install

1. Download `Helmian-Spoke-Setup-<version>-win-x64.exe` from Releases.
2. Run it and paste the pairing code from helmian.cloud when asked.

The installer is per-user (no admin rights) and installs to
`%LOCALAPPDATA%\Programs\HelmianSpoke`.

## Uninstall

Windows Settings > Apps > Installed apps > **Helmian Spoke** > Uninstall.
This removes the program, the `HelmianSpoke` sign-in task and the spoke's
settings in `%APPDATA%\Helmian`.

## Build from source

```
npm run install:all   # dependencies for the hub, server, server app and door
npm test              # node --check on the Spoke, then every piece's tests
npm run stage:spoke   # stage the one Windows download for Inno Setup
```

The Windows installer is built by `.github/workflows/release.yml`
(Node.js runtime bundled, `scripts/stage-spoke.mjs`, Inno Setup compile of
`spoke/spoke-installer/HelmianSpoke.iss`, SignPath signing).

## PC paths (settings, no user names in source)

The Hands protocol (`spoke/hands-mcp/src/shared/protocol.mjs`) reads two
machine paths from the environment. Defaults come from the Windows profile,
so on a PC nothing needs setting:

| Setting | Default |
|---|---|
| `HANDS_ACTION_GRANT_PC_ROOT` (PC seat root for standing grants) | `%USERPROFILE%\pc-seat` |
| `HANDS_PROTOCOL_PATH` (the spoke's own protocol file) | `%LOCALAPPDATA%\Programs\Helmian\hands-mcp\src\shared\protocol.mjs` |

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

## Code signing policy

See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

Business Source License 1.1. Copyright (c) 2026 DairyForge LLC. Bundled Node.js is under its own
MIT-style license (https://github.com/nodejs/node/blob/main/LICENSE).
