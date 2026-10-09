/**
 * WP11 — filling the vector lane.
 *
 * Every rule here guards a SILENT failure: a missing or wrong vector costs
 * recall quality and nothing else, so nothing complains. That is exactly why the
 * negative controls carry the weight in this file — "no candidates" must mean
 * "no writes AND no embed call", a closed parity gate must abort the whole
 * batch, and an unusable vector must be dropped rather than stored.
 *
 * The last block proves the wire format end to end: what `storeEmbedding` writes
 * must decode back to the same floats, or every later cosine comparison is
 * nonsense while looking perfectly healthy.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizedMemoryHash, openMemoryWriter } from '../src/core/memory-write.ts'
import { isUsableVector, runVectorBackfill, type BackfillPlanLike } from '../src/core/vector-backfill.ts'
import type { Journal, JournalKind, JournalLevel } from '../src/core/journal.ts'
import { makeMemoryDb } from './helpers/memory-db'

const NOW = 1_700_000_000_000
const DOMINANT = 'embedding-provider:c447205ebd551e83d18c4fd5fd8fc357'
const OTHER = 'embedding-provider:ac1a4f8f0674f430a6c85a0e1a43a86a'
const DIMS = 4
const silentLogger = { info: () => {}, warn: () => {} }

const dirs: string[] = []
const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const closer of closers.splice(0)) {
    try {
      closer.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // never mask the assertion that failed
    }
  }
})

interface Call {
  readonly level: JournalLevel
  readonly kind: JournalKind
  readonly summary: string
  readonly data?: Record<string, unknown>
}

function journal(calls: Call[] = []): Journal {
  const push = (level: JournalLevel) => (
    kind: JournalKind,
    summary: string,
    data?: Record<string, unknown>,
  ): void => { calls.push({ level, kind, summary, data }) }
  return {
    enabled: true,
    record: (level, kind, summary, data) => { calls.push({ level, kind, summary, data }) },
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    tail: () => [],
    byKind: () => [],
  } as unknown as Journal
}

/** Deterministic non-zero vector, distinct per seed. */
function vector(seed: number, dims = DIMS): Float32Array {
  const out = new Float32Array(dims)
  for (let index = 0; index < dims; index += 1) out[index] = ((seed + 1) * (index + 1)) / 100
  return out
}

interface Harness {
  readonly plan: BackfillPlanLike | undefined
  readonly contents: Map<number, string>
  readonly stored: Array<{ memoryId: number; modelId: string; vector: Float32Array }>
  readonly embedded: string[][]
  readonly journal: Journal
  readonly calls: Call[]
}

function harness(overrides: Partial<{
  plan: BackfillPlanLike | undefined
  vectors: readonly Float32Array[]
  embedThrows: boolean
  storeOk: (memoryId: number) => boolean
  modelId: string
  parityModelId: string | null
  limit: number
}> = {}) {
  const state: Harness = {
    plan: overrides.plan ?? { modelId: DOMINANT, candidates: [1, 2, 3], total: 3 },
    contents: new Map([[1, 'first'], [2, 'second'], [3, 'third']]),
    stored: [],
    embedded: [],
    journal: journal(),
    calls: [],
  }
  const calls: Call[] = []
  const log = journal(calls)
  const embedVectors = overrides.vectors
  const deps = {
    plan: () => state.plan,
    contents: (ids: readonly number[]) => ids
      .filter(id => state.contents.has(id))
      .map(id => ({ id, content: state.contents.get(id) as string })),
    embed: async (texts: readonly string[]) => {
      state.embedded.push([...texts])
      if (overrides.embedThrows === true) throw new Error('embedder exploded')
      if (embedVectors !== undefined) return embedVectors
      return texts.map((_, index) => vector(index))
    },
    dims: DIMS,
    store: (input: { memoryId: number; modelId: string; vector: Float32Array }) => {
      state.stored.push({ ...input })
      const ok = overrides.storeOk === undefined ? true : overrides.storeOk(input.memoryId)
      return ok ? { ok: true as const, created: true } : { ok: false as const }
    },
    journal: log,
    limit: overrides.limit ?? 64,
    parityModelId: overrides.parityModelId === undefined ? DOMINANT : overrides.parityModelId,
  }
  return { state, deps, calls }
}

describe('isUsableVector', () => {
  it('accepts a finite, non-zero vector of the right width', () => {
    expect(isUsableVector(vector(1), DIMS)).toBe(true)
  })

  it('rejects an all-zero vector: cosine against it is undefined, not "no match"', () => {
    expect(isUsableVector(new Float32Array(DIMS), DIMS)).toBe(false)
  })

  it('rejects NaN/Infinity, a wrong width, and an absent vector', () => {
    const nan = vector(1)
    nan[0] = Number.NaN
    expect(isUsableVector(nan, DIMS)).toBe(false)
    const inf = vector(1)
    inf[3] = Number.POSITIVE_INFINITY
    expect(isUsableVector(inf, DIMS)).toBe(false)
    expect(isUsableVector(vector(1, DIMS + 1), DIMS)).toBe(false)
    expect(isUsableVector(undefined, DIMS)).toBe(false)
  })
})

describe('runVectorBackfill — the guards', () => {
  it('writes the missing rows and reports coverage gained', async () => {
    const { state, deps } = harness()
    const outcome = await runVectorBackfill(deps)
    expect(outcome.created).toBe(3)
    expect(outcome.failed).toBe(0)
    expect(state.stored.map(row => row.memoryId)).toEqual([1, 2, 3])
    expect(state.stored.every(row => row.modelId === DOMINANT)).toBe(true)
    expect(state.embedded).toEqual([['first', 'second', 'third']])
  })

  it('calls neither the embedder nor the store when the plan is empty (negative control)', async () => {
    const { state, deps } = harness({ plan: { modelId: DOMINANT, candidates: [], total: 0 } })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.reason).toBe('no-candidates')
    expect(outcome.created).toBe(0)
    // The point of the control: a runner that "found nothing to do" after an
    // embed call would pass an outcome-only assertion, so the call itself is
    // asserted on.
    expect(state.embedded).toHaveLength(0)
    expect(state.stored).toHaveLength(0)
  })

  it('aborts the WHOLE batch when the shared-space parity gate closed', async () => {
    const { state, deps } = harness({ parityModelId: null })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.reason).toBe('parity-unproven')
    expect(outcome.created).toBe(0)
    // Not "skip the bad ones": a vector in a space this adapter cannot reproduce
    // is indistinguishable from a good one afterwards.
    expect(state.stored).toHaveLength(0)
    expect(state.embedded).toHaveLength(0)
  })

  it('refuses when the planned space is not the parity-proven space', async () => {
    const { state, deps, calls } = harness({ plan: { modelId: OTHER, candidates: [1], total: 1 } })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.reason).toBe('parity-mismatch')
    expect(state.stored).toHaveLength(0)
    expect(calls.some(call => call.level === 'warn')).toBe(true)
  })

  it('never writes more rows than the configured batch limit', async () => {
    const plan = { modelId: DOMINANT, candidates: [1, 2, 3], total: 99 }
    const { state, deps } = harness({ plan, limit: 2 })
    const outcome = await runVectorBackfill(deps)
    expect(state.stored).toHaveLength(2)
    expect(outcome.created).toBe(2)
    // `total` keeps reporting the whole gap, so the next tick knows to continue.
    expect(outcome.total).toBe(99)
  })

  it('skips an unusable vector instead of storing it', async () => {
    const { state, deps } = harness({
      vectors: [vector(1), new Float32Array(DIMS), vector(3)],
    })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.created).toBe(2)
    expect(outcome.skipped).toBe(1)
    expect(state.stored.map(row => row.memoryId)).toEqual([1, 3])
  })

  it('counts a failed store and still writes the rest', async () => {
    const { state, deps } = harness({ storeOk: memoryId => memoryId !== 2 })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.created).toBe(2)
    expect(outcome.failed).toBe(1)
    expect(state.stored.map(row => row.memoryId)).toEqual([1, 2, 3])
  })

  it('writes nothing when the embedder throws', async () => {
    const { state, deps } = harness({ embedThrows: true })
    const outcome = await runVectorBackfill(deps)
    expect(outcome.reason).toBe('embed-failed')
    expect(outcome.created).toBe(0)
    expect(state.stored).toHaveLength(0)
  })

  it('ignores candidates whose content is blank', async () => {
    const { state, deps } = harness({ plan: { modelId: DOMINANT, candidates: [1, 99], total: 2 } })
    state.contents.set(1, '   ')
    state.contents.set(99, 'real content')
    const outcome = await runVectorBackfill(deps)
    expect(state.embedded).toEqual([['real content']])
    expect(outcome.created).toBe(1)
  })

  it('journals the model id it wrote into, so a third space would be visible', async () => {
    const { deps, calls } = harness()
    await runVectorBackfill(deps)
    const entry = calls.find(call => call.data?.outcome === 'backfill')
    expect(entry?.data?.modelId).toBe(DOMINANT)
    expect(entry?.data?.created).toBe(3)
  })
})

describe('storeEmbedding against a real contract shape', () => {
  function contract(): string {
    const { path, dir } = makeMemoryDb({
      prefix: 'mc-vec-',
      schemaVersion: 94,
      mutationLog: true,
      projectState: true,
      // The vector write targets memory_embeddings, so the fixture must carry
      // it (and with the live column names — see ARTEFACT_DDL).
      artefacts: true,
    })
    dirs.push(dir)
    return path
  }

  function seedMemory(path: string, content: string): number {
    const db = new DatabaseSync(path)
    try {
      return Number(db.prepare(
        `INSERT INTO memories(project_path, category, content, normalized_hash, importance, scope,
           shareable, source_type, seen_count, retrieval_count, first_seen_at, created_at,
           updated_at, last_seen_at, status, expires_at, verification_status)
         VALUES('git:aaaa', 'CONSTRAINTS', ?, ?, 50, 'project', 0, 'agent', 1, 0, 0, 0, 0, 0, 'active', NULL, 'unverified')`,
      ).run(content, normalizedMemoryHash(content)).lastInsertRowid)
    } finally {
      db.close()
    }
  }

  function writerFor(path: string) {
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => NOW })
    closers.push(writer)
    return writer
  }

  function embeddingRows(path: string): Array<{ memory_id: number; model_id: string; embedding: Uint8Array }> {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare('SELECT memory_id, model_id, embedding FROM memory_embeddings ORDER BY memory_id')
        .all() as unknown as Array<{ memory_id: number; model_id: string; embedding: Uint8Array }>
    } finally {
      db.close()
    }
  }

  it('round-trips the floats exactly (a wrong encoding would poison every search)', () => {
    const path = contract()
    const writer = writerFor(path)
    const id = seedMemory(path, 'a fact')
    const original = Float32Array.from([0.5, -1.25, 3, 0.0009765625])
    expect(writer.storeEmbedding({ memoryId: id, modelId: DOMINANT, vector: original }).ok).toBe(true)

    const [row] = embeddingRows(path)
    expect(row!.model_id).toBe(DOMINANT)
    expect(row!.embedding.byteLength).toBe(original.byteLength)
    const decoded = new Float32Array(
      row!.embedding.buffer.slice(row!.embedding.byteOffset, row!.embedding.byteOffset + row!.embedding.byteLength),
    )
    expect([...decoded]).toEqual([...original])
  })

  it('is idempotent on (memory_id, model_id): a second pass neither duplicates nor counts', () => {
    const path = contract()
    const writer = writerFor(path)
    const id = seedMemory(path, 'a fact')
    const first = writer.storeEmbedding({ memoryId: id, modelId: DOMINANT, vector: vector(1) })
    const second = writer.storeEmbedding({ memoryId: id, modelId: DOMINANT, vector: vector(2) })
    expect(first.ok && first.created).toBe(true)
    expect(second.ok && second.created).toBe(false)
    expect(embeddingRows(path)).toHaveLength(1)
  })

  it('leaves the space count where it was — the writer adds rows, not identities', () => {
    const path = contract()
    const writer = writerFor(path)
    const seed = seedMemory(path, 'already embedded elsewhere')
    // The store starts with one identity; the backfill must not add a second.
    const db = new DatabaseSync(path)
    try {
      db.prepare('INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, ?, ?)')
        .run(seed, Buffer.from(vector(9).buffer), DOMINANT)
    } finally {
      db.close()
    }
    const fresh = seedMemory(path, 'missing a vector')
    expect(writer.storeEmbedding({ memoryId: fresh, modelId: DOMINANT, vector: vector(3) }).ok).toBe(true)
    const identities = new Set(embeddingRows(path).map(row => row.model_id))
    expect([...identities]).toEqual([DOMINANT])
  })

  it('refuses an empty vector rather than storing a row that breaks cosine', () => {
    const path = contract()
    const writer = writerFor(path)
    const id = seedMemory(path, 'a fact')
    const result = writer.storeEmbedding({ memoryId: id, modelId: DOMINANT, vector: new Float32Array(0) })
    expect(result.ok).toBe(false)
    expect(embeddingRows(path)).toEqual([])
  })

  it('reads back content for a plan batch', () => {
    const path = contract()
    const writer = writerFor(path)
    const first = seedMemory(path, 'one')
    const second = seedMemory(path, 'two')
    expect(writer.readContents([first, second, 4242])).toEqual([
      { id: first, content: 'one' },
      { id: second, content: 'two' },
    ])
  })
})
