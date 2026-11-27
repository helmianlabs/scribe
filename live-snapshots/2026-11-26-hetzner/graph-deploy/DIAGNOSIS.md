# Graph Fix — Deploy-Proof Endpoint Failure: Diagnosis and Fix

Date: 2026-11-23. Sandbox only — nothing deployed. The deploy's rollback
stands; production is untouched by this note.

## What failed in production

The deploy proof (`proof-graphfix.mjs`, run by `deploy-graph-fix.sh` with
LABEL `helmian` / `scribe`) plants:

```
Graph fix deploy proof. The graph proof endpoint id is ep-gfproof-<label>-<6 hex chars>. GRAPHFIX_PROOF_PORT = '<port>'.
```

On both servers: plant saved PASS, search control PASS,
`graph_neighbors(GRAPHFIX_PROOF_PORT)` answered the port via `has_value`
PASS — and `graph_neighbors(<endpoint id>)` returned
`entity: null, neighbors: []` FAIL.

## Root cause (plain words)

The endpoint id was never extracted, so it never became an entity, so
there was nothing for `graph_neighbors` to find. `graph.ts` is innocent:
its name resolution and linking work whenever the entity exists (proven
by the control case below).

The extractor (`extract.ts`) only recognised an endpoint id in the one
shape the study fixture used — two letter segments plus an all-digit
tail, `ep-relay-77341`. The proof's generated id has **four** segments
and a **hexadecimal** tail (`ep-gfproof-helmian-a1b2c3`). It fell through
both nets:

- The labelled-statement pattern captured it ("The graph proof endpoint
  id is …") but its precision gate requires the value to match a known
  shape, be a labelled number, or be a person name — a hex-tailed id is
  none of those, so the proposal was dropped.
- The standalone shape pass has the same blind spot: its endpoint-id
  pattern demanded `-\d{2,}` as the third segment.

Whether the old code passed was luck: only an all-digit hex tail
(~6% of random hex strings, e.g. `…-482910`) matched, by matching the
last three segments. Both production runs drew letter-bearing hex and
failed. One side path was considered and set aside: production filing
runs extraction over the Librarian's ignore-filtered text, but an
ignore rulebook cannot target a novel token it has never seen, and the
label check passing on the same text shows extraction ran — the
sandbox reproduction below, with no filter involved, reproduces the
exact production signature.

## Reproduction (before the fix)

`repro-endpoint.ts` in this folder files the exact plant text through
`buildLinksForFiling` on a scratch PGlite database built like
`proof.ts`'s AFTER arm, varying only the random hex tail:

| Hex tail | Endpoint entity created | `graph_neighbors(id)` | Label check |
|---|---|---|---|
| `a1b2c3` | no — extractor proposed only `7319` | FAIL (entity null) | PASS |
| `12ab34` | no | FAIL | PASS |
| `abcdef` | no | FAIL | PASS |
| `482910` | yes (plus a fragment entity `gfproof-helmian-482910`) | PASS | PASS |

## The fix (extract.ts only — the proof was not touched)

1. **Endpoint-id shape widened** (`SHAPE_PATTERNS`, used by both the
   labelled-statement gate and the standalone pass): letter segments
   may repeat, and the final segment is alphanumeric with a digit that
   has at least one alphanumeric neighbour — so tails are ≥2 chars and
   digit-bearing (`a1b2c3`, `12ab34`, `482910`, and the original
   `77341`). Single-character tails still fail, so `eu-north-1` and
   `sars-cov-2` stay with their own patterns/prose, exactly as before.
   Because the pattern now matches from the token's left edge, the
   fragment entity the old pattern created (`gfproof-helmian-482910`)
   is gone too.
2. **Labelled-statement gate widened** for the one case a shape cannot
   cover: a compound id (3+ hyphen segments) whose tail is all hex
   letters (`ep-gfproof-helmian-abcdef`, ~0.3% of random hex). Here the
   label is the precision mechanism, the same logic the module already
   uses for labelled numbers. Prose compounds fail the tail test —
   `state-of-the-art`, `mother-in-law`: tails are neither digit-bearing
   nor hex.

## Evidence after the fix

- `repro-endpoint.ts`: all four hex variants now create the endpoint
  entity (kind `value`, label `graph proof endpoint id`, 4 neighbours)
  and **both** proof queries PASS on every variant.
- Original proof (`proof.ts`, AFTER arm): **20 of 20 answered**, graph
  size unchanged at 49 entities / 219 links / 15 aliases — the widened
  shape adds no noise on the fixture. (The rerun's BEFORE arm was
  pointed at this folder's pristine `graph-v1-baseline.ts`: the
  deploy-prep step had copied the v2 sources into
  `~/workspace/scribe-package/src/memory/`, which had silently turned
  proof.ts's "production v1" import into v2. Against the true baseline
  the before arm reads 0 of 20 again, 2 entities / 30 links, and
  `proof-results.json` has been regenerated on that basis.)
- `tsc --strict` on `extract.ts` + `graph.ts` + `match.ts` against the
  production package's compiler and `pg` types: clean.

## For the re-fire

Only `extract.ts` changed. The deploy script stages `extract.ts` from
this folder, so a re-fire picks the fix up with no script changes.
Migration 008 is already applied on both databases and stays.
