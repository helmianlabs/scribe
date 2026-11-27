/**
 * The Librarian's knowledge graph (migration 007): named things (entities), their other
 * names (aliases), and proven connections between them (links).
 *
 * V1 SCOPE — structured sources only, no model calls, no external APIs:
 * links are built when a memory is filed, from facts the server already knows —
 * who wrote it (agent_directory), which project it belongs to, which category the
 * Librarian filed it under — plus mentions of names the memory already knows
 * (agents in the directory, projects on file), matched whole-word in the text.
 *
 * V2 ADDITION (graph-fix bite, 2026-11-23) — free-text extraction: after the
 * structured pass, extractEntities (extract.ts) proposes brand-new entities
 * and exact named values out of the text itself — labelled assignments,
 * named things, value-shaped tokens, person names — and each becomes an
 * entity (kind 'value', or 'person' for person names) wired exactly like a
 * known-name mention, plus a label -has_value-> value link when the text
 * named the value with a label. Migration 008 adds 'value' to the entities
 * kind CHECK. Extraction is deterministic patterns only: still no model
 * calls, still fail-soft — an extraction error never fails a filing.
 *
 * Name variants are the whole game, so identity is a normalised key, not the raw
 * string: "Faith and Light", "faith-and-light" and "FAITH  AND  LIGHT" are one
 * entity. Resolution tries, in order: the canonical key, a registered alias, then
 * a squashed match with spaces removed ("faithnlight"). First write wins for an
 * entity's kind, display name and aliases — the agent_directory convention.
 *
 * Append-only like the rest of the Librarian: upserts are INSERT ... ON CONFLICT
 * DO NOTHING plus SELECT, so the memory_rw role (SELECT + INSERT) is enough and
 * nothing here ever UPDATEs or DELETEs.
 */
import type pg from "pg";
import { findWords } from './match.js';
import { extractEntities } from './extract.js';

export type EntityKind = "person" | "agent" | "project" | "product" | "org" | "place" | "topic" | "value";
export type LinkSourceKind = "message" | "filing" | "move" | "manual";

export interface EntityRow {
  id: number;
  kind: EntityKind;
  name: string;
  canonical_key: string;
  created_at: string;
  updated_at: string;
}

export interface NeighborRow {
  entity_id: number;
  kind: EntityKind;
  name: string;
  relation: string;
  direction: "out" | "in";
  source_kind: LinkSourceKind;
  source_id: number | null;
  created_at: string;
}

/**
 * The identity of a name: lowercase, every run of non-letter/non-digit characters
 * folded to one space, trimmed. "Troy Shoemaker" -> "troy shoemaker",
 * "troy@dairyforge.com" -> "troy dairyforge com", "Faith-and-Light" -> "faith and light".
 */
export function canonicalKey(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** canonicalKey with the spaces removed too: "faith and light" -> "faithandlight". */
export function squashKey(name: string): string {
  return canonicalKey(name).replace(/ /g, "");
}

function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

function mapEntity(r: Record<string, unknown>): EntityRow {
  return {
    id: Number(r.id),
    kind: r.kind as EntityKind,
    name: String(r.name),
    canonical_key: String(r.canonical_key),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

const ENTITY_COLS = "id, kind, name, canonical_key, created_at, updated_at";

export class KnowledgeGraph {
  constructor(private read: pg.Pool, private write: pg.Pool) {}

  /**
   * Find the entity a surface name refers to, or null. Tries the canonical key,
   * then a registered alias, then the squashed (spaces-removed) form of both.
   */
  async resolveEntity(name: string): Promise<EntityRow | null> {
    const key = canonicalKey(name);
    if (!key) return null;

    let r = await this.read.query(
      `SELECT ${ENTITY_COLS} FROM entities WHERE canonical_key = $1 ORDER BY id LIMIT 1`,
      [key],
    );
    if (r.rows[0]) return mapEntity(r.rows[0]);

    r = await this.read.query(
      `SELECT e.id, e.kind, e.name, e.canonical_key, e.created_at, e.updated_at
       FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
       WHERE a.alias_key = $1 ORDER BY e.id LIMIT 1`,
      [key],
    );
    if (r.rows[0]) return mapEntity(r.rows[0]);

    const squashed = key.replace(/ /g, "");
    r = await this.read.query(
      `SELECT ${ENTITY_COLS} FROM entities WHERE replace(canonical_key, ' ', '') = $1 ORDER BY id LIMIT 1`,
      [squashed],
    );
    if (r.rows[0]) return mapEntity(r.rows[0]);

    r = await this.read.query(
      `SELECT e.id, e.kind, e.name, e.canonical_key, e.created_at, e.updated_at
       FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
       WHERE replace(a.alias_key, ' ', '') = $1 ORDER BY e.id LIMIT 1`,
      [squashed],
    );
    return r.rows[0] ? mapEntity(r.rows[0]) : null;
  }

  /**
   * Get-or-create an entity by its canonical key and register any aliases for it.
   * If the name (or one of the aliases) already resolves to an entity, that entity
   * is returned and the remaining aliases are registered on it. First write wins:
   * an existing entity keeps its original kind and display name.
   */
  async upsertEntity(kind: EntityKind, name: string, aliases: string[] = []): Promise<EntityRow> {
    const display = (name ?? "").trim();
    const key = canonicalKey(display);
    if (!key) throw new Error("upsertEntity: name has no usable characters");

    const found = (await this.resolveEntity(display)) ?? (await this.resolveFirstAlias(aliases));
    let entity = found;
    if (!entity) {
      const ins = await this.write.query(
        `INSERT INTO entities (kind, name, canonical_key) VALUES ($1, $2, $3)
         ON CONFLICT (canonical_key) DO NOTHING
         RETURNING ${ENTITY_COLS}`,
        [kind, display, key],
      );
      if (ins.rows[0]) {
        entity = mapEntity(ins.rows[0]);
      } else {
        // Lost a race with a concurrent insert of the same key: read it back.
        const back = await this.write.query(
          `SELECT ${ENTITY_COLS} FROM entities WHERE canonical_key = $1 ORDER BY id LIMIT 1`,
          [key],
        );
        entity = mapEntity(back.rows[0]);
      }
    }

    for (const alias of aliases) await this.registerAlias(entity, alias);
    return entity;
  }

  private async resolveFirstAlias(aliases: string[]): Promise<EntityRow | null> {
    for (const alias of aliases) {
      const hit = await this.resolveEntity(alias);
      if (hit) return hit;
    }
    return null;
  }

  /** Register one surface name for an entity. A name already claimed (as a canonical
   *  key or as another entity's alias) is left where it is: first registration wins. */
  private async registerAlias(entity: EntityRow, alias: string): Promise<void> {
    const surface = (alias ?? "").trim();
    const aliasKey = canonicalKey(surface);
    if (!surface || !aliasKey || aliasKey === entity.canonical_key) return;
    await this.write.query(
      `INSERT INTO entity_aliases (entity_id, alias, alias_key) VALUES ($1, $2, $3)
       ON CONFLICT (alias_key) DO NOTHING`,
      [entity.id, surface, aliasKey],
    );
  }

  /**
   * Record one proven connection between two entities. Idempotent: the same
   * (from, to, relation, source) is stored once, however often it is reported.
   * Returns the link id and whether this call created it; null for a self-link.
   */
  async recordLink(
    fromId: number,
    toId: number,
    relation: string,
    sourceKind: LinkSourceKind,
    sourceId: number | null,
  ): Promise<{ id: number; created: boolean } | null> {
    if (fromId === toId) return null;
    const rel = (relation ?? "").trim();
    if (!rel) throw new Error("recordLink: relation is required");

    const select = `SELECT id FROM links
                    WHERE from_entity_id = $1 AND to_entity_id = $2 AND relation = $3
                      AND source_kind = $4 AND source_id IS NOT DISTINCT FROM $5
                    ORDER BY id LIMIT 1`;
    const args = [fromId, toId, rel, sourceKind, sourceId];
    const before = await this.write.query(select, args);
    if (before.rows[0]) return { id: Number(before.rows[0].id), created: false };

    const ins = await this.write.query(
      `INSERT INTO links (from_entity_id, to_entity_id, relation, source_kind, source_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      args,
    );
    if (ins.rows[0]) return { id: Number(ins.rows[0].id), created: true };

    const after = await this.write.query(select, args);
    return after.rows[0] ? { id: Number(after.rows[0].id), created: false } : null;
  }

  /**
   * Depth-1 neighbours of the entity a name resolves to: everything it links to
   * and everything that links to it, each with the relation and the source that
   * proved it. Depth above 1 is clamped to 1 in v1.
   */
  async neighbors(
    entityName: string,
    depth = 1,
  ): Promise<{ entity: EntityRow | null; neighbors: NeighborRow[] }> {
    void depth; // v1 reads one hop only, however deep the caller asks.
    const entity = await this.resolveEntity(entityName);
    if (!entity) return { entity: null, neighbors: [] };
    const r = await this.read.query(
      `SELECT e.id AS entity_id, e.kind, e.name, l.relation, 'out' AS direction,
              l.source_kind, l.source_id, l.created_at
       FROM links l JOIN entities e ON e.id = l.to_entity_id
       WHERE l.from_entity_id = $1
       UNION ALL
       SELECT e.id AS entity_id, e.kind, e.name, l.relation, 'in' AS direction,
              l.source_kind, l.source_id, l.created_at
       FROM links l JOIN entities e ON e.id = l.from_entity_id
       WHERE l.to_entity_id = $1
       ORDER BY created_at DESC`,
      [entity.id],
    );
    return {
      entity,
      neighbors: r.rows.map((x) => ({
        entity_id: Number(x.entity_id),
        kind: x.kind as EntityKind,
        name: String(x.name),
        relation: String(x.relation),
        direction: x.direction as "out" | "in",
        source_kind: x.source_kind as LinkSourceKind,
        source_id: x.source_id === null || x.source_id === undefined ? null : Number(x.source_id),
        created_at: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
      })),
    };
  }

  /**
   * Build the graph links for one filed memory, from structured sources only:
   * its author, its project, the category it was filed under, and mentions of
   * names the memory already knows (agent_directory + projects), matched
   * whole-word and case-insensitively in the text. Never throws on a database
   * without migration 007: it reports installed: false instead.
   */
  async buildLinksForFiling(item: FiledItem): Promise<BuildLinksResult> {
    const empty: BuildLinksResult = { installed: true, entities: [], linksCreated: 0, linksFound: 0 };
    try {
      const sourceKind: LinkSourceKind = item.sourceKind ?? "message";
      const numericId = typeof item.messageId === "number" ? item.messageId : Number(item.messageId);
      const sourceId = item.sourceId ?? (Number.isFinite(numericId) ? numericId : null);

      // The dictionary of already-known names. Fresh on every call: v1 keeps no cache.
      const agentNames = (await this.read.query("SELECT DISTINCT name FROM agent_directory"))
        .rows.map((x) => String(x.name)).filter((n) => canonicalKey(n).length >= 2);
      const projectNames = (await this.read.query("SELECT name FROM projects WHERE name IS NOT NULL"))
        .rows.map((x) => String(x.name)).filter((n) => canonicalKey(n).length >= 2);
      const agentKeys = new Set(agentNames.map((n) => canonicalKey(n)));

      const entities = new Map<number, EntityRow>();
      const keep = (e: EntityRow) => { entities.set(e.id, e); return e; };

      // Anchors: facts the server already knows about this filing.
      const author = item.author?.trim()
        ? keep(await this.upsertEntity("agent", item.author))
        : null;
      const project = item.projectName?.trim()
        ? keep(await this.upsertEntity("project", item.projectName))
        : null;
      const category = item.category?.trim()
        ? keep(await this.upsertEntity("topic", item.category))
        : null;

      // Mentions: known names appearing in the text itself.
      const anchorKeys = new Set([author, project, category].filter(Boolean).map((e) => e!.canonical_key));
      const dictionary = [...new Map(
        [...agentNames, ...projectNames].map((n) => [canonicalKey(n), n] as const),
      ).values()].filter((n) => !anchorKeys.has(canonicalKey(n)));
      const mentioned: EntityRow[] = [];
      for (const surface of findWords(item.text ?? "", dictionary)) {
        const kind: EntityKind = agentKeys.has(canonicalKey(surface)) ? "agent" : "project";
        mentioned.push(keep(await this.upsertEntity(kind, surface)));
      }

      let linksCreated = 0;
      let linksFound = 0;
      const link = async (from: EntityRow | null, to: EntityRow | null, relation: string) => {
        if (!from || !to) return;
        const res = await this.recordLink(from.id, to.id, relation, sourceKind, sourceId);
        if (res?.created) linksCreated += 1;
        else if (res) linksFound += 1;
      };

      await link(author, project, "active_in");
      await link(author, category, "filed_under");
      for (const m of mentioned) {
        await link(author, m, "mentioned");
        await link(project, m, "mentioned");
        await link(m, category, "filed_under");
      }

      // V2: free-text extraction — brand-new entities and exact named values
      // out of the text itself. Wired like mentions, plus the label link.
      // Fail-soft inside the fail-soft: extraction can never fail a filing.
      try {
        for (const cand of extractEntities(item.extractText ?? item.text ?? "")) {
          if (anchorKeys.has(canonicalKey(cand.name))) continue;
          const ent = keep(await this.upsertEntity(cand.kind, cand.name, cand.aliases));
          await link(author, ent, "mentioned");
          await link(project, ent, "mentioned");
          await link(ent, category, "filed_under");
          if (cand.label && canonicalKey(cand.label) !== canonicalKey(cand.name)) {
            const label = keep(await this.upsertEntity("topic", cand.label));
            await link(label, ent, "has_value");
            await link(author, label, "mentioned");
          }
        }
      } catch { /* extraction is additive only */ }

      return { ...empty, entities: [...entities.values()], linksCreated, linksFound };
    } catch (err) {
      if (isMissingTable(err)) return { ...empty, installed: false };
      throw err;
    }
  }
}

/** One filed memory, as the graph builder needs it. Mirrors MemoryItem plus filing facts. */
export interface FiledItem {
  messageId: number | string;
  text: string;
  /**
   * Deploy-bite wiring (PROOF.md recommendation 6): the text free-text
   * extraction runs over. Callers pass the Librarian's ignore-filtered text
   * (applyIgnore over the tag-stripped body — the same text classification
   * matched on) so infrastructure names the rulebook ignores never become
   * entities. The v1 structured pass always uses `text`. Defaults to `text`.
   */
  extractText?: string;
  /** Who wrote it (sender / source name). Structured truth: becomes an 'agent' entity. */
  author?: string | null;
  /** The project the memory belongs to (projects.name), when known. */
  projectName?: string | null;
  /** The category the Librarian filed it under (memory_categories slug), when filed. */
  category?: string | null;
  /** Which record proves the links. Defaults to 'message' with sourceId = messageId. */
  sourceKind?: LinkSourceKind;
  sourceId?: number | null;
}

export interface BuildLinksResult {
  installed: boolean;
  entities: EntityRow[];
  linksCreated: number;
  linksFound: number;
}
