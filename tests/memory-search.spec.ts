/**
 * `ctx_memory` action `search` — the hybrid memory lane (MC ctx_search parity).
 *
 * Ported scoring lives in `memory-search.ts`; these tests pin the contract that
 * matters to an agent:
 *  - FTS text handling is MC's (sanitize → strict AND, 0 rows → relaxed OR,
 *    FTS5 operators neutralized — storage-memory-fts.ts:63-123);
 *  - fusion is MC's: hybrid = 0.7×cosine + 0.3×reciprocal-rank, a single-source
 *    hit takes ×0.8, sort by score DESC then id ASC (search.ts:49-51, 855-901);
 *  - workspace visibility matches recall (own rows full; foreign rows need
 *    shareable + project scope + category allowlist);
 *  - an id-shaped query (`#920`) is a direct lookup, not a text search
 *    (search.ts:297-321);
 *  - §9.1: an explicit search bumps `retrieval_count` for exactly the ids the
 *    agent received, and a missing writer must not fail the read;
 *  - every degradation is fail-open: a store without FTS/embeddings runs with
 *    the remaining lanes, an unavailable store reports a reason.
 *
 * The embedder is injected — these tests exercise the scoring/SQL surface with
 * deterministic vectors, no network and no model files.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatSearchResults,
  openMemorySearch,
  parseIdShapedQuery,
  previewText,
  relaxedFtsQuery,
  sanitizeFtsQuery,
  workspaceVisibilityPredicate,
  type MemorySearchSpace,
} from '../src/core/memory-search.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineCtxMemoryTool } from '../src/dsh/tool-bridge.ts'
import { makeMemoryDb } from './helpers/memory-db'

const OWN = 'git:1111111111111111111111111111111111111111'
const PEER = 'git:2222222222222222222222222222222222222222'
const SUPPORTED = 95
const T0 = 1_700_000_000_000
const silentLogger = { info: () => {}, warn: () => {} }

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    } catch {
      /* best effort */
    }
  }
})

function createDb(version: number = SUPPORTED): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-search-', schemaVersion: version, mutationLog: true, projectState: true, authority: true,
  })
  tempDirs.push(dir)
  return path
}

function addFtsTable(path: string): void {
  const db = new DatabaseSync(path)
  try {
    // External-content FTS5, rowid = memories.id (MC's real index shape).
    db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id')")
    db.exec('CREATE TABLE memory_embeddings (memory_id INTEGER, embedding BLOB, model_id TEXT)')
  } finally {
    db.close()
  }
}

function seed(
  path: string,
  project: string,
  content: string,
  overrides: {
    category?: string
    shareable?: number
    scope?: string
    status?: string
    vector?: number[]
    vectorModel?: string
  } = {},
): number {
  const category = overrides.category ?? 'CONSTRAINTS'
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
         last_seen_at, last_retrieved_at, status, verification_status)
       VALUES(?, ?, ?, ?, 50, ?, ?, 'agent', 1, 0, 0, ?, ?, ?, NULL, ?, 'unverified')`,
    ).run(
      project,
      category,
      content,
      `hash-${Math.random()}`,
      overrides.scope ?? 'project',
      overrides.shareable ?? 0,
      T0,
      T0,
      T0,
      overrides.status ?? 'active',
    )
    const id = Number(result.lastInsertRowid)
    if (overrides.vector !== undefined) {
      const bytes = Buffer.from(new Float32Array(overrides.vector).buffer)
      db.prepare('INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, ?, ?)')
        .run(id, bytes, overrides.vectorModel ?? 'embedding-provider:test')
    }
    return id
  } finally {
    db.close()
  }
}

function syncFts(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec("INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories")
  } finally {
    db.close()
  }
}

function space(overrides: Partial<MemorySearchSpace> = {}): MemorySearchSpace {
  return {
    ownIdentities: [OWN],
    foreignIdentities: [],
    shareCategories: ['CONSTRAINTS'],
    ...overrides,
  }
}

describe('FTS text handling is MC storage-memory-fts.ts', () => {
  it('sanitizes operators into quoted literals and breaks on NUL', () => {
    expect(sanitizeFtsQuery('docker -x (a):b*')).toBe('"docker" "-x" "(a):b*"')
    // an embedded quote is doubled inside the quoted token
    expect(sanitizeFtsQuery('say "hi"')).toBe('"say" """hi"""')
    expect(sanitizeFtsQuery('a\0b c')).toBe('"a" "b" "c"')
    expect(sanitizeFtsQuery('   ')).toBe('')
  })

  it('builds the relaxed OR query with MC token rules', () => {
    // MC's tokenizer is [\p{L}\p{N}_]+ — a hyphen splits tokens; keep length
    // > 2 or digit-bearing; dedupe; quote; OR-join.
    expect(relaxedFtsQuery('kubernet deployment of pod-7 ab kubernet')).toBe(
      '"kubernet" OR "deployment" OR "pod" OR "7"',
    )
    expect(relaxedFtsQuery('a b c ab')).toBe('')
  })

  it('parses id-shaped queries and rejects prose', () => {
    expect(parseIdShapedQuery('#920')).toEqual([920])
    expect(parseIdShapedQuery('920, 921')).toEqual([920, 921])
    expect(parseIdShapedQuery('fix bug 920')).toBeNull()
    expect(parseIdShapedQuery('#0')).toBeNull()
    expect(parseIdShapedQuery('#1 #2 #3 #4 #5 #6')).toBeNull()
  })
})

describe('hybrid scoring is MC search.ts', () => {
  it('blends 0.7×cosine + 0.3×reciprocal-rank and penalizes single-source hits', async () => {
    const path = createDb()
    addFtsTable(path)
    // #1 matches FTS only; #2 matches vectors only; #3 matches both.
    seed(path, OWN, 'fts only memory about deploys')
    const bothId = seed(path, OWN, 'hybrid memory about deploys', { vector: [1, 0] })
    // no FTS token overlap → semantic-only candidate (vector ids enter the
    // candidate set through selectSemanticCandidates, search.ts:805-834)
    const semanticId = seed(path, OWN, 'unrelated shipping note', { vector: [1, 0] })
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: 'deploys',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: new Float32Array([1, 0]),
        queryModelId: 'embedding-provider:test',
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const byId = new Map(outcome.hits.map(hit => [hit.id, hit]))
      const hybrid = byId.get(bothId)!
      const semantic = byId.get(semanticId)!
      expect(hybrid.matchType).toBe('hybrid')
      // hybrid = 0.7×cos(=1) + 0.3×reciprocal-rank over the bm25 order; the
      // exact rank belongs to bm25, so pin the fusion bounds instead:
      expect(hybrid.score).toBeGreaterThan(0.7)
      expect(hybrid.score).toBeLessThanOrEqual(1)
      // single-source semantic: cos 1 ×0.8 penalty
      expect(semantic.matchType).toBe('semantic')
      expect(semantic.score).toBeCloseTo(0.8, 5)
      // single-source fts: reciprocal-rank ×0.8 penalty (rank is bm25's)
      const ftsRow = outcome.hits.find(hit => hit.matchType === 'fts')!
      expect(ftsRow.score).toBeGreaterThan(0)
      expect(ftsRow.score).toBeLessThanOrEqual(0.8)
      // hybrid tops the ranking regardless of which row bm25 ranked first
      expect(outcome.hits[0]!.id).toBe(bothId)
      expect(outcome.semanticMatches).toBe(2)
    } finally {
      lane.close()
    }
  })

  it('falls back from strict AND to relaxed OR when strict finds nothing', async () => {
    const path = createDb()
    addFtsTable(path)
    seed(path, OWN, 'kubernetes deployment guide for the cluster')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      // strict: "kubernets" AND "deployment" matches nothing (no stemming);
      // relaxed: OR over word tokens still finds the row.
      const outcome = await lane.search({
        query: 'kubernets deployment',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.ftsMatches).toBe(1)
      expect(outcome.hits[0]!.matchType).toBe('fts')
      expect(outcome.hits[0]!.score).toBeCloseTo(0.8, 5)
    } finally {
      lane.close()
    }
  })

  it('sorts by score desc then id asc and clamps the limit', async () => {
    const path = createDb()
    addFtsTable(path)
    for (let i = 0; i < 5; i++) seed(path, OWN, `duplicate memory row ${i} widget`)
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: 'widget',
        space: space(),
        limit: 3,
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.hits.length).toBe(3)
      // equal scores → id ascending
      expect(outcome.hits.map(hit => hit.id)).toEqual([...outcome.hits.map(hit => hit.id)].sort((a, b) => a - b))
    } finally {
      lane.close()
    }
  })

  it('resolves an id-shaped query directly without any lane', async () => {
    const path = createDb()
    const id = seed(path, OWN, 'exact row content')
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: `#${id}`,
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.hits.map(hit => hit.id)).toEqual([id])
      expect(outcome.text).toContain(`id=${id}`)
    } finally {
      lane.close()
    }
  })
})

describe('workspace visibility matches the recall rules', () => {
  it('own rows are fully visible; foreign rows need share + scope + category', async () => {
    const path = createDb()
    addFtsTable(path)
    seed(path, OWN, 'own private row widget')
    seed(path, PEER, 'foreign shared constraint widget', { shareable: 1 })
    seed(path, PEER, 'foreign unshared row widget', { shareable: 0 })
    seed(path, PEER, 'foreign wrong category widget', { shareable: 1, category: 'PROJECT_RULES' })
    seed(path, PEER, 'foreign user-scope widget', { shareable: 1, scope: 'user' })
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: 'widget',
        space: space({ foreignIdentities: [PEER] }),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.hits.length).toBe(2)
      expect(outcome.text).toContain('own private row widget')
      expect(outcome.text).toContain('foreign shared constraint widget')
      expect(outcome.text).not.toContain('unshared')
      expect(outcome.text).not.toContain('wrong category')
      expect(outcome.text).not.toContain('user-scope')
    } finally {
      lane.close()
    }
  })

  it('exposes the predicate shape the tests and callers can pin', () => {
    const { clause, params } = workspaceVisibilityPredicate({
      ownIdentities: [OWN],
      foreignIdentities: [PEER],
      shareCategories: ['CONSTRAINTS'],
    })
    expect(clause).toContain('memories.project_path IN (?)')
    expect(clause).toContain('memories.shareable = 1')
    expect(clause).toContain("memories.scope IN ('project','ecosystem','universe')")
    expect(params).toEqual([OWN, PEER, 'CONSTRAINTS'])
  })
})

describe('fail-open degradation', () => {
  it('runs FTS-only when the store has no embeddings table', async () => {
    const path = createDb()
    addFtsTable(path)
    seed(path, OWN, 'plain fts row widget')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      expect(lane.dominantEmbeddingModel()).toBeUndefined()
      const outcome = await lane.search({
        query: 'widget',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: new Float32Array([1, 0]),
        queryModelId: null, // parity unverified → stored lane off
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.hits.length).toBe(1)
      expect(outcome.semanticMatches).toBe(0)
    } finally {
      lane.close()
    }
  })

  it('reports an unavailable store with a reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-search-empty-'))
    tempDirs.push(dir)
    const lane = openMemorySearch({ dbPath: join(dir, 'missing.db'), logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: 'anything',
        space: space(),
        now: T0,
        queryEmbedding: null,
        queryModelId: null,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toContain('unavailable')
    } finally {
      lane.close()
    }
  })

  it('truncates previews at 220 chars with an ellipsis', () => {
    const long = 'x'.repeat(300)
    expect(previewText(long).length).toBe(220)
    expect(previewText(long).endsWith('…')).toBe(true)
    expect(previewText('short')).toBe('short')
    expect(formatSearchResults('q', []).startsWith('No results')).toBe(true)
  })
})

describe('§9.1 at the ctx_memory boundary', () => {
  const RUN_CTX = { callId: 'c1', name: 'ctx_memory', agent: { session: { id: 'ses-1', header: { cwd: 'D:/work' } } } }

  function build(options: {
    readonly recordRetrieval?: (ids: number[]) => void
    readonly writer?: unknown
    readonly search?: unknown
  }): BuiltTool {
    return defineCtxMemoryTool({
      defineTool,
      resolveIdentity: () => OWN,
      ...options.writer === undefined ? {} : { writer: options.writer },
      ...options.search === undefined ? {} : { search: options.search },
    }) as unknown as BuiltTool
  }

  interface BuiltTool {
    execute(args: unknown, exec: unknown): Promise<unknown>
  }

  it('counts the returned ids through recordRetrieval', async () => {
    const counted: number[][] = []
    const tool = build({
      writer: { recordRetrieval: (input: { ids: number[] }) => { counted.push(input.ids) } },
      search: async () => ({
        ok: true as const,
        text: 'Found 2 results for "q"',
        hits: [{ id: 7 }, { id: 9 }],
      }),
    })
    const result = await tool.execute({ action: 'search', query: 'q' }, RUN_CTX) as { search?: string }
    expect(result.search).toContain('Found 2 results')
    expect(counted).toEqual([[7, 9]])
  })

  it('answers even without a writer (search is read-only) and reports failures', async () => {
    const tool = build({
      search: async () => ({ ok: false as const, reason: 'search store unavailable: x' }),
    })
    const result = await tool.execute({ action: 'search', query: 'q' }, RUN_CTX) as { reason?: string }
    expect(result.reason).toBe('search store unavailable: x')

    const noWriter = build({
      search: async () => ({ ok: true as const, text: 'Found 0 results for "q"', hits: [] }),
    })
    const ok = await noWriter.execute({ action: 'search', query: 'q' }, RUN_CTX) as { search?: string }
    expect(ok.search).toContain('Found 0 results')
  })

  it('requires a query and surfaces a missing search wiring', async () => {
    const tool = build({})
    const noQuery = await tool.execute({ action: 'search' }, RUN_CTX) as { outcome?: string }
    expect(noQuery.outcome).toContain('query')
    const unwired = await tool.execute({ action: 'search', query: 'q' }, RUN_CTX) as { reason?: string }
    expect(unwired.reason).toContain('not wired')
  })
})

describe('visible-memory suppression and date bounds (MC search parity)', () => {
  it('suppresses already-visible memory hits from text results and counts them', async () => {
    const path = createDb()
    addFtsTable(path)
    const visibleId = seed(path, OWN, 'already injected memory about deploys')
    const freshId = seed(path, OWN, 'brand new memory about deploys')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const clean = await lane.search({
        query: 'deploys',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
      })
      // both match equally → score tie → id ASC (MC's final sort)
      expect(clean.ok && clean.hits.map(hit => hit.id)).toEqual([visibleId, freshId])
      const suppressed = await lane.search({
        query: 'deploys',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
        visibleMemoryIds: new Set([visibleId]),
      })
      expect(suppressed.ok && suppressed.hits.map(hit => hit.id)).toEqual([freshId])
      expect(suppressed.ok && suppressed.suppressedVisible).toBe(1)
    } finally {
      lane.close()
    }
  })

  it('never suppresses an explicit id-shaped lookup', async () => {
    const path = createDb()
    addFtsTable(path)
    const id = seed(path, OWN, 'row the injected block already renders')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: `#${String(id)}`,
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
        visibleMemoryIds: new Set([id]),
      })
      // an explicit `#id` is a direct read, not a re-surface: it counts
      expect(outcome.ok && outcome.hits.map(hit => hit.id)).toEqual([id])
      expect(outcome.ok && outcome.suppressedVisible).toBe(0)
    } finally {
      lane.close()
    }
  })

  it('bounds hits by the created_at window (inclusive both ends)', async () => {
    const path = createDb()
    addFtsTable(path)
    seed(path, OWN, 'time bounded memory about deploys')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const base = {
        query: 'deploys',
        space: space(),
        queryEmbedding: null,
        queryModelId: null,
      }
      // seeded created_at === T0
      const inside = await lane.search({ ...base, now: T0 + 1000, from: T0, to: T0 })
      expect(inside.ok && inside.hits.length).toBe(1)
      const beforeOnly = await lane.search({ ...base, now: T0 + 1000, from: 0, to: T0 - 1 })
      expect(beforeOnly.ok && beforeOnly.hits.length).toBe(0)
      const afterOnly = await lane.search({ ...base, now: T0 + 1000, from: T0 + 1 })
      expect(afterOnly.ok && afterOnly.hits.length).toBe(0)
    } finally {
      lane.close()
    }
  })

  it('yields zero hits when the sources list excludes memory', async () => {
    const path = createDb()
    addFtsTable(path)
    seed(path, OWN, 'unreachable memory about deploys')
    syncFts(path)
    const lane = openMemorySearch({ dbPath: path, logger: silentLogger })
    try {
      const outcome = await lane.search({
        query: 'deploys',
        space: space(),
        now: T0 + 1000,
        queryEmbedding: null,
        queryModelId: null,
        sources: ['message', 'git_commit'],
      })
      expect(outcome.ok && outcome.hits.length).toBe(0)
      expect(outcome.ok && outcome.text).toContain('No results found')
    } finally {
      lane.close()
    }
  })
})