/**
 * D-3 — the domain lane's own judges, proven by their negative controls.
 *
 * The doctor's section 6 and the acceptance domain items used to be inline code
 * run against the live adapter DB: that can show "nothing is broken right now",
 * and nothing more. The point of this file is the other direction — **break it on
 * purpose and require the alarm** (本仓纪律 ④ 判据先自证). Every WARN the doctor
 * can print has a case here where it fires, and a case where it stays silent.
 *
 * The judges live in `scripts/domain-checks.mjs` as pure functions over an open
 * database handle, so a synthetic store is a complete input — no live DB, no
 * filesystem state, no clock.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptanceDomainItems,
  BACKLOG_THRESHOLDS,
  doctorDomainFindings,
  enabledDomainsWithoutMembers,
  readDomainSummary,
  readProfilePool,
} from '../scripts/domain-checks.mjs'
import { defaultDomainCap } from '../src/core/domains.ts'
import { openStores } from '../src/index.ts'

const NOW = 1_700_000_000_000
const ORG = 'dir:global:org'
const USER = 'dir:global:user'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      // never mask the assertion that failed
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-domain-checks-'))
  dirs.push(dir)
  return dir
}

/** A migrated store with the tables but no rows: configured-nothing, not unmigrated. */
function emptyAdapterDb(): DatabaseSync {
  const stores = openStores(tempDir())
  const path = stores.dbPath
  stores.close()
  return new DatabaseSync(path, { readOnly: true })
}

type Seed = {
  readonly enabled?: boolean
  readonly members?: number
  readonly confirmations?: number
  readonly candidates?: number
  /** How old the seeded pending candidates are, in days (drives the red line). */
  readonly candidateAgeDays?: number
  readonly profiles?: number
  readonly withUserTable?: boolean
}

/**
 * A real adapter store (so the schema is the product's, not a hand-written
 * approximation), seeded through the product's own writers, then handed to the
 * judges as a plain database handle — the same thing the scripts receive.
 */
function adapterDb(seed: Seed = {}): DatabaseSync {
  const dir = tempDir()
  const stores = openStores(dir)
  try {
    stores.upsertDomain(
      {
        domainId: ORG,
        kind: 'org',
        enabled: seed.enabled ?? false,
        budgetTokens: 768,
        cap: defaultDomainCap('org'),
        shareCategories: ['CONSTRAINTS'],
      },
      NOW,
    )
    for (let i = 0; i < (seed.members ?? 0); i += 1) stores.addDomainMember(ORG, `git:member${String(i)}`, NOW)
    const db = new DatabaseSync(stores.dbPath)
    for (let i = 0; i < (seed.confirmations ?? 0); i += 1) {
      db.prepare(
        `INSERT INTO profile_confirmations (contract_candidate_id, content, question, state, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      ).run(1000 + i, `rule ${String(i)}`, `confirm ${String(i)}?`, NOW)
    }
    const candidateCreatedAt = NOW - (seed.candidateAgeDays ?? 0) * 86_400_000
    for (let i = 0; i < (seed.candidates ?? 0); i += 1) {
      db.prepare(
        `INSERT INTO global_candidates (domain_id, content, normalized_hash, first_identity, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(ORG, `candidate ${String(i)}`, `hash-${String(i)}`, 'git:member0', candidateCreatedAt, NOW)
    }
    if (seed.withUserTable !== false) {
      // The contract's table, simulated where the judges can see it.
      db.exec('CREATE TABLE IF NOT EXISTS user_memories (id INTEGER PRIMARY KEY, status TEXT, updated_at INTEGER)')
      for (let i = 0; i < (seed.profiles ?? 0); i += 1) {
        db.prepare("INSERT INTO user_memories (status, updated_at) VALUES ('active', ?)").run(NOW)
      }
    }
    db.close()
    return new DatabaseSync(stores.dbPath, { readOnly: true })
  } finally {
    stores.close()
  }
}

const levelsOf = (findings: readonly { level: string; text: string }[]) => findings.map((finding) => finding.level)
const textsOf = (findings: readonly { level: string; text: string }[]) => findings.map((finding) => finding.text).join('\n')
const itemOf = (items: readonly { id: string }[], id: string) => items.find((item) => item.id === id)

describe('readDomainSummary', () => {
  it('reads the domains and their member counts', () => {
    const db = adapterDb({ enabled: true, members: 3, profiles: 2 })
    const summary = readDomainSummary(db)
    expect(summary.present).toBe(true)
    expect(summary.domains).toEqual([
      { id: ORG, kind: 'org', enabled: true, budget: 768, cap: defaultDomainCap('org'), members: 3 },
    ])
    db.close()
  })

  it('does NOT answer the profile pool — that lives in the contract store', () => {
    // The first version of this check read `user_memories` off the ADAPTER db and
    // therefore warned "no profile table" against a store that never has one.
    // The seam is now explicit: adapter facts here, contract facts in
    // readProfilePool. This case pins the separation.
    const adapter = adapterDb({ enabled: true, members: 1, profiles: 5 })
    expect(readDomainSummary(adapter)).not.toHaveProperty('activeProfiles')
    expect(readDomainSummary(adapter)).not.toHaveProperty('profileTable')
    // The simulated contract table is invisible to the adapter-side read...
    expect(readProfilePool(adapter).active).toBe(5)
    adapter.close()

    // ...and no contract handle is reported as unknown, not as an empty pool.
    expect(readProfilePool(undefined)).toBeNull()
    expect(readProfilePool(null)).toBeNull()
  })

  it('reports an absent schema instead of pretending there are zero domains', () => {
    // Negative control for the whole section: a database with no domain tables
    // must be distinguishable from "the tables are there and empty" — otherwise
    // a pre-v8 store would read as a healthy, unused lane.
    const dir = tempDir()
    const path = join(dir, 'bare.db')
    const bare = new DatabaseSync(path)
    bare.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    bare.close()

    const db = new DatabaseSync(path, { readOnly: true })
    const summary = readDomainSummary(db)
    expect(summary.present).toBe(false)
    expect(summary.domains).toEqual([])
    expect(summary.pendingConfirmations).toBe(0)
    expect(summary.pendingCandidates).toBe(0)
    expect(readProfilePool(db)).toEqual({ table: false, active: 0 })
    db.close()
  })

  it('tolerates a domain table whose columns are wrong, instead of throwing', () => {
    // A half-migrated store must not take the doctor down with it.
    const dir = tempDir()
    const path = join(dir, 'partial.db')
    const partial = new DatabaseSync(path)
    partial.exec('CREATE TABLE domains (domain_id TEXT PRIMARY KEY)')
    partial.close()

    const db = new DatabaseSync(path, { readOnly: true })
    expect(() => readDomainSummary(db)).not.toThrow()
    expect(readDomainSummary(db).domains).toEqual([])
    db.close()
  })
})

describe('doctorDomainFindings — every warning has a trigger and a silence', () => {
  it('warns when the store predates schema v8', () => {
    const dir = tempDir()
    const path = join(dir, 'bare.db')
    const bare = new DatabaseSync(path)
    bare.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    bare.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const findings = doctorDomainFindings(db)
    expect(levelsOf(findings)).toEqual(['warn'])
    expect(textsOf(findings)).toContain('schema < v8')
    db.close()
  })

  it('warns when no domain is configured, and stops warning once one exists', () => {
    const bare = emptyAdapterDb()
    expect(textsOf(doctorDomainFindings(bare))).toContain('没有任何全局域')
    bare.close()

    const configured = adapterDb({ members: 1 })
    expect(textsOf(doctorDomainFindings(configured))).not.toContain('没有任何全局域')
    configured.close()
  })

  it('warns only when EVERY domain is disabled', () => {
    const off = adapterDb({ enabled: false, members: 1 })
    expect(textsOf(doctorDomainFindings(off))).toContain('全部域停用')
    off.close()

    const on = adapterDb({ enabled: true, members: 1 })
    const findings = doctorDomainFindings(on)
    expect(textsOf(findings)).not.toContain('全部域停用')
    // ...and the enabled domain is the one line that gets the ✓.
    expect(levelsOf(findings)).toContain('ok')
    on.close()
  })

  it('warns when a domain is enabled but has no members at all', () => {
    // The trap this catches: enabling a domain whose member import silently
    // failed. It looks configured and sees nothing.
    const orphan = adapterDb({ enabled: true, members: 0 })
    expect(textsOf(doctorDomainFindings(orphan))).toContain('已启用却没有任何成员')
    orphan.close()

    const healthy = adapterDb({ enabled: true, members: 1 })
    expect(textsOf(doctorDomainFindings(healthy))).not.toContain('已启用却没有任何成员')
    healthy.close()
  })

  it('warns on a pending confirmation backlog, and not below it', () => {
    const quiet = adapterDb({ members: 1, confirmations: 1 })
    expect(textsOf(doctorDomainFindings(quiet))).toContain('画像确认队列待确认 1 条')
    expect(textsOf(doctorDomainFindings(quiet))).not.toContain('⚠')
    quiet.close()

    const noisy = adapterDb({ members: 1, confirmations: 2 })
    expect(textsOf(doctorDomainFindings(noisy))).toContain('（/ctx-profile list）')
    expect(levelsOf(doctorDomainFindings(noisy))).toContain('warn')
    noisy.close()
  })

  it('warns on a pending candidate backlog, and not when the queue is empty', () => {
    const clear = adapterDb({ members: 1 })
    const clearText = textsOf(doctorDomainFindings(clear))
    expect(clearText).toContain('全局候选待定 0 条')
    expect(clearText).not.toContain('（/ctx-global candidates）')
    clear.close()

    const backed = adapterDb({ members: 1, candidates: 3 })
    expect(textsOf(doctorDomainFindings(backed))).toContain('（/ctx-global candidates）')
    backed.close()
  })
})

describe('acceptanceDomainItems — paired positive and negative for each claim', () => {
  it('fails the schema item on a store that has no domain tables', () => {
    const dir = tempDir()
    const path = join(dir, 'bare.db')
    const bare = new DatabaseSync(path)
    bare.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    bare.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const item = itemOf(acceptanceDomainItems(db), 'domain.schema')
    expect(item?.level).toBe('FAIL')
    expect(item?.detail).toContain('未到 v8')
    db.close()
  })

  it('passes the schema item on a migrated store, and reports the domain count', () => {
    const db = adapterDb({ members: 1 })
    const item = itemOf(acceptanceDomainItems(db), 'domain.schema')
    expect(item?.level).toBe('PASS')
    expect(item?.detail).toContain('1 个域')
    db.close()
  })

  it('warns about members only when every domain has none', () => {
    const none = adapterDb({ members: 0 })
    expect(itemOf(acceptanceDomainItems(none), 'domain.members')?.level).toBe('WARN')
    none.close()

    const some = adapterDb({ members: 2 })
    const item = itemOf(acceptanceDomainItems(some), 'domain.members')
    expect(item?.level).toBe('PASS')
    expect(item?.detail).toContain(`${ORG}=2`)
    some.close()
  })

  it('warns about activation only when every domain is off', () => {
    const off = adapterDb({ enabled: false, members: 1 })
    expect(itemOf(acceptanceDomainItems(off), 'domain.enabled')?.level).toBe('WARN')
    off.close()

    const on = adapterDb({ enabled: true, members: 1 })
    expect(itemOf(acceptanceDomainItems(on), 'domain.enabled')?.level).toBe('PASS')
    on.close()
  })

  it('warns about an enabled domain with zero members, and names it', () => {
    const orphan = adapterDb({ enabled: true, members: 0 })
    const item = itemOf(acceptanceDomainItems(orphan), 'domain.enabled-without-members')
    expect(item?.level).toBe('WARN')
    expect(item?.detail).toContain(ORG)
    orphan.close()

    const healthy = adapterDb({ enabled: false, members: 0 })
    expect(itemOf(acceptanceDomainItems(healthy), 'domain.enabled-without-members')?.level).toBe('PASS')
    healthy.close()
  })

  it('warns about backlogs strictly above the early thresholds', () => {
    const atThreshold = adapterDb({
      members: 1,
      confirmations: BACKLOG_THRESHOLDS.early.confirmations,
      candidates: BACKLOG_THRESHOLDS.early.candidates,
    })
    const items = acceptanceDomainItems(atThreshold, null, NOW)
    expect(itemOf(items, 'domain.confirmation-backlog')?.level).toBe('PASS')
    expect(itemOf(items, 'domain.candidate-backlog')?.level).toBe('PASS')
    atThreshold.close()

    const over = adapterDb({
      members: 1,
      confirmations: BACKLOG_THRESHOLDS.early.confirmations + 1,
      candidates: BACKLOG_THRESHOLDS.early.candidates + 1,
    })
    const overItems = acceptanceDomainItems(over, null, NOW)
    expect(itemOf(overItems, 'domain.confirmation-backlog')?.level).toBe('WARN')
    expect(itemOf(overItems, 'domain.candidate-backlog')?.level).toBe('WARN')
    expect(itemOf(overItems, 'domain.confirmation-backlog')?.detail).toContain('/ctx-profile list')
    expect(itemOf(overItems, 'domain.candidate-backlog')?.detail).toContain('/ctx-global candidates')
    // A deep-but-careless queue is still only a nudge: depth alone never trips the red line.
    expect(itemOf(overItems, 'domain.candidate-redline')?.level).toBe('PASS')
    over.close()
  })

  it('reads the age of the OLDEST pending candidate, and null when there is none', () => {
    const empty = adapterDb({ members: 1 })
    expect(readDomainSummary(empty, NOW).pendingCandidateAgeDays).toBeNull()
    empty.close()

    // Three rows seeded 9 days back: the age is the OLDEST, not the newest.
    const aged = adapterDb({ members: 1, candidates: 3, candidateAgeDays: 9 })
    expect(readDomainSummary(aged, NOW).pendingCandidateAgeDays).toBe(9)
    aged.close()

    // A fresh queue is 0 days old, not "no data": 0 must not read as null.
    const fresh = adapterDb({ members: 1, candidates: 1 })
    expect(readDomainSummary(fresh, NOW).pendingCandidateAgeDays).toBe(0)
    fresh.close()
  })

  it('fires the design red line only on deep AND old — both axes carry a negative control', () => {
    const redLine = BACKLOG_THRESHOLDS.redLine

    // deep but fresh: a queue filling faster than it drains, nobody stuck
    const deepFresh = adapterDb({ members: 1, candidates: redLine.candidates + 1, candidateAgeDays: redLine.ageDays - 1 })
    const deepFreshItem = itemOf(acceptanceDomainItems(deepFresh, null, NOW), 'domain.candidate-redline')
    expect(deepFreshItem?.level).toBe('PASS')
    expect(deepFreshItem?.detail).toContain('未越红线')
    deepFresh.close()

    // old but shallow: one stubborn item, not a degenerating pool
    const oldShallow = adapterDb({ members: 1, candidates: 30, candidateAgeDays: 30 })
    expect(itemOf(acceptanceDomainItems(oldShallow, null, NOW), 'domain.candidate-redline')?.level).toBe('PASS')
    oldShallow.close()

    // exactly at the depth threshold is still PASS: the comparison is strict
    const atDepth = adapterDb({ members: 1, candidates: redLine.candidates, candidateAgeDays: 30 })
    expect(itemOf(acceptanceDomainItems(atDepth, null, NOW), 'domain.candidate-redline')?.level).toBe('PASS')
    atDepth.close()

    // deep AND old: "must handle", and the detail says so plus how to drain it
    const over = adapterDb({ members: 1, candidates: redLine.candidates + 1, candidateAgeDays: redLine.ageDays + 1 })
    const overItems = acceptanceDomainItems(over, null, NOW)
    const overItem = itemOf(overItems, 'domain.candidate-redline')
    expect(overItem?.level).toBe('FAIL')
    expect(overItem?.detail).toContain('必须处理')
    expect(overItem?.detail).toContain('/ctx-global candidates')
    expect(overItem?.evidence).toMatchObject({ pending: redLine.candidates + 1, oldestDays: redLine.ageDays + 1 })
    over.close()
  })

  it('warns about an empty profile pool and about a contract with no profile table', () => {
    const missing = adapterDb({ members: 1, withUserTable: false })
    const missingItem = itemOf(acceptanceDomainItems(missing, missing), 'domain.profile-pool')
    expect(missingItem?.level).toBe('WARN')
    expect(missingItem?.detail).toContain('user_memories')
    missing.close()

    const emptyPool = adapterDb({ members: 1, profiles: 0 })
    expect(itemOf(acceptanceDomainItems(emptyPool, emptyPool), 'domain.profile-pool')?.level).toBe('WARN')
    emptyPool.close()

    const stocked = adapterDb({ members: 1, profiles: 14 })
    const stockedItem = itemOf(acceptanceDomainItems(stocked, stocked), 'domain.profile-pool')
    expect(stockedItem?.level).toBe('PASS')
    expect(stockedItem?.detail).toContain('14 行')
    stocked.close()
  })

  it('says the pool is unknown — not empty — when the contract handle is missing', () => {
    // The distinction matters: "no profile rows" is a real finding, "the contract
    // database did not open" is a different one, and blanket-answering the second
    // as the first is what produced the false alarm this seam fixed.
    const db = adapterDb({ members: 1, profiles: 5 })
    const item = itemOf(acceptanceDomainItems(db, null), 'domain.profile-pool')
    expect(item?.level).toBe('WARN')
    expect(item?.detail).toContain('契约库未打开')
    db.close()
  })

  it('returns the same number of items in every state, so the report never shrinks', () => {
    // A verdict that quietly loses rows when the store is broken would turn a
    // failure into a shorter report instead of a louder one.
    const bare = new DatabaseSync(join(tempDir(), 'bare2.db'))
    bare.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    const bareCount = acceptanceDomainItems(bare, bare).length
    bare.close()

    const full = adapterDb({ enabled: true, members: 1, profiles: 1 })
    expect(acceptanceDomainItems(full, full)).toHaveLength(bareCount)
    full.close()

    expect(acceptanceDomainItems(full, null)).toHaveLength(bareCount)
  })

  it('every item carries a level, an id, a detail and evidence', () => {
    const db = adapterDb({ enabled: true, members: 1, profiles: 1 })
    for (const item of acceptanceDomainItems(db, db)) {
      expect(['PASS', 'WARN', 'FAIL']).toContain(item.level)
      expect(item.id).toMatch(/^domain\./)
      expect(typeof item.detail).toBe('string')
      expect(item.detail.length).toBeGreaterThan(0)
      expect(item.evidence).toBeTypeOf('object')
    }
    db.close()
  })
})

describe('enabledDomainsWithoutMembers', () => {
  it('selects exactly the enabled, memberless domains', () => {
    expect(enabledDomainsWithoutMembers({ domains: [] } as never)).toEqual([])
    expect(
      enabledDomainsWithoutMembers({
        domains: [
          { id: 'a', kind: 'org', enabled: true, budget: 1, cap: 1, members: 0 },
          { id: 'b', kind: 'org', enabled: true, budget: 1, cap: 1, members: 2 },
          { id: 'c', kind: 'user', enabled: false, budget: 1, cap: 1, members: 0 },
        ],
      } as never).map((domain) => domain.id),
    ).toEqual(['a'])
  })
})
