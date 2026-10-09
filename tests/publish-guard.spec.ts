/**
 * The v7 publish guard, driven through the real management pass over a fake
 * surface: drift (substantive entrants inside the positional range) and
 * no-gain (the digest's render does not pay for the span) verdicts, in
 * `observe` (journal only, publish proceeds — the shipped default) and
 * `enforce` (supersede / reject) modes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type PressurePolicy } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'
import type { Journal } from '../src/core/journal.ts'
import type { Session } from '../src/dsh/seams.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

interface FakeEvent {
  seq: number
  type: string
  data: { id: string; role: string; content: Array<{ type: string; text?: string }> }
}

function userEvent(seq: number, text: string): FakeEvent {
  return { seq, type: 'user/message', data: { id: `u${String(seq)}`, role: 'user', content: [{ type: 'text', text }] } }
}

const draft = {
  tiers: { p1: 'digest', p2: 'digest', p3: 'digest', p4: 'digest' },
  importance: 50,
  facts: [],
  events: [],
}

interface JournalRow {
  kind: string
  summary: string
  data?: Record<string, unknown>
}

function fakeJournal(): { journal: Journal; rows: JournalRow[] } {
  const rows: JournalRow[] = []
  const record = (kind: string, summary: string, data?: Record<string, unknown>): void => {
    rows.push({ kind, summary, data })
  }
  const journal = {
    info: (kind: string, summary: string, data?: Record<string, unknown>) => record(kind, summary, data),
    warn: (kind: string, summary: string, data?: Record<string, unknown>) => record(kind, summary, data),
    error: (kind: string, summary: string, data?: Record<string, unknown>) => record(kind, summary, data),
  } as unknown as Journal
  return { journal, rows }
}

function runPass(
  stores: AdapterStores,
  policy: PressurePolicy,
  events: readonly FakeEvent[],
  journal: Journal | undefined,
): { published: readonly number[]; compactedAppends: number } {
  const log = [...events]
  let nextSeq = (events.at(-1)?.seq ?? 0) + 1
  let compactedAppends = 0
  const session = {
    snapshotEvents: () => log,
    surface: { nodes: log.map(event => event.seq), replaceGeneration: 1 },
    append: (type: string, data: unknown) => {
      // The publish lane's replacement carries the synthetic `mc-compacted-`
      // id; a baseline refresh appends `mc-baseline-*` and is expected in
      // every pass (the first pass always performs a HARD rebuild).
      if (type === 'user/message' && String((data as { id?: string }).id ?? '').startsWith('mc-compacted-')) {
        compactedAppends += 1
      }
      const seq = nextSeq
      nextSeq += 1
      log.push({ seq, type, data } as FakeEvent)
      return { seq }
    },
  } as unknown as Session
  const outcome = runManagementPass({
    session,
    sessionId: 's',
    stores,
    policy,
    logger: { info() {}, warn() {} },
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 70,
    ...journal === undefined ? {} : { journal },
  })
  return { published: outcome.published, compactedAppends }
}

describe('the v7 publish guard', () => {
  it('observe mode journals substantive entrants and still publishes (shipped default)', () => {
    const stores = openStores(tempDir('mc-guard-observe-'))
    const { journal, rows } = fakeJournal()
    try {
      // The compartment covers seqs 2 and 4; seq 3 sits between them
      // positionally and carries substantive text the draft never saw.
      const created = stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 4, seqs: [2, 4], tokens: 500 }, 1, 5)
      const events = [userEvent(1, 'head'), userEvent(2, 'covered one'), userEvent(3, 'x'.repeat(400)), userEvent(4, 'covered two')]
      const policy: PressurePolicy = { ...DEFAULT_POLICY, compartmentGuardMode: 'observe', compartmentEntrantTokens: 50 }
      const { published, compactedAppends } = runPass(stores, policy, events, journal)

      expect(published).toEqual([created.compartmentId])
      expect(compactedAppends).toBe(1)
      const row = rows.find(entry => entry.kind === 'compartment-guard')
      expect(row?.data?.verdict).toBe('substantive-entrants')
      expect(row?.data?.mode).toBe('observe')
      // Observe acts on nothing: the draft landed, nothing was retired.
      expect(stores.listUnlandedCompartments('s')).toEqual([])
      expect(stores.listCompartments('s')[0]?.landedReason).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it('enforce mode supersedes a drifted draft and publishes nothing', () => {
    const stores = openStores(tempDir('mc-guard-enforce-drift-'))
    const { journal, rows } = fakeJournal()
    try {
      const created = stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 4, seqs: [2, 4], tokens: 500 }, 1, 5)
      const events = [userEvent(1, 'head'), userEvent(2, 'covered one'), userEvent(3, 'x'.repeat(400)), userEvent(4, 'covered two')]
      const policy: PressurePolicy = { ...DEFAULT_POLICY, compartmentGuardMode: 'enforce', compartmentEntrantTokens: 50 }
      const { published, compactedAppends } = runPass(stores, policy, events, journal)

      expect(published).toEqual([])
      expect(compactedAppends).toBe(0)
      const row = rows.find(entry => entry.kind === 'compartment-guard')
      expect(row?.data?.mode).toBe('enforce')
      // Superseded: terminal AND claims released, so the span — originals
      // plus the entrant — goes back to the historian's eligibility pool.
      expect(stores.listUnlandedCompartments('s')).toEqual([])
      expect(stores.listCompartments('s')[0]?.landedReason).toBe('superseded-entrants')
      expect(stores.coveredSeqs('s').has(2)).toBe(false)
      expect(stores.coveredSeqs('s').has(3)).toBe(false)
      expect(created.compartmentId).toBeGreaterThan(0)
    } finally {
      stores.close()
    }
  })

  it('enforce mode rejects a digest whose render does not pay for the span', () => {
    const stores = openStores(tempDir('mc-guard-enforce-shrink-'))
    const { journal, rows } = fakeJournal()
    try {
      // One 40-char node (~10 tokens) covered by a digest whose baseline
      // render (header + four tiers + placeholder) costs more than that.
      const created = stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 2, seqs: [2], tokens: 10 }, 1, 5)
      const events = [userEvent(1, 'head'), userEvent(2, 'x'.repeat(40))]
      const policy: PressurePolicy = { ...DEFAULT_POLICY, compartmentGuardMode: 'enforce' }
      const { published, compactedAppends } = runPass(stores, policy, events, journal)

      expect(published).toEqual([])
      expect(compactedAppends).toBe(0)
      const row = rows.find(entry => entry.kind === 'compartment-guard')
      expect(row?.data?.verdict).toBe('not-shrinkable')
      // A rejection KEEPS its covered-seq claims: the span is digested, it
      // just never earns a publish — no infinite re-draft loop.
      expect(stores.listUnlandedCompartments('s')).toEqual([])
      expect(stores.listCompartments('s')[0]?.landedReason).toBe('not-shrinkable')
      expect(stores.coveredSeqs('s').has(2)).toBe(true)
    } finally {
      stores.close()
    }
  })
})
