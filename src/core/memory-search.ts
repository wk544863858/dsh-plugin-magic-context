import { DatabaseSync } from 'node:sqlite';
import { cosineSimilarity } from './embedding-local.ts';
import { errText } from './types.ts';

/**
 * `ctx_search`'s memory lane — a faithful port of Magic Context's hybrid
 * retrieval (`features/magic-context/search.ts` + `memory/storage-memory-fts.ts`,
 * v0.45.0), reading the SAME shared store read-only.
 *
 * Score model (MC search.ts:49-51, 320-330, 855-901):
 *   hybrid  = SEMANTIC_WEIGHT(0.7) × cosine + FTS_WEIGHT(0.3) × reciprocal-rank
 *   single  = score × SINGLE_SOURCE_PENALTY(0.8)
 *   cosine  = clamp01; FTS order = bm25, updated_at DESC, id ASC; FTS scores
 *             are 1/(rank+1) (getFtsScores:801-803), NOT raw bm25 values.
 *   sort    = score DESC, id ASC; preview = 220 chars with `…`.
 *
 * Lanes: FTS5 (`memories_fts MATCH`, sanitize → strict AND, 0 rows → relaxed
 * OR — storage-memory-fts.ts:63-123) over the pool (domain visibility rules
 * identical to recall: own rows full, foreign rows need shareable + scope +
 * category allowlist — buildWorkspaceMemorySqlFilter:783-840), plus the
 * semantic lane over `memory_embeddings` vectors read-only.
 *
 * Candidates for semantic scoring are `ftsMatches ∪ storedVectorIds` ∩ pool
 * (MC selectSemanticCandidates:805-834). Candidates lacking a stored vector may
 * be embedded in memory, bounded per search — the adapter never writes Magic
 * Context's store (MC's own read-path backfill persists vectors instead).
 *
 * Deliberate deviations (recorded, not silent): no `visibleMemoryIds`
 * suppression (the adapter does not track which rows the current prompt already
 * carries, search.ts:877-880); in-memory embedding capped to bound latency.
 */

const FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
export const DEFAULT_MEMORY_SEARCH_LIMIT = 10;
export const MAX_MEMORY_SEARCH_LIMIT = 25;
/** Upper bound on rows embedded in memory for one search (latency guard). */
export const MAX_IN_MEMORY_EMBEDDINGS = 32;
const ID_SHAPED_QUERY_MAX_TOKENS = 5;
const ID_SHAPED_TOKEN = /^#?\d+$/;

export interface MemorySearchSpace {
  /** Own identities: full visibility (MC `ownIdentities`). */
  readonly ownIdentities: readonly string[];
  /** Workspace peer identities: shared categories only. */
  readonly foreignIdentities: readonly string[];
  /** The active domains' normalized allowlist union (`[]` shares nothing). */
  readonly shareCategories: readonly string[];
}

export interface MemorySearchRequest {
  readonly query: string
  readonly space: MemorySearchSpace
  readonly limit?: number
  readonly now: number
  /** Query embedding, or null (provider off/failed) → FTS lane only. */
  readonly queryEmbedding: Float32Array | null
  /** The model_id whose stored vectors share the query's vector space. */
  readonly queryModelId: string | null
  /** In-memory embedding for candidates without a stored vector. Fail-open. */
  readonly embedTexts?: (texts: readonly string[]) => Promise<Float32Array[] | null>
  /**
   * A2 (MC getVisibleMemoryIds / suppressedVisibleMemoryIds): memory ids the
   * injected block already renders. They are suppressed from TEXT search hits
   * — re-surfacing them wastes tokens and pushes other hits down. Explicit
   * id-shaped lookups are never suppressed. Absent = don't filter (the
   * worst case is a redundant memory result, never a correctness issue).
   */
  readonly visibleMemoryIds?: ReadonlySet<number>
  /** A3: earliest memory `created_at` in epoch ms (inclusive). */
  readonly from?: number
  /** A3: latest memory `created_at` in epoch ms (inclusive). */
  readonly to?: number
  /** A3: which search sources to consider. The adapter's unified lane covers
   *  `memory` only; anything else in the list yields zero hits. */
  readonly sources?: readonly string[]
}

export interface MemorySearchHit {
  readonly id: number
  readonly category: string
  readonly score: number
  readonly matchType: 'hybrid' | 'semantic' | 'fts'
  readonly preview: string
}

export type MemorySearchOutcome =
  | {
    readonly ok: true
    readonly hits: readonly MemorySearchHit[]
    /** Rendered `Found N results for "…"` block (MC formatSearchResults). */
    readonly text: string
    readonly ftsMatches: number
    readonly semanticMatches: number
    /** A2: memory hits suppressed because the injected block already renders them. */
    readonly suppressedVisible: number
  }
  | { readonly ok: false; readonly reason: string }

export interface MemorySearch {
  search(request: MemorySearchRequest): Promise<MemorySearchOutcome>
  /**
   * The store's dominant embedding identity (MC vectors are fenced per model;
   * the adapter follows whichever identity the shared store actually uses).
   * `dims` is the stored vector width in floats — 384 = MiniLM fp32.
   */
  dominantEmbeddingModel(): { readonly modelId: string; readonly dims: number } | undefined
  /** One (content, stored vector) pair for runtime parity verification. */
  paritySample(modelId: string): { readonly content: string; readonly embedding: Float32Array } | undefined
  close(): void
}

/** MC sanitizeFtsQuery (storage-memory-fts.ts:70-80) — every whitespace token
 *  becomes a quoted literal so FTS5 operators lose their meaning. */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .replaceAll('\0', ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

/** MC relaxedFtsQuery (storage-memory-fts.ts:63-68) — word chars only, length
 *  > 2 or containing a digit, deduped, max 16, OR-joined. */
export function relaxedFtsQuery(query: string): string {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter((token) => token.length > 2 || /\d/.test(token))
    .slice(0, 16);
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

/** MC parseIdShapedQuery (search.ts:297-321) — a query made only of id tokens
 *  (`#920`, `920 921`, max 5) is a direct lookup, not a text search. */
export function parseIdShapedQuery(query: string): number[] | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > ID_SHAPED_QUERY_MAX_TOKENS) return null;
  const ids: number[] = [];
  for (const token of tokens) {
    if (!ID_SHAPED_TOKEN.test(token)) return null;
    const parsed = Number.parseInt(token.replace(/^#/, ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    ids.push(parsed);
  }
  return ids;
}

/** MC previewText (search.ts:328-333). */
export function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= RESULT_PREVIEW_LIMIT) return normalized;
  return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** MC normalizeCosineScore (search.ts:320-326). */
function normalizeCosineScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/** Workspace visibility predicate (MC buildWorkspaceMemorySqlFilter:783-840):
 *  own identities see everything, foreign rows must be shareable + scope
 *  project/ecosystem/universe + in the active domains' category allowlist.
 *  `table` qualifies the column refs (the vector join aliases memories as m). */
export function domainVisibilityPredicate(
  space: MemorySearchSpace,
  table = 'memories',
): {
  clause: string
  params: string[]
} {
  const q = `${table}.`;
  const own = [...new Set(space.ownIdentities)].filter((id) => id.length > 0);
  const foreign = [...new Set(space.foreignIdentities)].filter(
    (id) => id.length > 0 && !own.includes(id),
  );
  const share = [...new Set(space.shareCategories)];
  const predicates: string[] = [];
  const params: string[] = [];
  if (own.length > 0) {
    predicates.push(`${q}project_path IN (${own.map(() => '?').join(', ')})`);
    params.push(...own);
  }
  if (foreign.length > 0 && share.length > 0) {
    predicates.push(
      `(${q}project_path IN (${foreign.map(() => '?').join(', ')})`
      + ` AND ${q}category IN (${share.map(() => '?').join(', ')})`
      + ` AND ${q}shareable = 1`
      + ` AND ${q}scope IN ('project','ecosystem','universe'))`,
    );
    params.push(...foreign, ...share);
  }
  if (predicates.length === 0) return { clause: ' AND 0 = 1', params: [] };
  return { clause: ` AND (${predicates.join(' OR ')})`, params };
}

interface MemorySearchRow {
  id: number
  category: string | null
  content: string
  createdAt: number
}

export function openMemorySearch(options: {
  readonly dbPath: string
  readonly logger?: {
    readonly info?: (message: string) => void;
    readonly warn?: (message: string) => void;
  };
}): MemorySearch {
  const { logger } = options;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.dbPath, { readOnly: true });
  } catch (error) {
    const reason = `search store unavailable: ${errText(error)}`;
    return {
      search: () => Promise.resolve({ ok: false, reason }),
      dominantEmbeddingModel: () => undefined,
      paritySample: () => undefined,
      close: () => {},
    };
  }

  const tableExists = (name: string): boolean => {
    try {
      return db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) !== undefined;
    } catch {
      return false;
    }
  };
  const hasMemories = tableExists('memories');
  // Both aux lanes are optional: a store without the FTS index or the
  // embeddings table runs with the remaining lane(s) (MC treats a failed FTS
  // query as an empty lane, search.ts:793-798).
  const hasFts = tableExists('memories_fts');
  const hasVectors = tableExists('memory_embeddings');

  const search = async (request: MemorySearchRequest): Promise<MemorySearchOutcome> => {
    const run = async (): Promise<MemorySearchOutcome> => {
      const trimmed = request.query.trim();
      if (trimmed.length === 0) {
        return { ok: false, reason: 'query is required' };
      }
      const limit = Math.max(
        1,
        Math.min(MAX_MEMORY_SEARCH_LIMIT, Math.floor(request.limit ?? DEFAULT_MEMORY_SEARCH_LIMIT)),
      );
      // A3: the adapter's unified lane covers the `memory` source only; a
      // sources list that excludes it yields zero hits (MC UnifiedSearchOptions).
      if (request.sources !== undefined && !request.sources.includes('memory')) {
        const empty: MemorySearchHit[] = [];
        return {
          ok: true,
          hits: empty,
          text: formatSearchResults(trimmed, empty),
          ftsMatches: 0,
          semanticMatches: 0,
          suppressedVisible: 0,
        };
      }
      const { clause, params } = domainVisibilityPredicate(request.space);
      // The embeddings join aliases memories as `m` — requalify the predicate.
      const vectorVisibility = domainVisibilityPredicate(request.space, 'm');

      // ── Direct id lookup (MC parseIdShapedQuery short-circuit) ────────────
      const idShape = parseIdShapedQuery(trimmed);
      if (idShape !== null) {
        const placeholders = idShape.map(() => '?').join(', ');
        const rows = db.prepare(
          `SELECT id, category, content, created_at AS createdAt FROM memories WHERE id IN (${placeholders})${clause}`
          + ' AND status IN (\'active\',\'permanent\')'
          + ' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id ASC',
        ).all(...idShape, ...params, request.now) as unknown as MemorySearchRow[];
        const hits: MemorySearchHit[] = rows.map((row) => ({
          id: row.id,
          category: row.category ?? '',
          score: 1,
          matchType: 'fts',
          preview: previewText(row.content),
        }));
        return {
          ok: true,
          hits,
          text: formatSearchResults(trimmed, hits),
          ftsMatches: hits.length,
          semanticMatches: 0,
          suppressedVisible: 0,
        };
      }

      if (!hasMemories) {
        return { ok: false, reason: 'memories table missing' };
      }

      // ── Lane 1: FTS5 (strict AND, then relaxed OR fallback) ───────────────
      const ftsSql = (matchPlaceholder: string): string =>
        `SELECT memories.id AS id, memories.category AS category, memories.content AS content, memories.created_at AS createdAt`
        + ` FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid`
        + ` WHERE memories_fts MATCH ${matchPlaceholder}`
        + ` AND memories.status IN ('active','permanent')`
        + ` AND (memories.expires_at IS NULL OR memories.expires_at > ?)`
        + clause
        + ` ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC`
        + ` LIMIT ?`;
      const runFts = (matchValue: string): MemorySearchRow[] =>
        db.prepare(ftsSql('?')).all(
          matchValue, request.now, ...params, FTS_SEMANTIC_CANDIDATE_LIMIT,
        ) as unknown as MemorySearchRow[];
      let ftsRows: MemorySearchRow[] = [];
      if (hasFts) {
        try {
          const sanitized = sanitizeFtsQuery(trimmed);
          if (sanitized.length > 0) ftsRows = runFts(sanitized);
          if (ftsRows.length === 0) {
            const relaxed = relaxedFtsQuery(trimmed);
            if (relaxed.length > 0) ftsRows = runFts(relaxed);
          }
        } catch (error) {
          // MC getFtsMatches:793-798 — a failed FTS query is an empty lane.
          logger?.warn?.(
            `magic-context FTS lane failed: ${errText(error)}`,
          );
          ftsRows = [];
        }
      }

      // ── Lane 2: semantic over stored vectors (+ bounded in-memory fill) ───
      const metaById = new Map<number, MemorySearchRow>(
        ftsRows.map((row) => [row.id, row]),
      );
      const stored = new Map<number, Float32Array>();
      const storedIds: number[] = [];
      if (hasVectors && request.queryEmbedding !== null && request.queryModelId !== null) {
        const rows = db.prepare(
          `SELECT m.id AS id, m.category AS category, m.content AS content, m.created_at AS createdAt, e.embedding AS embedding`
          + ` FROM memory_embeddings e INNER JOIN memories m ON m.id = e.memory_id`
          + ` WHERE e.model_id = ? AND m.status IN ('active','permanent')`
          + ` AND (m.expires_at IS NULL OR m.expires_at > ?)${vectorVisibility.clause}`,
        ).all(request.queryModelId, request.now, ...vectorVisibility.params) as unknown as Array<{
          id: number; category: string | null; content: string; createdAt: number; embedding: Buffer;
        }>;
        const dims = request.queryEmbedding.length;
        for (const row of rows) {
          if (row.embedding.length / 4 !== dims) continue;
          stored.set(row.id, new Float32Array(
            row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4,
          ));
          storedIds.push(row.id);
          if (!metaById.has(row.id)) {
            metaById.set(row.id, { id: row.id, category: row.category, content: row.content, createdAt: row.createdAt });
          }
        }
      }

      const semanticScores = new Map<number, number>();
      if (request.queryEmbedding !== null) {
        const candidateIds = new Set<number>([
          ...ftsRows.map((row) => row.id),
          ...storedIds,
        ]);
        // Bounded in-memory fill for candidates without a stored vector.
        const missing = [...candidateIds]
          .filter((id) => !stored.has(id) && metaById.has(id))
          .slice(0, MAX_IN_MEMORY_EMBEDDINGS);
        if (missing.length > 0 && request.embedTexts !== undefined) {
          try {
            const vectors = await request.embedTexts(
              missing.map((id) => metaById.get(id)!.content),
            );
            if (vectors !== null) {
              for (let i = 0; i < missing.length; i++) {
                const vector = vectors[i];
                if (vector !== undefined) stored.set(missing[i]!, vector);
              }
            }
          } catch {
            // fail-open: the stored vectors already cover the rest
          }
        }
        for (const id of candidateIds) {
          const vector = stored.get(id);
          if (vector === undefined) continue;
          semanticScores.set(
            id,
            normalizeCosineScore(cosineSimilarity(request.queryEmbedding, vector)),
          );
        }
      }

      // ── Merge (MC mergeMemoryResults:836-904) ─────────────────────────────
      const ftsScores = new Map<number, number>(
        ftsRows.map((row, rank) => [row.id, 1 / (rank + 1)]),
      );
      const hits: MemorySearchHit[] = [];
      let suppressedVisible = 0;
      const candidateIds = new Set<number>([...semanticScores.keys(), ...ftsScores.keys()]);
      for (const id of candidateIds) {
        const meta = metaById.get(id);
        if (meta === undefined) continue;
        // A3: created_at window (inclusive both ends).
        if (request.from !== undefined && meta.createdAt < request.from) continue;
        if (request.to !== undefined && meta.createdAt > request.to) continue;
        // A2: rows the injected block already renders are suppressed from
        // text results (MC suppressedVisibleMemoryIds; worst case without it
        // is a redundant hit, never a correctness issue).
        if (request.visibleMemoryIds?.has(id) === true) {
          suppressedVisible += 1;
          continue;
        }
        const semanticScore = semanticScores.get(id);
        const ftsScore = ftsScores.get(id);
        let score = 0;
        let matchType: MemorySearchHit['matchType'] = 'fts';
        if (semanticScore !== undefined && ftsScore !== undefined) {
          score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
          matchType = 'hybrid';
        } else if (semanticScore !== undefined) {
          score = semanticScore * SINGLE_SOURCE_PENALTY;
          matchType = 'semantic';
        } else if (ftsScore !== undefined) {
          score = ftsScore * SINGLE_SOURCE_PENALTY;
          matchType = 'fts';
        }
        if (score <= 0) continue;
        hits.push({
          id,
          category: meta.category ?? '',
          score,
          matchType,
          preview: previewText(meta.content),
        });
      }
      hits.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.id - right.id;
      });
      const page = hits.slice(0, limit);
      return {
        ok: true,
        hits: page,
        text: formatSearchResults(trimmed, page),
        ftsMatches: ftsRows.length,
        semanticMatches: semanticScores.size,
        suppressedVisible,
      };
    };
    // B3 (MC single_store_reads): one deferred read transaction so the FTS
    // lane, the vector reads and the pool probes observe ONE snapshot.
    try {
      if (hasMemories || hasFts || hasVectors) db.exec('BEGIN');
      try {
        return await run();
      } finally {
        try {
          db.exec('COMMIT');
        } catch {
          /* aborted read transaction — readonly, nothing to roll back */
        }
      }
    } catch (error) {
      return {
        ok: false,
        reason: `memory search failed: ${errText(error)}`,
      };
    }
  };

  return {
    search,
    dominantEmbeddingModel: () => {
      if (!hasVectors) return undefined;
      try {
        const row = db.prepare(
          `SELECT model_id, MIN(length(embedding)) / 4 AS dims, COUNT(*) AS n`
          + ` FROM memory_embeddings GROUP BY model_id ORDER BY n DESC, model_id ASC LIMIT 1`,
        ).get() as unknown as { model_id: string; dims: number | null } | undefined;
        if (row === undefined || row.model_id.length === 0) return undefined;
        return { modelId: row.model_id, dims: row.dims ?? 0 };
      } catch {
        return undefined;
      }
    },
    paritySample: (modelId) => {
      if (!hasVectors) return undefined;
      try {
        const row = db.prepare(
          `SELECT m.content AS content, e.embedding AS embedding`
          + ` FROM memory_embeddings e INNER JOIN memories m ON m.id = e.memory_id`
          + ` WHERE e.model_id = ? ORDER BY e.rowid DESC LIMIT 1`,
        ).get(modelId) as unknown as { content: string; embedding: Buffer } | undefined;
        if (row === undefined) return undefined;
        return {
          content: row.content,
          embedding: new Float32Array(
            row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4,
          ),
        };
      } catch {
        return undefined;
      }
    },
    close: () => {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

/** MC formatSearchResults (search.ts:2390-2413) restricted to the memory lane;
 *  per-hit line format is MC formatUnifiedSearchResult:2304-2311. */
export function formatSearchResults(query: string, hits: readonly MemorySearchHit[]): string {
  if (hits.length === 0) {
    return `No results found for "${query}" in project memories.`;
  }
  const body = hits.map((hit, index) =>
    `[${index + 1}] [memory] score=${hit.score.toFixed(2)} id=${hit.id} category=${hit.category} match=${hit.matchType}\n${hit.preview}`,
  );
  return `Found ${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}":\n\n${body.join('\n\n')}`;
}
