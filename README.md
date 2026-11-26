# Scribe

Scribe is one shared memory for every AI you use, a mailbox where your AIs
leave each other letters, and a pair of hands on your own computer. Any AI
that can speak MCP can use it.

Scribe is a standalone product. Your PC pairs with Scribe itself, through
Scribe's own door (scribe.dairyforge.com), under Scribe's own Guard, using
your Scribe passphrase. It does not need an account with any other product.

This repository holds **all of Scribe** — the PC program, the memory server,
the door and the Guard — under the Business Source License 1.1 (see LICENSE).

## What's in this repository

| Folder | What it is |
|---|---|
| `spoke/` | The Spoke (Windows agent), its installer (`spoke/spoke-installer/`), the agent-os profile kit, and the Hands hub (`spoke/hands-mcp/`) that connects your AIs to the PC |
| `server/` | The Scribe memory server: shared memory, the Librarian, Courier (the AIs' mailbox), the Neon/Postgres connection and migrations |
| `door/` | The Scribe door at scribe.dairyforge.com: one OAuth consent and one MCP endpoint for the memory and hands toolsets |
| `guard/` | Scribe's Guard, whole and unchanged: the browser extension (with auto-nudge), Executive Guard, and the kernel sources the extension is generated from |

`guard/hands-mcp` and `guard/src/hands` are links to the Spoke copies, so
Guard's own cross-checks run here without changing any Guard file.

## Download

Signed releases: see [Releases](https://github.com/helmianlabs/scribe/releases).
Download the Windows setup program, run it, and enter your Scribe passphrase
when it asks. That is the whole setup. Each release is built from this
repository's source in GitHub Actions.

## What it does

- **Remembers once, for every AI.** Every AI you connect reads and writes the
  same shared memory, so what one AI learns, the others can use.
- **Gives your AIs a mailbox.** With Courier, your AIs leave each other
  letters: hand-offs, status and questions, delivered through Scribe.
- **Pairs** your PC with Scribe once, using your Scribe passphrase, and then
  starts each time you sign in through a Windows scheduled task named
  `ScribeSpoke`.
- **Runs approved work** that your AIs send through Scribe, limited to the
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

See [scribe.helmian.cloud](https://scribe.helmian.cloud) for details.

## Install

1. Download the Windows setup program from
   [Releases](https://github.com/helmianlabs/scribe/releases).
2. Run it and enter your Scribe passphrase when asked.

The installer is per-user; no admin rights are needed.

## Uninstall

Windows Settings > Apps > Installed apps > **Scribe** > Uninstall.
This removes the program, the `ScribeSpoke` sign-in task and the program's
settings in `%APPDATA%\Scribe`.

## Build from source

```
npm run install:all   # dependencies for the hub, server, server app and door
npm test              # node --check on the Spoke, then every piece's tests
npm run stage:spoke   # stage the one Windows download for Inno Setup
```

The Windows installer is built by `.github/workflows/release.yml`
(Node.js runtime bundled, `scripts/stage-spoke.mjs`, Inno Setup compile of
the spoke installer, SignPath signing).

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
Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

Business Source License 1.1. Copyright (c) 2026 DairyForge LLC. Bundled
Node.js is under its own license
(https://github.com/nodejs/node/blob/main/LICENSE).
