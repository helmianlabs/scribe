# Graph Fix — Production Deploy Runbook (firing bite)

The fix: free-text extraction for the Librarian knowledge graph (novel exact
values become entities of kind `'value'`). Proven in the sandbox — see
PROOF.md in this folder (0/20 → 20/20 novel values answered by
graph_neighbors). This runbook fires it in production. Everything below was
prepared and verified read-only in the prep bite; the deploy script
(`deploy-graph-fix.sh`, this folder) implements steps 3–8 and was
syntax-checked but **not executed**.

## The gate — read first

**Do not fire while the context auto-save study's full test is still
running** against the Scribe-side test store
(`~/workspace/helmian-room-build/autosave-test/`). A memory-server restart
or a filing-behaviour change mid-test contaminates its three-arm
comparison. At prep time (2026-11-23 ~14:57 MT) RESULTS.md did not exist
there — the test was still running. The firing bite starts only when:

1. `~/workspace/helmian-room-build/autosave-test/RESULTS.md` exists, and
2. the study verdict has been checked by Main and delivered to Troy.

The script enforces a token of this: it refuses to run unless invoked as
`AUTOSAVE_TEST_DONE=1 bash deploy-graph-fix.sh fire` (refusal verified in
prep). The env var is set by the firing bite, on the record, after the two
conditions above are confirmed — never by habit.

## What ships

Three files into the one memory codebase
(`~/workspace/scribe-package/src/memory/`), plus one migration on both
databases:

| File | Change |
|---|---|
| `src/librarian/extract.ts` | NEW — deterministic free-text extraction (from this folder, unchanged from the proof) |
| `src/librarian/graph.ts` | REPLACED by this folder's `graph.ts` — the proof's wiring, plus the deploy-bite addition of `FiledItem.extractText` (see below) |
| `src/librarian-tools.ts` | REPLACED by this folder's `librarian-tools.ts` — production file with exactly one change: `linkFiled` computes the ignore-filtered text and passes it as `extractText` (diff verified in prep: import line + 9 lines, nothing else) |
| `src/migrations/008_graph_value_kind.sql` | Copied into the production migrations folder for the record; applied to both databases by the script |

**The ignore-filter wiring (PROOF.md recommendation 6), as prepared:**
`linkFiled` runs `applyIgnore(stripTagLine(item.text), rulebook)` — the
same filtered text classification matched on — and passes it to
`buildLinksForFiling` as `extractText`. Extraction reads
`extractText ?? text`; the v1 structured pass keeps the full text,
unchanged. Effect: infrastructure names the rulebook ignores (the proof's
example: `src/config.mjs`, named in nearly every step) no longer become
entities. The whole assembled tree (production source + these three files)
passes `tsc --noEmit` clean against the production tsconfig — verified in
prep in a scratch copy; the production source tree itself was not touched.

## Runbook

Steps 1–2 are the firing bite's hands; steps 3–8 are the script.

1. **Confirm the gate** (above). RESULTS.md present, verdict delivered.
2. **Copy this folder to the box** as `/opt/graph-fix-deploy` (the script's
   fixed path), e.g. from the workstation:
   `scp -r ~/workspace/helmian-room-build/graph-fix root@5.78.222.178:/opt/graph-fix-deploy`
   (SSH key `~/.ssh/hetzner-runner`, `-o UserKnownHostsFile=/home/hatch/.ssh/known_hosts`).
   Also land the three source files + 008 into the workspace source tree
   (`~/workspace/scribe-package/src/memory/` and `.../src/migrations/`) so
   the canonical source matches what ships; re-run `tsc --noEmit` there.
3. **Stage** (script step 1): the script copies the box's current Helmian
   app tree (`/opt/claude-memory-mcp/app`) and the Scribe build tree
   (`/opt/scribe-build/graph-src`) into a stamped staging dir and overlays
   the three files. Production trees are not touched by staging.
4. **Migration check, both databases** (script step 2, read-only):
   `migrate-008.mjs` in a one-off container from each side's *current*
   image (the box has no psql; the images bundle node + pg). It prints the
   kind constraint's name and definition and the count of `'value'`
   entities, and aborts if the constraint is not named
   `entities_kind_check`. Expected output on both sides (confirmed in
   prep): the seven-kind CHECK, 008 not applied, 0 value entities.
   - Helmian memory DB: Neon **Launch** project `dairyforge`, database
     `claude_memory` (endpoint <NEON_ENDPOINT>). Owner connection:
     variable `LAUNCH_DAIRYFORGE_URL` in `/root/neon-migration.env`
     (mode 600, on the box; the value is read in-process by the migration
     helper and never printed).
   - Scribe memory DB: Neon **Free** project `dairyforge`, database
     `claude_memory` (endpoint ep-steep-glitter-aku22c6c). Owner
     connection: variable `FREE_DAIRYFORGE_URL` in the same file, **with
     the database name overridden to `claude_memory`** — the variable as
     stored names database `neondb` on the right endpoint, and pointing it
     at `neondb` finds no `entities` table (proven in prep). The helper's
     optional last argument performs the override.
5. **Migration 008 apply, both databases, as owner** (script step 3) —
   before any new code goes live. Without 008, `'value'` upserts fail the
   CHECK and, because graph writes are fail-soft, extraction would
   silently do nothing while filing keeps working. The helper re-reads the
   constraint after applying and aborts unless `'value'` is in it. The
   apply is guarded: a database that already admits `'value'` is skipped.
6. **Helmian memory leg** (script step 4):
   `LABEL=graphv2 bash /opt/claude-memory-mcp/deploy-librarian.sh <staged tree>`
   — the established pattern: app-dir backup, running image tagged
   `claude-memory-mcp:pregraphv2-<stamp>`, new image built, candidate
   verified on 127.0.0.1:18081 (health + verify-librarian.mjs + public
   401 check), production swapped on 127.0.0.1:8080, auto-rollback on any
   failure, and `rollback-graphv2.sh` written for later use.
7. **Scribe memory leg** (script step 5): no deploy script existed for
   this container (see preflight), so the script performs the same
   discipline explicitly: build tree backed up to
   `/opt/backups/scribe-memory-<stamp>-pregraphv2`, running image tagged
   `scribe:pregraphv2-<stamp>`, new image `scribe:graphv2-<stamp>` built
   from the staged tree, candidate on 127.0.0.1:18082 verified (health +
   anonymous /mcp must answer 401), production swapped with the exact
   run shape the container has today (`--restart unless-stopped`,
   `--env-file /opt/claude-memory-mcp/app-scribe.env`,
   `-p 127.0.0.1:8081:8080`, `-v /opt/claude-memory-mcp/data-scribe:/data`),
   auto-rollback on failure, and `rollback-scribe-graphv2.sh` written in
   the same shape as `rollback-graph.sh`.
8. **Proof** (script step 6) — the pass bar, both sides, through each
   server's own OAuth door machinery (`proof-graphfix.mjs`, modelled on
   verify-librarian.mjs, passphrase read in-process from the side's env
   file, never printed):
   - Plant, per side, one save under the namespaced source
     `graph-fix-proof` carrying a unique novel endpoint id
     (`ep-gfproof-<side>-<random>`) and a labelled constant
     (`GRAPHFIX_PROOF_PORT = '<port>'`, 7319 Helmian / 7321 Scribe).
   - Control: `search_memory` must find the plant (proves the save landed,
     so a graph miss would be the graph's, not the save's).
   - **Pass bar: `graph_neighbors` for the planted endpoint id answers the
     value, AND `graph_neighbors` for `GRAPHFIX_PROOF_PORT` answers the
     port through the label's `has_value` link — on BOTH sides.** Any one
     of the four checks failing = the deploy is not proven; roll back the
     failing side's code (step 9) and report.
   - Note: the owner courier carries each plant to the other side within
     ~a minute, where that side's Librarian files and extracts its own
     copy. Expected, not contamination — each side is queried for its own
     unique value.

## Rollback

- **During the deploy**: automatic on any failed check, both legs (the
  Helmian leg by deploy-librarian.sh, the Scribe leg by the script's
  rollback function).
- **After the deploy, code rollback only**:
  `bash /opt/claude-memory-mcp/rollback-graphv2.sh` (Helmian) and
  `bash /opt/claude-memory-mcp/rollback-scribe-graphv2.sh` (Scribe).
- **Schema**: migration 008 is NOT rolled back with the code. The widened
  CHECK is harmless to the old code (it never writes `'value'`). Reverse
  it only while a check shows zero `'value'` entities on that database —
  once extraction has written value entities, the reverse ALTER fails by
  design, and code rollback is the only rollback (per the migration
  file's own header).

## Cautions for the firing bite

- **OAuth /register budget**: every verify/proof run registers a fresh
  client, and the door rate-limits /register at 20/hour per source
  address (the auto-save study's bite-2 lesson). This deploy uses roughly
  six registrations. If the hour's budget is already spent, a verify can
  fail on registration — wait for the window, do not retry-loop.
- **Re-approvals**: after a memory-server restart, connected AIs may ask
  Troy to approve again (one click + passphrase) — noted in the box's own
  PROD_STEPS.md. Time the firing bite so that lands calmly.
- **Backfill is not in this deploy**: existing memories gain no extracted
  entities until refiled. A backfill pass is its own later bite, audited
  on a sample first via the extractor's `via` records (PROOF.md).
- **Extraction quality on real text is unproven** (PROOF.md): the fixture
  was short, well-formed task traffic. Expect more noise and more misses
  on real memory text; superseded values stay as entities alongside their
  replacements (append-only truth, no "current value" marker — design-v2
  future work).

## Preflight — what prep verified read-only (2026-11-23 ~14:50–15:05 MT)

Verified, with evidence:

- **Running servers**: `claude-memory-mcp` on image
  `claude-memory-mcp:graph-20261123-194735`, 127.0.0.1:8080, up ~2 hours;
  `claude-memory-mcp-scribe` on image `scribe:graph-20261123`,
  127.0.0.1:8081, up ~13 hours. Both `--restart unless-stopped`; Scribe's
  mounts/ports/env keys match its recorded run shape (data-scribe → /data,
  env keys exactly the app-scribe.env set).
- **The graph code is identical everywhere it should be**: sha256
  `7584e845a04c4ead…` for `graph.ts` in all four places — the proof's v1
  baseline, the production source tree
  (`~/workspace/scribe-package/src/memory/src/librarian/graph.ts`), the
  box's Helmian app tree, and the box's Scribe build tree. `match.ts`
  likewise matches production. `extract.ts` exists in none of the
  production trees (not deployed — correct).
- **Deploy machinery**: `/opt/claude-memory-mcp/deploy-librarian.sh`
  present and read end to end (backup → tag → build → candidate on
  :18081 → verify → swap → auto-rollback → writes `rollback-<label>.sh`).
  `rollback-graph.sh` from the 2026-11-23 graph deploy present; its
  rollback image `claude-memory-mcp:pregraph-20261123-194735` still
  exists.
- **Both databases, read-only through the owner connections** (one-off
  containers, SELECT only): constraint `entities_kind_check` present on
  both, definition is exactly the seven kinds from migration 007, 008 not
  applied, zero `'value'` entities. PROOF.md's open item — "confirm the
  constraint's actual name on each" — is now closed for both.
- **Owner sources named** (values never read or printed in prep):
  `/root/neon-migration.env` (mode 600) holds `LAUNCH_DAIRYFORGE_URL`
  (Helmian memory DB) and `FREE_DAIRYFORGE_URL` (Scribe memory DB, needs
  the `claude_memory` database-name override — see step 4).
- **Assembled code type-checks**: production tree + the three prepared
  files → `tsc --noEmit` clean (scratch copy; production tree untouched).
- **The gate condition at prep time**: the auto-save study's RESULTS.md
  does not yet exist — the deploy correctly waits.

Does not match PROOF.md's assumptions, named plainly:

1. **There is no deploy script for the Scribe memory container.**
   PROOF.md says "both deployments rebuilt and restarted" in the pattern
   of the earlier graph deploy, but `deploy-librarian.sh` covers only the
   Helmian container; the Scribe image (`scribe:graph-20261123`, built
   from `/opt/scribe-build/graph-src`) was plainly built and run by hand.
   The runbook's step 7 and the script's Scribe leg supply the missing
   pattern explicitly, mirroring the Helmian discipline.
2. **No pre-tagged rollback image exists for the Scribe server's current
   build** (only `scribe-courier:rename-20261121`, an older build). The
   script tags the running image as `scribe:pregraphv2-<stamp>` before
   swapping, so the rollback exists by the time it could be needed.
3. **`verify-librarian.mjs` cannot verify the Scribe leg** — it reads the
   passphrase and PUBLIC_URL from `app.env` (Helmian side) by hardcoded
   path. The Scribe candidate is therefore verified by health + the
   anonymous-401 check, and the side's real proof is step 8's
   parameterised proof script.
4. **The Scribe owner string does not point at the memory database as
   stored** — `FREE_DAIRYFORGE_URL` names database `neondb` (right
   endpoint, wrong database; the graph tables are in `claude_memory`).
   `/root/scribe-free-db.env` is not the owner source either: it holds
   the app-role `DATABASE_URL` / `DATABASE_WRITE_URL` pair. The working
   owner road, proven read-only in prep, is `FREE_DAIRYFORGE_URL` with
   the database overridden to `claude_memory` (the helper's override
   argument).
5. **No psql on the box** — migration work rides one-off containers from
   the servers' own images, as the prep checks did.
