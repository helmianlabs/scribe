# Graph Fix — Proof

Bite: make the memory knowledge graph hold brand-new exact values from free
text. Sandbox only — no production deploys, no writes to the live memory
databases, no changes to the running memory servers. All code lives in this
folder (`~/workspace/helmian-room-build/graph-fix/`).

## Result

**Before: graph_neighbors answered 0 of 20 novel values. After: 20 of 20.**

Same fixture, same questions, same scoring the auto-save study used
(`graph_neighbors(entity ?? key)`, answered iff the response text contains
the probe's final answer), against two scratch databases built from the
production migration-007 schema.

## What was built

| File | What it is |
|---|---|
| `extract.ts` | **New module** (the production piece). Deterministic free-text extraction: proposes new entities + exact named values from a filed text, each with the pattern that found it (`via`) and, when the text named it, its label. |
| `graph.ts` | Copy of production `librarian/graph.ts` with the wiring: `EntityKind` gains `"value"`; `buildLinksForFiling` runs extraction after the v1 structured pass and wires each candidate exactly like a known-name mention (author/project `mentioned`, entity `filed_under` category), plus label `-has_value->` value when a label was found. Signature and result type unchanged. |
| `008_graph_value_kind.sql` | Draft migration for the deploy bite: widens the `entities.kind` CHECK with `'value'`. Applied to nothing but the scratch AFTER database (as a DDL delta). |
| `proof.ts` | The before/after harness. Rerunnable: `./node_modules/.bin/tsx proof.ts` (writes `proof-results.json`). |
| `proof-results.json` | Full raw results: per-probe answers and neighbour lists for both arms, all entities, and the per-step extraction audit. |
| `graph-v1-baseline.ts`, `match.ts` | Unmodified copies of the production files, kept for diffing. |

Extraction patterns, in order: constant assignments (`RETRY_BUDGET = '14'`,
`Set PORT … to 8490`, `Update HASH_ALGO … to 'argon2'`); "is named / is
called"; labelled statements ("The relay endpoint id is ep-relay-77341",
"The error budget is 0.35 percent"); standalone value-shaped tokens
(endpoint ids, license keys, feature flags, file paths, dates, versions,
region codes, channel names, ALL-CAPS codenames, archive-table names);
person names. Precision rule: a bare number is never extracted unless a
label names it.

Type check: `extract.ts` + `graph.ts` + `match.ts` pass `tsc --strict`
against the production package's own compiler and `pg` types — clean.

## Design note — where this differs from GRAPH-DESIGN.md

GRAPH-DESIGN.md sketches v2 extraction as **a model pass whose proposals
are reviewable before they become links**. This bite implements the
brief's version instead: extraction **at filing time**, links written
directly under the graph's existing fail-soft, source-stamped rules, and
**no model call** — the constraint the rest of the Librarian runs under
(graph.ts's own header: "no model calls, nothing read into the text beyond
a dictionary lookup"). The trade is explicit: deterministic patterns are
auditable and free, but they only catch value-shaped and label-bound
facts; a model pass would catch more and invent more. The review queue
and the model pass from the design remain future work, as do embeddings,
deeper walks, and conflict/supersede handling (unchanged from the design).

## Method

- Scratch databases: **PGlite** (real Postgres compiled to WASM,
  in-process; the database exists only inside the proof process). The
  production graph SQL runs unmodified. (pg-mem was tried first and
  cannot parse `IS NOT DISTINCT FROM`, which `recordLink` uses — that
  dead end is recorded so nobody repeats it.)
- Both databases got the migration-007 graph tables; the AFTER database
  additionally got the 008 delta (`'value'` in the kind CHECK). Both got
  **empty** `agent_directory` and `projects` tables, so the v1 known-name
  dictionary is empty and every probe value is genuinely unknown — the
  condition the study audited.
- The fixture's 30 work-step texts (`autosave-test/fixture.mjs`, the
  study's own fixture) were filed one by one through
  `KnowledgeGraph.buildLinksForFiling` — BEFORE with the production
  `graph.ts`, AFTER with this folder's `graph.ts` — author
  `autosave-test`, project `relay-config-service`, category
  `autosave-test`.
- Graph size: BEFORE 2 entities / 30 links / 0 aliases (author + project
  anchors only). AFTER 49 entities / 219 links / 15 aliases.

## Before / after, per probe

| Probe | Query | Answer | Before | After |
|---|---|---|---|---|
| P1 staging port (changed 8471→8490) | `8490` | 8490 | miss | **answer** (label `PORT`) |
| P2 relay endpoint id | `ep-relay-77341` | ep-relay-77341 | miss | **answer** |
| P3 quux relay config path | `quux-relay` | src/quux-relay.config.mjs | miss | **answer** (alias) |
| P4 retry budget | `RETRY_BUDGET` | 14 | miss | **answer** (`has_value` → 14) |
| P5 hashing (changed bcrypt→argon2) | `argon2` | argon2 | miss | **answer** (label `HASH_ALGO`) |
| P6 deploy owner | `Maren Kjellberg` | Maren Kjellberg | miss | **answer** (person) |
| P7 code freeze date | `2027-03-14` | 2027-03-14 | miss | **answer** |
| P8 upstream timeout | `2750` | 2750 | miss | **answer** |
| P9 dead-letter queue | `relay-dlq-west` | relay-dlq-west | miss | **answer** |
| P10 region | `eu-north-1` | eu-north-1 | miss | **answer** |
| P11 max payload | `65521` | 65521 | miss | **answer** |
| P12 feature flag | `flag_ember_lantern` | flag_ember_lantern | miss | **answer** |
| P13 webhook path | `tessellate` | /hooks/v2/tessellate | miss | **answer** (alias) |
| P14 archive table | `relay_events_archive_7` | relay_events_archive_7 | miss | **answer** |
| P15 node pin | `22.11.0` | 22.11.0 | miss | **answer** |
| P16 Slack channel | `relay-incidents-9` | #relay-incidents-9 | miss | **answer** |
| P17 error budget | `0.35` | 0.35 | miss | **answer** |
| P18 release codename | `UMBER FOX` | UMBER FOX | miss | **answer** |
| P19 backup window | `03:40` | 03:40 | miss | **answer** |
| P20 license prefix | `RLY-9920-XK` | RLY-9920-XK | miss | **answer** |

## Extraction quality, honestly

**Correct.** All 20 probe values, with their labels where the text gave
one (17 constant-name labels became topic entities, e.g. `PORT`,
`HASH_ALGO`, `RETRY_BUDGET`; prose labels for the rest). Also correctly
extracted, beyond the probes: the module and seed-log file paths the
texts name (`src/relay.mjs`, `data/seed-log-1.txt`, …) and the person
`Maren Kjellberg` typed as `person`, not `value`.

**Missed.** Nothing among the 20 probes in the final run. By design, the
extractor still misses: values referred to but not restated ("Set
ENDPOINT_ID to that value" — the value lives in the previous sentence);
unlabelled bare numbers and plain lowercase words with no value shape;
anything whose shape is not in the pattern list. Cross-sentence label
binding is the biggest known gap.

**Wrong / noise.**
- `src/config.mjs` becomes an entity because nearly every step names it.
  It is a real referent, but low-value; production should run extraction
  over the Librarian rulebook's ignore-filtered text (`applyIgnore`)
  the way classification already does. Not wired in this bite.
- Superseded values stay: `8471` and `bcrypt` are entities alongside
  `8490` and `argon2`. That is append-only truth — both were correct
  when filed, and every link carries its source message id — but the
  graph has no "current value" marker. Conflict handling is design-v2
  future work, unchanged by this bite.
- One label per value: the first label found wins (constant names beat
  prose labels), so e.g. `2750` is labelled `TIMEOUT_MS`, not
  "upstream timeout".
- Two fragment extractions were caught and fixed during the bite:
  `/v2/tessellate` (path pattern matching mid-path) and `03` (decimal
  pattern splitting `03:40`). An intermediate run scored 16/20; the
  four misses traced to one bug — the "Set X … to Y" gap pattern
  excluded dots and died on "src/config.mjs" — plus the missing
  "Update" verb. All fixed; final run is the 20/20 above.

## What remains unproven

- The full `Librarian.fileSaved` path (filing record + `linkFiled`)
  was not exercised end-to-end; the proof calls
  `KnowledgeGraph.buildLinksForFiling` directly, which is the exact
  method `linkFiled` calls with the same arguments.
- The MCP `graph_neighbors` tool layer was not exercised; it wraps
  `KnowledgeGraph.neighbors`, which is what the proof queries.
- No real Neon database was touched: PGlite is genuine Postgres and
  runs the production SQL unmodified, but Neon-specific behaviour
  (roles, sequences under the real `memory_rw` grants, concurrency
  races on upsert) is untested.
- Extraction quality on real memory text (long, messy, multi-topic
  messages) is untested — the fixture is short, well-formed task
  traffic. Expect more noise and more misses there; the `via` field
  on every proposal exists so a backfill run can be audited before
  anyone trusts it.

## What a production deploy would touch

1. **Files** (one codebase, `~/workspace/scribe-package/src/memory/`):
   - add `src/librarian/extract.ts` (new, from this folder);
   - replace `src/librarian/graph.ts` with this folder's `graph.ts`.
   - No changes to `librarian-tools.ts`, `mcp-server.ts`, or
     `librarian/index.ts` (`extract.ts` is imported by `graph.ts`
     directly; `buildLinksForFiling` keeps its signature).
2. **Migration**: `008_graph_value_kind.sql` on **both** databases —
   Scribe memory (its own post-split DB) and Helmian memory (Launch
   `dairyforge` project) — run as the table owner, after confirming the
   CHECK constraint's actual name on each (`entities_kind_check` as
   007 writes it). **Order matters**: without 008, `'value'` upserts
   fail the CHECK, and because graph writes are fail-soft the failure
   is silent — filing keeps working and extraction quietly does
   nothing. Migration first, verified, then the code.
3. **Both deployments rebuilt and restarted** from the updated codebase:
   Helmian memory (`claude-memory-mcp`, port 8080) and Scribe memory
   (`claude-memory-mcp-scribe`, port 8081) on the Hetzner box. The
   owner courier needs no change (it carries messages; each side's
   Librarian files and extracts its own copies, as today).
4. **No new grants**: `memory_rw` already holds INSERT + SELECT on
   `entities`, `entity_aliases`, `links` from migration 007;
   extraction writes through the same methods.
5. **Backfill is separate**: existing memories gain no extracted
   entities until something refiles them. A backfill pass running
   `buildLinksForFiling` over stored messages (the pattern used for
   the 2026-11-23 graph backfills) is its own bite, and should be
   audited on a sample first using the `via` records.
6. **Recommended with the deploy**: feed extraction the
   ignore-filtered text (`applyIgnore` output) to keep infrastructure
   file names out of the graph — a two-line change in the wiring,
   deliberately left for the deploy bite so this bite's proof matches
   the code as tested.
