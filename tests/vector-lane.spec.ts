/**
 * The vector lane's decay and the backfill plan (WP11, the half that writes
 * nothing shared).
 *
 * What is being pinned here is not arithmetic for its own sake. The lane decays
 * SILENTLY — recall keeps answering, just with fewer neighbours — and the two
 * ways to make it worse are both invisible in production:
 *
 *   - measuring the frontier with the raw MAX(memory_id) instead of the newest
 *     ACTIVE embedded memory, which lets an archived row's leftover embedding
 *     look like progress and hide the backlog behind it;
 *   - writing a backfill into the wrong embedding space. `memory_embeddings` is
 *     keyed (memory_id, model_id), so a wrong-space row is not an error — it is
 *     simply invisible to readers using the other space, forever.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { describeVectorLane, measureVectorLane, planBackfill } from '../src/core/vector-lane.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-vector-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // never mask the assertion that failed
    }
  }
})

const MODEL_A = 'embedding-provider:aaaa'
const MODEL_B = 'embedding-provider:bbbb'

interface Seed {
  id: number
  status?: string
  spaces?: readonly string[]
}

function makeStore(seeds: Seed[]): string {
  const path = join(tempDir(), 'context.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE memories(
        id INTEGER PRIMARY KEY,
        project_path TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE memory_embeddings(
        memory_id INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        model_id TEXT NOT NULL,
        PRIMARY KEY(memory_id, model_id)
      );
    `)
    const insertMemory = db.prepare(
      'INSERT INTO memories(id, project_path, category, content, normalized_hash, status) VALUES(?, ?, ?, ?, ?, ?)',
    )
    const insertEmbedding = db.prepare('INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, ?, ?)')
    for (const seed of seeds) {
      insertMemory.run(seed.id, 'git:alpha', 'ARCHITECTURE', `memory ${String(seed.id)}`, `hash-${String(seed.id)}`, seed.status ?? 'active')
      for (const space of seed.spaces ?? []) insertEmbedding.run(seed.id, new Uint8Array([1, 2, 3]), space)
    }
  } finally {
    db.close()
  }
  return path
}

describe('measuring the lane', () => {
  const fixture = [
    { id: 1, spaces: [MODEL_A] },
    { id: 2, spaces: [MODEL_A] },
    { id: 3, spaces: [MODEL_A] },
    { id: 4, spaces: [MODEL_B] },
    { id: 5, spaces: [MODEL_A, MODEL_B] },
    { id: 6 },
    // An archived row with a leftover embedding: it must not look like progress.
    { id: 7, status: 'archived', spaces: [MODEL_A] },
  ]

  it('counts coverage over the ACTIVE set only', () => {
    const report = measureVectorLane(makeStore(fixture))!
    expect(report.active).toBe(6)
    expect(report.embedded).toBe(5)
    expect(report.missing).toBe(1)
    expect(report.coverage).toBeCloseTo(5 / 6, 5)
  })

  it('measures the frontier against active rows, so an archived leftover cannot hide the backlog', () => {
    const report = measureVectorLane(makeStore(fixture))!
    expect(report.frontier.newestEmbeddedMemoryId).toBe(5)
    // Both ends of the frontier are ACTIVE-only: id 7 is archived, so it neither
    // advances the frontier nor counts as backlog.
    expect(report.frontier.newestMemoryId).toBe(6)
    expect(report.frontier.unembeddedAboveFrontier).toBe(1)
    expect(report.gapsBelowFrontier).toBe(0)
  })

  it('reports both spaces and picks the dominant one', () => {
    const report = measureVectorLane(makeStore(fixture))!
    expect(report.spaces.map(space => space.modelId)).toEqual([MODEL_A, MODEL_B])
    expect(report.spaces[0]!.rows).toBe(4)
    expect(report.spaces[1]!.rows).toBe(2)
    expect(report.dominantModelId).toBe(MODEL_A)
    expect(report.spaces[0]!.share).toBeCloseTo(4 / 6, 5)
    expect(report.multiSpaceMemories).toBe(1)
    expect(report.dominantCoverage).toBeCloseTo(4 / 6, 5)
  })

  it('counts gaps below the frontier too, which is where churn shows up', () => {
    // id 2 and id 3 lost their embedding (content churn deletes the row) while a
    // newer id still has one: the backlog is BELOW the frontier.
    const report = measureVectorLane(makeStore([
      { id: 1, spaces: [MODEL_A] },
      { id: 2 },
      { id: 3 },
      { id: 5, spaces: [MODEL_A] },
    ]))!
    expect(report.frontier.newestEmbeddedMemoryId).toBe(5)
    expect(report.frontier.unembeddedAboveFrontier).toBe(0)
    expect(report.gapsBelowFrontier).toBe(2)
  })

  it('degrades to undefined rather than throwing on an unreadable or older store', () => {
    const path = join(tempDir(), 'empty.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unrelated(x INTEGER)')
    db.close()
    expect(measureVectorLane(path)).toBeUndefined()
    expect(measureVectorLane(join(tempDir(), 'nope.db'))).toBeUndefined()
  })

  it('describes the decay in one line', () => {
    const line = describeVectorLane(measureVectorLane(makeStore(fixture))!)
    expect(line).toContain('active 6')
    expect(line).toContain('前沿之上 1')
    expect(line).toContain('aaaa 4 行')
  })
})

describe('planning the backfill', () => {
  it('targets the dominant space and includes rows that only exist in the other one', () => {
    const plan = planBackfill(makeStore([
      { id: 1, spaces: [MODEL_A] },
      { id: 2, spaces: [MODEL_A] },
      { id: 3, spaces: [MODEL_B] },
      { id: 4 },
      { id: 5, status: 'archived' },
    ]))!
    expect(plan.modelId).toBe(MODEL_A)
    // id 3 has an embedding, but only in the space a reader will not use; id 4
    // has none at all. Both need a row in the dominant space. The archived id 5
    // does not.
    expect(plan.candidates).toEqual([3, 4])
    expect(plan.total).toBe(2)
  })

  it('bounds the candidate list without hiding the total', () => {
    const seeds = Array.from({ length: 10 }, (_unused, index) => ({ id: index + 1, spaces: [MODEL_A] as const }))
    seeds.push({ id: 11, spaces: [] as const })
    seeds.push({ id: 12, spaces: [] as const })
    const plan = planBackfill(makeStore(seeds), { limit: 1 })!
    expect(plan.candidates).toEqual([11])
    expect(plan.total).toBe(2)
  })

  it('refuses to invent a space when none exists yet', () => {
    const plan = planBackfill(makeStore([{ id: 1 }, { id: 2 }]))!
    expect(plan.modelId).toBe('')
    expect(plan.candidates).toEqual([])
    expect(plan.reason).toContain('first writer decides the space')
  })

  it('says so plainly when there is nothing to do', () => {
    const plan = planBackfill(makeStore([{ id: 1, spaces: [MODEL_A] }, { id: 2, spaces: [MODEL_A] }]))!
    expect(plan.total).toBe(0)
    expect(plan.reason).toContain('already has a row')
  })
})
