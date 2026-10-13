/**
 * Domain visibility matrix (WP3) — the acceptance test for Phase A.
 *
 * The property under test is not "org memories are visible in org projects"
 * (that is one cell). It is that ONE activation function answers every
 * consumer, so the pool a session reads and the pool its watermark freezes over
 * can never disagree. A disagreement is silent and its symptom is a memory that
 * exists but never renders: hidden rows push the watermark past a later visible
 * row, which then falls on the "already rendered" side and disappears.
 *
 * The matrix therefore walks 3 domains × 3 reader relationships × {recall,
 * watermark} and, separately, pins the two halves together:
 *   maxMemoryId(project) must equal the max VISIBLE id — hidden rows included
 *   in that number is exactly the phantom-row bug.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryBridge, type ActivePeerDomain } from '../src/core/memory-bridge.ts'
import { openStores } from '../src/index.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

import { defaultDomainCap } from '../src/core/domains.ts'

const NOW = 1_700_000_000_000
const ORG = 'dir:global:org'
const MACHINE = 'dir:global:machine'

const opened: Array<{ close(): void }> = []
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-domain-vis-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // a lingering handle must not mask the assertion that actually failed
    }
  }
})

const logger = { info: () => {}, warn: () => {} }

interface Seeded {
  storePath: string
  storeDir: string
  contractPath: string
  contractDir: string
  store: ReturnType<typeof openStores>
}

/** One `memories` fixture: visible own rows, domain rows, and rows that must stay hidden. */
function seed(): Seeded {
  const contract = makeMemoryDb({ prefix: 'mc-vis-contract-', schemaVersion: 94 })
  let storeDir = ''
  let db = new DatabaseSync(contract.path)
  try {
    const insert = db.prepare(
      'INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, '
        + 'first_seen_at, created_at, updated_at, last_seen_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const rows: Array<[number, string, string, boolean, string]> = [
      [1, 'git:company', 'CONSTRAINTS', false, 'own baseline rule'],
      [2, ORG, 'CONSTRAINTS', true, 'org bastion pointer'],
      [3, MACHINE, 'ARCHITECTURE', true, 'machine uv toolchain'],
      [5, ORG, 'NAMING', true, 'org naming rule outside the org allowlist'],
      [6, 'git:peer', 'CONSTRAINTS', true, 'peer project row (no workspace any more)'],
      [7, 'git:company', 'CONSTRAINTS', false, 'own newest rule'],
      [8, ORG, 'CONSTRAINTS', false, 'org row that is NOT shareable'],
      [9, MACHINE, 'ARCHITECTURE', false, 'machine row that is NOT shareable'],
    ]
    for (const [id, projectPath, category, shareable, content] of rows) {
      insert.run(id, projectPath, category, content, `hash-${id}`, 'universe', shareable ? 1 : 0, 1, 1, 1, 1, 'active')
    }
  } finally {
    db.close()
  }

  storeDir = tempDir()
  const store = openStores(storeDir)
  opened.push(store)
  store.upsertDomain(
    { domainId: ORG, kind: 'org', enabled: true, budgetTokens: 768, cap: defaultDomainCap('org'), shareCategories: ['CONSTRAINTS'] },
    NOW,
  )
  store.upsertDomain(
    { domainId: MACHINE, kind: 'machine', enabled: true, budgetTokens: 512, cap: defaultDomainCap('machine'), shareCategories: ['ARCHITECTURE'] },
    NOW,
  )
  store.addDomainMember(ORG, 'git:company', NOW)
  store.addDomainMember(MACHINE, 'git:company', NOW)
  store.addDomainMember(MACHINE, 'git:oss', NOW)

  return { storePath: storeDir, storeDir, contractPath: contract.path, contractDir: contract.dir, store }
}

function resolverFor(store: ReturnType<typeof openStores>) {
  return (identity: string): ActivePeerDomain[] =>
    store.activeDomainIdentities(identity).map(domain => ({
      identity: domain.identity,
      shareCategories: store.getDomain(domain.domainId)?.shareCategories ?? [],
      kind: domain.kind,
    }))
}

function bridgeFor(seeded: Seeded, useDomains: boolean) {
  return openMemoryBridge({
    dbPath: seeded.contractPath,
    logger,
    ...useDomains ? { domainResolver: resolverFor(seeded.store) } : {},
  })
}

function recall(bridge: ReturnType<typeof openMemoryBridge>, project: string, maxMemoryId?: number) {
  return bridge.recall({ project, budgetTokens: 100_000, limit: 100, now: NOW, ...maxMemoryId === undefined ? {} : { maxMemoryId } })
}

describe('domain visibility matrix', () => {
  it('shows exactly the own rows plus the activated domains allowed rows', () => {
    const seeded = seed()
    const bridge = bridgeFor(seeded, true)

    const company = recall(bridge, 'git:company')!
    const ids = [...company.rows, ...company.newRows].map(row => row.id).sort((a, b) => a - b)
    // 1 own, 2 org/CONSTRAINTS, 3 machine/ARCHITECTURE, 7 own.
    // Missing: 5 (org but NAMING is outside the org allowlist), 6 (peer project),
    // 8 and 9 (shareable = 0).
    expect(ids).toEqual([1, 2, 3, 7])

    const oss = recall(bridge, 'git:oss')!
    expect([...oss.rows, ...oss.newRows].map(row => row.id)).toEqual([3])

    // Nothing visible at all: the bridge reports "no recall" rather than an
    // empty block, and the watermark is zero.
    expect(recall(bridge, 'git:stranger')).toBeUndefined()
    expect(bridge.maxMemoryId('git:stranger')).toBe(0)
  })

  it('never lets a hidden row advance the watermark (the phantom m[1] guard)', () => {
    const seeded = seed()
    const bridge = bridgeFor(seeded, true)

    // The highest rows are 8 (org, not shareable) and 9 (machine, not shareable).
    // A watermark that counted them would freeze at 9 and swallow id 7.
    expect(bridge.maxMemoryId('git:company')).toBe(7)
    expect(bridge.maxMemoryId('git:oss')).toBe(3)
    expect(bridge.maxMemoryId('git:stranger')).toBe(0)

    // Same number from the recall path — ONE activation answer, two consumers.
    expect(recall(bridge, 'git:company')!.currentMaxMemoryId).toBe(7)

    // Frozen at 5, the visible row above it must surface as an m[1] addition
    // while the two hidden higher rows stay out.
    const frozen = recall(bridge, 'git:company', 5)!
    expect(frozen.newRows.map(row => row.id)).toEqual([7])
    expect([...frozen.rows].map(row => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('states the invariant directly: the watermark IS the max of the visible pool', () => {
    const seeded = seed()
    const bridge = bridgeFor(seeded, true)
    // The two consumers must agree by construction; here they agree observably.
    const visible = [...recall(bridge, 'git:company', 5)!.rows, ...recall(bridge, 'git:company', 5)!.newRows]
      .map(row => row.id)
    expect(bridge.maxMemoryId('git:company')).toBe(Math.max(...visible))
    expect(bridge.maxMemoryId('git:company')).toBe(7)

    // What the guard prevents: a watermark poisoned by a HIDDEN row (id 8 is an
    // org row with shareable = 0). Frozen too high, the visible row 7 stops
    // being an m[1] addition, falls into the m[0] pool instead, and busts the
    // cached prefix — the additive lane silently degrades to a HARD.
    const correct = recall(bridge, 'git:company', 5)!
    expect(correct.newRows.map(row => row.id)).toEqual([7])
    const poisoned = recall(bridge, 'git:company', 8)!
    expect(poisoned.newRows).toEqual([])
    expect(poisoned.rows.map(row => row.id)).toContain(7)
    expect(poisoned.digest).not.toBe(correct.digest)
  })

  it('resolves the same peer set for the search space as for recall', () => {    const seeded = seed()
    const bridge = bridgeFor(seeded, true)

    const space = bridge.searchSpace('git:company')!
    expect(space.ownIdentities).toEqual(['git:company'])
    expect([...space.foreignIdentities].sort()).toEqual([MACHINE, ORG])
    // The bridge filters the reader's own identity out of the peer set.
    expect(space.members).not.toContain('git:company')

    expect(bridge.searchSpace('git:oss')!.foreignIdentities).toEqual([MACHINE])
    expect(bridge.searchSpace('git:stranger')!.foreignIdentities).toEqual([])
  })

  it('activates nothing when a domain is disabled', () => {
    const seeded = seed()
    const bridge = bridgeFor(seeded, true)
    seeded.store.setDomainEnabled(ORG, false, NOW)
    const company = recall(bridge, 'git:company')!
    expect([...company.rows, ...company.newRows].map(row => row.id).sort((a, b) => a - b)).toEqual([1, 3, 7])
    expect(bridge.maxMemoryId('git:company')).toBe(7)
  })

  it('an unconfigured adapter answers "no opinion" and resolves no peers', () => {
    // Post-cutover semantics: `undefined` from the resolver (no enabled domain
    // at all) means NO peers — the old workspace-table fallback died with the
    // shared store. Sharing must be configured, not inherited.
    const seeded = seed()
    seeded.store.setDomainEnabled(ORG, false, NOW)
    seeded.store.setDomainEnabled(MACHINE, false, NOW)

    const empty = openStores(tempDir())
    opened.push(empty)
    const bridge = openMemoryBridge({
      dbPath: seeded.contractPath,
      logger,
      domainResolver: (identity) => (empty.listDomains().every(domain => !domain.enabled)
        ? undefined
        : empty.activeDomainIdentities(identity)),
    })
    expect(bridge.searchSpace('git:company')!.foreignIdentities).toEqual([])
  })
})
