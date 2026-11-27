/**
 * Free-text extraction for the knowledge graph (graph v2, filing-time piece).
 *
 * V1 (graph.ts) links only names the memory already knows — agents in the
 * directory, projects on file — plus the filing's structured facts. A brand-new
 * exact value in the text (a port number, an endpoint id, a codename, a file
 * path) was stored in the message and findable by search, but the graph could
 * never answer for it, because nothing ever became an entity.
 *
 * This module is the missing piece: a deterministic pass over the filed text
 * that proposes NEW entities and the label that names them, so the graph
 * builder can write them as entities with links, alongside the structured
 * extraction. It runs at filing time, in the same process, with no model call
 * and no external API — the same constraints the rest of the Librarian runs
 * under (see graph.ts header). GRAPH-DESIGN.md sketched v2 extraction as a
 * model pass with reviewable proposals; this implementation is deliberately
 * narrower — high-precision patterns only, everything it extracts carries the
 * pattern that found it (`via`) so quality can be audited — and it writes
 * links directly under the graph's existing fail-soft, source-stamped rules
 * rather than through a review queue. That deviation is recorded in
 * graph-fix/PROOF.md.
 *
 * What it extracts, in order:
 *   1. Constant assignments: `RETRY_BUDGET = '14'`, `Set PORT ... to 8490`,
 *      `Set HASH_ALGO ... to 'argon2'`. The constant is the label, the
 *      assigned value is the value.
 *   2. Named things: `... is named relay-dlq-west`, `... is called X`.
 *   3. Labelled statements: `The relay endpoint id is ep-relay-77341`,
 *      `The backup window is 03:40 UTC`. The noun phrase is the label.
 *   4. Standalone value-shaped tokens anywhere in the text: endpoint ids,
 *      license keys, feature flags, file paths, dates, versions, region
 *      codes, channel names, ALL-CAPS codenames, archive-table names.
 *   5. Person names (two capitalised words) not already covered.
 *
 * Precision rules: bare numbers are NEVER extracted on their own — a number
 * becomes an entity only when a label names it (patterns 1–3), because an
 * unlabelled number in free text is noise, not a fact. Every candidate is
 * validated against a value shape before it is proposed.
 */

export type ExtractedKind = "person" | "value";

export interface ExtractedEntity {
  /** The exact value / name, as written. Becomes the entity's display name. */
  name: string;
  kind: ExtractedKind;
  /** The label that names this value in the text (a constant name or noun
   *  phrase), when one was found. The graph links label -has_value-> value. */
  label?: string;
  /** Extra surface names to register as aliases (file basenames, path tails). */
  aliases: string[];
  /** The pattern that found it — recorded so extraction quality is auditable. */
  via: string;
}

const PERSON_SHAPE = /^[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})+$/;

/** Shapes a standalone token must match to be proposed without a label. */
const SHAPE_PATTERNS: { re: RegExp; via: string }[] = [
  { re: /\b[a-z]{2,}-[a-z]{2,}(?:-[a-z]+)*-(?:[a-z0-9]\d|\d[a-z0-9])[a-z0-9]*\b/g, via: "shape:endpoint-id" }, // ep-relay-77341, ep-gfproof-helmian-a1b2c3
  { re: /\b[A-Z]{2,4}-\d{3,}-[A-Z0-9]{2,}\b/g, via: "shape:license-key" },     // RLY-9920-XK
  { re: /\bflag_[a-z0-9_]+\b/g, via: "shape:feature-flag" },                  // flag_ember_lantern
  { re: /\b[a-z]+(?:_[a-z]+)+_\d+\b/g, via: "shape:table-name" },             // relay_events_archive_7
  { re: /\b[a-z]+-dlq-[a-z]+\b/g, via: "shape:queue-name" },                  // relay-dlq-west
  { re: /\b\d{4}-\d{2}-\d{2}\b/g, via: "shape:date" },                        // 2027-03-14
  { re: /\b\d+\.\d+\.\d+\b/g, via: "shape:version" },                         // 22.11.0
  { re: /\b[a-z]{2}-[a-z]+-\d\b/g, via: "shape:region" },                     // eu-north-1
  { re: /#[a-z][a-z0-9-]*-\d+\b/g, via: "shape:channel" },                    // #relay-incidents-9
  { re: /(?<![\w/.-])\/[a-z][a-z0-9]*(?:\/v\d+)?\/[a-z0-9][a-z0-9-]*\b/g, via: "shape:path" }, // /hooks/v2/tessellate
  { re: /\b(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,4}\b/g, via: "shape:file-path" },   // src/quux-relay.config.mjs
  { re: /\b[A-Z]{2,}(?:\s[A-Z]{2,})+\b/g, via: "shape:codename" },            // UMBER FOX
];

/** Words that look value-shaped in prose but are never facts worth a node. */
const STOPVALUES = new Set([
  "utc", "the", "and", "not", "yes", "true", "false", "unset", "none",
]);

function valueOk(v: string): boolean {
  const t = v.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (STOPVALUES.has(t.toLowerCase())) return false;
  if (/^(?:in|on|to|for|with|from|by|at|the|a|an)\s/i.test(t)) return false;
  return true;
}

function kindOf(value: string): ExtractedKind {
  return PERSON_SHAPE.test(value.trim()) ? "person" : "value";
}

function aliasesFor(value: string, via: string): string[] {
  const out: string[] = [];
  if (via === "shape:file-path" || value.includes("/")) {
    const base = value.split("/").pop()!;
    if (base && base !== value) out.push(base);
    const stem = base.replace(/\.[^.]*$/, "").split(".")[0];
    if (stem && stem !== base) out.push(stem);
  }
  if (via === "shape:path") {
    const tail = value.split("/").filter(Boolean).pop();
    if (tail && tail !== value) out.push(tail);
  }
  return out;
}

/**
 * Propose new entities from one filed text. Pure and deterministic: same
 * text in, same proposals out. Deduplicated by normalised value; the first
 * (most precise) pattern to claim a value wins, and a labelled proposal
 * beats an unlabelled one for the same value.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const src = text ?? "";
  const byKey = new Map<string, ExtractedEntity>();
  const keyOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  const propose = (name: string, via: string, label?: string) => {
    const value = name.trim().replace(/^['"]|['"]$/g, "");
    if (!valueOk(value)) return;
    const k = keyOf(value);
    if (!k) return;
    const existing = byKey.get(k);
    if (existing) {
      if (!existing.label && label) existing.label = label;
      return;
    }
    byKey.set(k, {
      name: value,
      kind: kindOf(value),
      ...(label ? { label: label.trim() } : {}),
      aliases: aliasesFor(value, via),
      via,
    });
  };

  // 1a. CONSTANT = 'value' / CONSTANT = value
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*'([^']{1,80})'/g)) propose(m[2], "assign:equals-quoted", m[1]);
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*(\d[\d:.,]*)\b/g)) propose(m[2], "assign:equals-number", m[1]);
  // 1b. Set/Update CONSTANT ... to 'value' / to value. The gap between the
  //     constant and "to" routinely contains dotted file names
  //     ("Set PORT in src/config.mjs to 8490"), so it may cross dots — but
  //     never a newline, and the lazy match stops at the first assignment.
  for (const m of src.matchAll(/\b(?:Set|Update)\s+([A-Z][A-Z0-9_]{2,})\b[^\n]{0,60}?\bto\s+'([^']{1,80})'/g)) propose(m[2], "assign:set-to-quoted", m[1]);
  for (const m of src.matchAll(/\b(?:Set|Update)\s+([A-Z][A-Z0-9_]{2,})\b[^\n]{0,60}?\bto\s+(\d[\d:.,]*)\b/g)) propose(m[2], "assign:set-to-number", m[1]);

  // 2. "... is named X" / "... is called X"
  for (const m of src.matchAll(/\bis\s+(?:named|called)\s+['"]?([^\s'",;.]{2,60})/g)) propose(m[1], "named");

  // 3. "The <label> is <value>" — value must be a single token, a quoted
  //    string, a number, or an ALL-CAPS phrase; plain prose objects of "is"
  //    ("the owner is out") are rejected by the shape check below.
  for (const m of src.matchAll(/(?:^|[.!]\s+)(?:[Tt]he\s+)?([a-z][a-z ]{2,40}?)\s+is\s+(?:set\s+to\s+)?(['"][^'"]{1,80}['"]|\d+(?:\.\d+)?(?![\d:.])|[A-Z]{2,}(?:\s[A-Z]{2,})+|[^\s.,;]{2,60})/g)) {
    const value = m[2].replace(/^['"]|['"]$/g, "");
    const labelledNumber = /^\d[\d:.,]*$/.test(value);
    const shaped = SHAPE_PATTERNS.some(({ re }) => { re.lastIndex = 0; return re.test(value); });
    // A labelled compound id whose tail segment is all hex letters slips
    // past every standalone shape — no digit to anchor on
    // (ep-gfproof-helmian-abcdef). The label is the precision mechanism,
    // exactly as it is for labelled numbers: prose compounds fail the
    // tail test (state-of-the-art, mother-in-law — tails are neither
    // digit-bearing nor hex).
    const tail = value.split("-").pop()!;
    const labelledId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}$/.test(value)
      && (/[0-9]/.test(tail) || /^[a-f0-9]{4,}$/.test(tail));
    if (labelledNumber || shaped || labelledId || PERSON_SHAPE.test(value)) propose(value, "labelled:is", m[1]);
  }

  // 4. Standalone value-shaped tokens.
  for (const { re, via } of SHAPE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) propose(m[0], via);
  }

  // 5. Person names not already proposed.
  for (const m of src.matchAll(/\b[A-Z][a-z]{1,}\s[A-Z][a-z]{1,}\b/g)) {
    if (!byKey.has(keyOf(m[0]))) propose(m[0], "shape:person-name");
  }

  return [...byKey.values()];
}
