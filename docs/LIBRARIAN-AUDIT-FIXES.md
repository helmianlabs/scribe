# Forensic-audit fixes (2026-11-26)

What changed on branch `fix/forensic-audit-1126`, why, and what deploying it takes.
**Nothing here has been deployed or run against the live database or server.** Every behaviour
below is covered by tests that run against an in-memory Postgres (PGlite) or a local process.

## 1. Source of truth
`live-snapshots/2026-11-26-hetzner/` holds a faithful, read-only copy of the code that runs in
production but was not in the repo (door, both memory-server builds, graph deploy kit). Its README
records where each file came from and the byte-identical rebuild check. The knowledge graph
(`graph.ts`, `extract.ts`, `graph_neighbors`) and the door's live changes are then ported into the
real source tree (`server/src/librarian/`, `server/server.src/app/`, `door/`), keeping the repo's
own features (flags, door-knock, bearer check, mailbox-move guard) that the live fork lacks.
Graph migration is `server/migrations/008_graph.sql` (+ `.down.sql`): idempotent, a no-op where the
tables already exist, and it widens an older `kind` CHECK.

## 2. Learning is not blocked by unsorted look-alikes
`learn.ts`: a word only blocks a new learned rule if memories containing it are **filed elsewhere**
(a real conflict). Memories sitting in `unsorted` no longer count.

## 3. Repair path (code only)
* A filing that fails is retried (transient errors only, short backoff) and, if it still fails, is
  logged and returned as `filing_recorded: false` plus `filing_error`, never silently dropped.
  SaaS uses SAVEPOINTs so a failed filing cannot abort the save.
* `refileUnsorted()` re-files the unsorted tray (memories filed as unsorted or never filed) with the
  full rulebook: preset + the owner's custom and learned rules.
* `add_rule` re-files the tray automatically and reports `refiled_unsorted`.
* `server/scripts/backfill.ts` now uses the active rulebook plus custom and learned rules.
  Flags: `--dry` (default-safe preview), `--preset`, `--refile`. It is **not** run by CI or by this PR.

## 4. People, places, organizations
New shelves `people`, `places`, `organizations` with heuristic entity rules (title/verb/suffix cues,
case-insensitive). They are heuristics: teaching "Banyan is a customer" or `move_memory` overrides them.
Trucking/day-job words no longer outrank finance (new `content.finance-job` rule), and
"Giltner" files to `organizations`. Existing shelves are unchanged: entity rules are only in preset D
and tests pin the audit samples.

## 5. Rule trail
* `explain_filing` returns `matched_rules`: every rule that matched, in decision order, with the
  decided one marked, plus a one-line `trail_summary`.
* A `move_memory` refreshes the stored trail (a `manual.move` entry) so the explanation matches the shelf.
* Rule chaining: tags written by one *custom or learned* rule are visible to later rules, for at most
  `MAX_CHAIN_PASSES = 4` passes; each rule fires once and tags only grow, so loops cannot happen.
  Preset rules never see chained tags, so existing shelves cannot shift.

## 6. `add_rule`
* Ids are unique under concurrency (database sequence self-host; advisory lock per tenant in SaaS).
  Ids are unique, not consecutive.
* Unknown shelf names are refused with did-you-mean suggestions unless `confirm_new_category: true`
  (`for-<agent>` mailboxes and known shelves pass). Applies to `add_rule` and `move_memory`.
* Grammar also accepts "X goes in Y", "put X in Y", "file X under Y", and "X is a person/place/customer".

## 7. Security
| Fix | Where | Setting / note |
|---|---|---|
| Separate passphrase for approving PC actions | `door/src/approvals.mjs`, `config.mjs` | `APPROVALS_PASSPHRASE` (optional). Unset = old behaviour (the connect passphrase also signs in). The approvals session cookie is derived from whichever passphrase is in force. |
| Per-source lockout | door consent + approvals, `single.ts` consent | 5 wrong tries lock that source address for 15 min; the old door-wide counter let anyone lock the owner out. In memory (restart clears). Needs the proxy to pass the real address (`trust proxy` is already 1). |
| Empty `POST /consent` | `single.ts` | now 400 (verified 500 on the old code). |
| Hashed tokens | door `oauth.mjs`, self-host `oauth-provider.ts` | SHA-256 only, in memory and on disk. A version-1 state file is hashed on first load and rewritten as version 2, so nobody is signed out. The SaaS path already stored no raw tokens. Rolling back to the old code after migration signs clients out (they reconnect). |
| `npm audit fix` | app, door, hands-mcp | see "Left over" below |

Left over: `zod` (high; advisory GHSA-mrhx-c7xc-m3w5, memory use on oversized collections) in
`server/server.src/app` and `spoke/hands-mcp`. The only fix is the zod 4 major, which the MCP SDK
pins to 3.x here; not applied (breaking). `door` and `server` report 0. Spoke root has no lock file to audit.

## 8. Hygiene
`server/dist/librarian.mjs` rebuilt (it was stale: pre-graph/pre-trail); CI checks it stays fresh.
All versions unified to 1.1.0 (package.json x4 + lock files, MCP serverInfo strings). `license: BUSL-1.1`
added to the four package.json files that lacked it. README and PROD_STEPS refreshed.
`.github/workflows/ci.yml` runs the whole suite on push and PR. The guard browser extension keeps its
own 0.7.0 (a separate store-versioned artifact).

## Door: scribe flavour with hands
Production's `scribe` door also fronts the PC hands; the repo's `scribe` flavour was memory-only
(and tested as such). Parity is opt-in: `DOOR_SCRIBE_HANDS=1` (+ `HANDS_BACKEND_RESOURCE`). Default off.
**Deploying to production must set it, or the live door would lose the hands.**

## Proposal: narrower wording for Troy's live custom.3 / custom.6 (not applied)
The live rules were not touched. Live **custom.3** reads (memory #49210):
> anything mentioning chatgpt goes in for-chatgpt and tag it chatgpt

That files every memory that merely *talks about* ChatGPT into ChatGPT's mailbox. Proposed:
> anything mentioning "for chatgpt" goes in for-chatgpt and tag it chatgpt

Checked locally against this branch's engine: "We compared ChatGPT and Claude pricing for the Forge TMS
rollout" stays on its own shelf (old wording sent it to `for-chatgpt`); "Note for ChatGPT: please review
the draft" still files to `for-chatgpt`. Not tested against live data. **custom.6**: its text could not be
found during the audit, so no wording is proposed; send the sentence and it can be checked the same way.

## Deploying (needs Troy's yes; none of this was done)
1. Review and merge the PR (this is a merge, not just a commit: the branch carries the graph source to GitHub; merging puts it on `main`).
2. Back up (existing `server/ops/deploy-librarian.sh` already backs up, verifies a candidate on a side port, swaps, and auto-rolls back).
3. Database: the live databases already have the graph tables (per the deploy log in the snapshot), so `008_graph.sql` is a no-op there. **Not verified:** whether migrations 004 (flags) and 006 (courier), which this repo's server uses and the live fork lacks, are applied on the live databases. Check before deploying.
4. Build and deploy the memory server image(s) from `server/server.src/app` (both live memory servers: the `scribe` one and the `sslip` one). **Vocabulary:** the live builds ship a neutral vocabulary; this repo ships the owner's. Decide which first, or Giltner-style samples will file differently than today.
5. Door: rebuild `scribe-door` from `door/`, set `DOOR_SCRIBE_HANDS=1`, optionally set `APPROVALS_PASSPHRASE`. First start migrates the OAuth state file to hashed tokens.
6. Smoke test: save a memory, `explain_filing`, `graph_neighbors`, a wrong-passphrase lockout, an approvals login.
7. After deploy (optional, owner's call): `backfill.ts --dry`, then `--refile`, to re-file the unsorted tray.
