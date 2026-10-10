/**
 * The schema v7 fusion additions: terminal publish outcomes on compartments
 * (`landed_reason` + `superseded`) and the S(t) `memory_stats` sidecar.
 *
 * Both are borrows from mon3stera/dsh-magic-context@0.1.0 (publish guard,
 * hit-driven decay scoring), reshaped to this adapter's contracts: a rejected
 * compartment keeps its covered-seq claims (the span IS digested — it just
 * does not pay for its render), a superseded one releases them (the span
 * re-enters the historian's eligibility pool), and memory stats live only in
 * the adapter's own database — the shared memory store is never written for
 * scoring (writer-contract discipline).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompartmentDraft } from '../src/core/compartments.ts'
import { openStores } from '../src/core/stores.ts'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* OS temp sweep covers residue */
    }
  }
})

const draft: CompartmentDraft = {
  tiers: { p1: 'p1', p2: 'p2', p3: 'p3', p4: 'p4' },
  importance: 50,
  facts: [],
  events: [],
}

describe('schema v7: terminal publish outcomes', () => {
  it('excludes rejected and superseded drafts from the publish lane', () => {
    const stores = openStores(tempDir('mc-fusion-guard-'))
    try {
      const kept = stores.allocateCompartment('s', draft, { startSeq: 1, endSeq: 2, seqs: [1, 2], tokens: 10 }, 1, 5)
      const rejected = stores.allocateCompartment('s', draft, { startSeq: 10, endSeq: 11, seqs: [10, 11], tokens: 10 }, 1, 6)
      const superseded = stores.allocateCompartment('s', draft, { startSeq: 20, endSeq: 21, seqs: [20, 21], tokens: 10 }, 1, 7)

      stores.markCompartmentRejected('s', rejected.compartmentId, 'not-shrinkable')
      stores.supersedeCompartment('s', superseded.compartmentId, 'superseded-entrants')

      // Only the untouched draft stays publishable.
      expect(stores.listUnlandedCompartments('s').map(row => row.compartmentId))
        .toEqual([kept.compartmentId])
      // The rejection keeps its covered-seq claims; the supersede releases
      // its own (20, 21 are back in the historian's eligibility pool).
      expect([...stores.coveredSeqs('s')].sort((left, right) => left - right))
        .toEqual([1, 2, 10, 11])
      const mapped = stores.listCompartments('s')
      expect(mapped.find(row => row.compartmentId === rejected.compartmentId)?.landedReason)
        .toBe('not-shrinkable')
      expect(mapped.find(row => row.compartmentId === superseded.compartmentId)?.landedReason)
        .toBe('superseded-entrants')
    } finally {
      stores.close()
    }
  })

  it('never re-publishes a rejected draft after a reopen (durable terminal state)', () => {
    const dataDir = tempDir('mc-fusion-guard-durable-')
    const first = openStores(dataDir)
    const created = first.allocateCompartment('s', draft, { startSeq: 1, endSeq: 2, seqs: [1, 2], tokens: 10 }, 1, 5)
    first.markCompartmentRejected('s', created.compartmentId, 'not-shrinkable')
    first.close()
    const second = openStores(dataDir)
    try {
      expect(second.listUnlandedCompartments('s')).toEqual([])
      expect([...second.coveredSeqs('s')]).toEqual([1, 2])
    } finally {
      second.close()
    }
  })
})

describe('schema v7: the memory_stats sidecar', () => {
  it('records hits and injections independently and prunes orphans', () => {
    const stores = openStores(tempDir('mc-fusion-stats-'))
    try {
      stores.recordMemoryEvent('proj', 1, 'hit', 100)
      stores.recordMemoryEvent('proj', 1, 'injection', 110)
      stores.recordMemoryEvent('proj', 1, 'hit', 120)
      stores.recordMemoryEvent('proj', 2, 'injection', 130)

      const rows = stores.listMemoryStats('proj')
      expect(rows).toHaveLength(2)
      const first = rows.find(row => row.memoryId === 1)
      expect(first?.hits).toBe(2)
      expect(first?.lastHitAt).toBe(120)
      expect(first?.injections).toBe(1)
      expect(first?.lastInjectedAt).toBe(110)
      expect(first?.localArchived).toBe(false)

      // Identities are isolated; narrow reads omit unknown ids.
      expect(stores.listMemoryStats('other')).toEqual([])
      expect(stores.listMemoryStats('proj', [1, 99]).map(row => row.memoryId)).toEqual([1])
      // (setMemoryLocalArchived was deleted 2026-10-10: zero production callers
      //  from birth — retirement is computed live at recall and in the report.)

      // The orphan sweep removes exactly the ids that left the known pool.
      expect(stores.pruneMemoryStats('proj', [1])).toBe(1)
      expect(stores.listMemoryStats('proj').map(row => row.memoryId)).toEqual([1])
    } finally {
      stores.close()
    }
  })
})
