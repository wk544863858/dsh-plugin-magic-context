/**
 * `ctx_memory` explicit-retrieval telemetry — the TOOL-level half of task-9 ②.
 *
 * Why this file exists: `memory-gate-fence.spec.ts` pins `recordRetrieval` at
 * the WRITER boundary (one bump per owned id, `updated_at` untouched, telemetry
 * is not a write). Nothing pinned the tool boundary, which is where the
 * counting rule from Magic Context actually lives:
 *
 *   `packages/plugin/src/features/magic-context/search.ts:2258-2276`
 *   "Only count retrievals for explicit agent-driven searches. Plugin-internal
 *    automatic surfacing (auto-search hints) should not inflate retrieval_count
 *    because the agent may never actually consume the hint."
 *
 * The distinction is carried by the shape of the call, not by a flag:
 *  - `ctx_memory` (action `list`, or a query) is an explicit agent-driven
 *    retrieval: the host reports the ids it rendered through its `recall`
 *    callback and the tool bumps exactly those rows;
 *  - the automatic m[0]/m[1] injection path never goes through this tool, so it
 *    can never inflate the counter.
 * A host that cannot report ids simply omits `ids`: no telemetry, which is
 * always safe. `retrieval_count` is telemetry, not correctness (contract §9.1),
 * so a fenced, authority-blocked, failing or throwing store must still give the
 * agent its lines.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizedMemoryHash,
  openMemoryWriter,
  type MemoryWriter,
} from '../src/core/memory-write.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineCtxMemoryTool } from '../src/dsh/tool-bridge.ts'
import { makeMemoryDb } from './helpers/memory-db'

const OWN = 'git:1111111111111111111111111111111111111111'
const OTHER = 'git:2222222222222222222222222222222222222222'
// MC's storage contract, and one published revision past it: bump with
// `MEMORY_SCHEMA_MAX_VERSION` so the fenced case keeps fencing something.
const SUPPORTED = 95
const NEWER = 96
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
    prefix: 'mc-retrieval-', schemaVersion: version, mutationLog: true, projectState: true, authority: true,
  })
  tempDirs.push(dir)
  return path
}

function run(path: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function seedMemory(path: string, project: string, content: string, updatedAt = 1000): number {
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
         last_seen_at, last_retrieved_at, status, verification_status)
       VALUES(?, 'CONSTRAINTS', ?, ?, 50, 'project', 0, 'agent', 1, 0, 0, 0, ?, ?, NULL, 'active', 'unverified')`,
    ).run(project, content, normalizedMemoryHash(content), updatedAt, updatedAt)
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

function telemetry(path: string, id: number): { retrieval_count: number; last_retrieved_at: number | null; updated_at: number } {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(
      'SELECT retrieval_count, last_retrieved_at, updated_at FROM memories WHERE id = ?',
    ).get(id) as unknown as { retrieval_count: number; last_retrieved_at: number | null; updated_at: number }
  } finally {
    db.close()
  }
}

/** The `ctx_memory` surface under test (the local builder fallback). */
interface BuiltTool {
  execute(args: unknown, exec: unknown): Promise<unknown>
}

const RUN_CTX = { callId: 'c1', name: 'ctx_memory', agent: { session: { id: 'ses-1', header: { cwd: 'D:/work' } } } }

function build(options: {
  readonly path?: string
  readonly writer?: MemoryWriter
  readonly ids?: readonly number[]
  readonly identity?: string | undefined
  readonly recall?: () => unknown
  /** Simulates a host whose store could not be read at all (fenced schema). */
  readonly unavailable?: string
}): BuiltTool {
  const writer = options.writer
    ?? (options.path === undefined ? undefined : openMemoryWriter({ dbPath: options.path, logger: silentLogger, now: () => T0 }))
  const recall = options.recall
    ?? (options.unavailable === undefined
      ? () => ({
        lines: ['[p1] a recalled memory'],
        digest: 'digest-1',
        ...options.ids === undefined ? {} : { ids: [...options.ids] },
      })
      : () => ({ lines: [] as string[], digest: 'unavailable', reason: options.unavailable as string }))
  return defineCtxMemoryTool({
    defineTool,
    ...writer === undefined ? {} : { writer },
    resolveIdentity: () => ('identity' in options ? options.identity : OWN),
    recall: recall as never,
  }) as unknown as BuiltTool
}

describe('explicit retrieval is counted at the ctx_memory boundary (task-9 ②)', () => {
  it('bumps exactly the ids the host reported and leaves updated_at alone', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'retrieved explicitly', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({ writer, ids: [id] })
      const result = await tool.execute({ action: 'list', query: 'explicit' }, RUN_CTX) as { lines?: string[] }
      expect(result.lines).toEqual(['[p1] a recalled memory'])

      const after = telemetry(path, id)
      expect(after.retrieval_count).toBe(1)
      expect(after.last_retrieved_at).toBe(T0)
      // The divergence that keeps m[0] cache-stable: the bridge digests the pool
      // from `id:updated_at` and orders by updated_at, so telemetry must not move it.
      expect(after.updated_at).toBe(1000)
    } finally {
      writer.close()
    }
  })

  it('counts across m[0] and m[1] and skips rows the identity does not own', async () => {
    const path = createDb()
    const mine = seedMemory(path, OWN, 'mine', 1000)
    const foreign = seedMemory(path, OTHER, 'someone else', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({ writer, ids: [mine, foreign, mine] })
      await tool.execute({ action: 'list' }, RUN_CTX)
      expect(telemetry(path, mine).retrieval_count).toBe(1)
      expect(telemetry(path, foreign).retrieval_count).toBe(0)
      expect(telemetry(path, foreign).last_retrieved_at).toBeNull()
    } finally {
      writer.close()
    }
  })

  it('does not count when the host cannot report ids (automatic surfacing shape)', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'hinted, maybe never consumed', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({ writer })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { lines?: string[] }
      expect(result.lines).toEqual(['[p1] a recalled memory'])
      expect(telemetry(path, id).retrieval_count).toBe(0)
      expect(telemetry(path, id).last_retrieved_at).toBeNull()
    } finally {
      writer.close()
    }
  })

  it('still answers when the store is fenced (telemetry is not correctness)', async () => {
    const path = createDb(NEWER)
    const id = seedMemory(path, OWN, 'fenced but readable', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.readOnly).toBe(true)
      const tool = build({ writer, ids: [id] })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { lines?: string[]; reason?: string }
      expect(result.reason).toBeUndefined()
      expect(result.lines).toEqual(['[p1] a recalled memory'])
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('still answers when the counter throws', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'counter explodes', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const exploding = {
      ...writer,
      recordRetrieval: () => { throw new Error('telemetry exploded') },
    } as unknown as MemoryWriter
    try {
      const tool = build({ writer: exploding, ids: [id] })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { lines?: string[]; reason?: string }
      expect(result.reason).toBeUndefined()
      expect(result.lines).toEqual(['[p1] a recalled memory'])
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('does not count a single-row get (a row read is not a search)', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'read one row', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({ writer, ids: [id] })
      const result = await tool.execute({ action: 'get', id }, RUN_CTX) as { memory?: { id: number } }
      expect(result.memory?.id).toBe(id)
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('returns lines with no writer (memory writes disabled) and no identity', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'still readable', 1000)
    const noWriter = build({ ids: [id] })
    expect((await noWriter.execute({ action: 'list' }, RUN_CTX) as { lines?: string[] }).lines)
      .toEqual(['[p1] a recalled memory'])
    // Identity is required for the ownership probe; without it there is nothing
    // safe to count, and the read must still succeed.
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const noIdentity = build({ writer, ids: [id], identity: undefined })
      const result = await noIdentity.execute({ action: 'list' }, RUN_CTX) as { lines?: string[] }
      expect(result.lines).toEqual(['[p1] a recalled memory'])
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('does not count when the host recall has nothing to return', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'unused', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({ writer, ids: [id], recall: () => undefined })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { empty?: boolean }
      expect(result.empty).toBe(true)
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })
})

describe('a store that could not be read says why (fence user-visible surface)', () => {
  it('reports the host reason instead of claiming an empty pool', async () => {
    const path = createDb(NEWER)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({
        writer,
        unavailable: 'schema v95 is newer than the adapter understands (v94)',
      })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { reason?: string; empty?: boolean; lines?: string[] }
      expect(result.reason).toBe('schema v95 is newer than the adapter understands (v94)')
      expect(result.empty).toBeUndefined()
      expect(result.lines).toBeUndefined()
    } finally {
      writer.close()
    }
  })

  it('never attaches a reason when the store answered with lines', async () => {
    const path = createDb()
    const id = seedMemory(path, OWN, 'answerable', 1000)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = build({
        writer,
        ids: [id],
        recall: () => ({ lines: ['[p1] a recalled memory'], digest: 'digest-1', reason: 'stale warning' }),
      })
      const result = await tool.execute({ action: 'list' }, RUN_CTX) as { reason?: string; lines?: string[] }
      expect(result.reason).toBeUndefined()
      expect(result.lines).toEqual(['[p1] a recalled memory'])
    } finally {
      writer.close()
    }
  })
})