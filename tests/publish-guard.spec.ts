/**
 * RETIRED: the fusion-v7 publish guard (2026-10-16).
 *
 * The guard's whole observation window (2026-10-09 commit 96337e00b →
 * 2026-10-16) recorded 0 `compartment-guard` journal hits against 58 clean
 * `compartment-published` rows, so neither `observe` nor `enforce` ever had
 * anything to say: the user retired the mechanism outright. This file keeps
 * its name (scripts/phase-map.mjs registers it) but is now the regression
 * test for the retirement:
 *
 *   - the two pressure shapes the guard used to flag — substantive entrants
 *     inside the positional range, and a digest whose render costs more than
 *     the span it would reclaim — must publish like any other draft;
 *   - no journal row may carry `kind === 'compartment-guard'` any more, and
 *     nothing may be superseded (`superseded-entrants`) or rejected
 *     (`not-shrinkable`) on a guard verdict.
 *
 * If any of these go red, the guard (or its config surface: the deleted
 * `policy.compartmentGuardMode` / `policy.compartmentEntrantTokens`) has come
 * back — see src/dsh/management-pass.ts for the retirement note.
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

/** No journal row of the retired guard kind may be written, ever. */
function expectNoGuardRows(rows: readonly JournalRow[]): void {
  expect(rows.filter(entry => entry.kind === 'compartment-guard')).toEqual([])
}

describe('the retired v7 publish guard', () => {
  it('publishes a draft whose range gained substantive entrants (no guard verdict)', () => {
    const stores = openStores(tempDir('mc-guard-retired-entrants-'))
    const { journal, rows } = fakeJournal()
    try {
      // The compartment covers seqs 2 and 4; seq 3 sits between them
      // positionally and carries substantive text the draft never saw — the
      // shape the guard used to call `substantive-entrants`.
      const created = stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 4, seqs: [2, 4], tokens: 500 }, 1, 5)
      const events = [userEvent(1, 'head'), userEvent(2, 'covered one'), userEvent(3, 'x'.repeat(400)), userEvent(4, 'covered two')]
      const policy: PressurePolicy = { ...DEFAULT_POLICY }
      const { published, compactedAppends } = runPass(stores, policy, events, journal)

      // Published as usual — nothing supersedes or defers it.
      expect(published).toEqual([created.compartmentId])
      expect(compactedAppends).toBe(1)
      expectNoGuardRows(rows)
      expect(stores.listUnlandedCompartments('s')).toEqual([])
      // Landed, and NOT retired for a guard verdict.
      expect(stores.listCompartments('s')[0]?.landedReason).not.toBe('superseded-entrants')
      expect(stores.listCompartments('s')[0]?.landedReason).not.toBe('not-shrinkable')
    } finally {
      stores.close()
    }
  })

  it('publishes a digest whose render does not pay for the span (no guard verdict)', () => {
    const stores = openStores(tempDir('mc-guard-retired-shrink-'))
    const { journal, rows } = fakeJournal()
    try {
      // One 40-char node (~10 tokens) covered by a digest whose baseline
      // render (header + four tiers + placeholder) costs more than that — the
      // shape the guard used to call `not-shrinkable` and reject terminally.
      const created = stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 2, seqs: [2], tokens: 10 }, 1, 5)
      const events = [userEvent(1, 'head'), userEvent(2, 'x'.repeat(40))]
      const policy: PressurePolicy = { ...DEFAULT_POLICY }
      const { published, compactedAppends } = runPass(stores, policy, events, journal)

      expect(published).toEqual([created.compartmentId])
      expect(compactedAppends).toBe(1)
      expectNoGuardRows(rows)
      expect(stores.listUnlandedCompartments('s')).toEqual([])
      expect(stores.listCompartments('s')[0]?.landedReason).not.toBe('not-shrinkable')
      expect(stores.listCompartments('s')[0]?.landedReason).not.toBe('superseded-entrants')
      // The covered claims belong to a landed compartment either way.
      expect(stores.coveredSeqs('s').has(2)).toBe(true)
    } finally {
      stores.close()
    }
  })
})
