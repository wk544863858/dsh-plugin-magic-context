/**
 * Schema v8 — the global-domain substrate (WP1 of the execution plan).
 *
 * Four things are asserted, and each one exists because getting it wrong is
 * silent rather than loud:
 *
 *  1. UPGRADE: a v7 store keeps its rows when it becomes v8. The migration is
 *     additive, so nothing may be dropped or rewritten.
 *  2. FAIL-CLOSED: a store newer than this build refuses to open instead of
 *     guessing at columns it does not know.
 *  3. CONSTRAINTS: every closed vocabulary (`kind`, candidate/confirmation
 *     `state`) is enforced by the DATABASE, not only by the caller's types —
 *     a bad write from a future code path must fail at the disk.
 *  4. SEMANTICS: the recurrence weight is computed from observation rows (never
 *     accepted from a caller), the confirmation queue is idempotent per
 *     candidate, and activation only ever returns ENABLED domains the identity
 *     actually belongs to.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import { SCHEMA_VERSION, StoreAheadOfAdapterError } from '../src/core/stores.ts'
import { defaultDomainCap, deriveDomainCap, domainIdentity } from '../src/core/domains.ts'

const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stores-v8-'))
  dirs.push(dir)
  return dir
}

/** Open a store that afterEach will close, so a failed assertion cannot leave
 *  a SQLite handle behind (which surfaces as a misleading EPERM on cleanup). */
function openStore(dir: string): ReturnType<typeof openStores> {
  const store = openStores(dir)
  opened.push(store)
  return store
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop()!.close()
    } catch {
      // already closed / closed by the test — the handle is what matters
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

const NOW = 1_700_000_000_000

function seedDomain(store: ReturnType<typeof openStores>, kind: 'user' | 'org' | 'machine', enabled: boolean) {
  const domainId = domainIdentity(kind)
  store.upsertDomain(
    {
      domainId,
      kind,
      enabled,
      budgetTokens: 800,
      cap: defaultDomainCap(kind),
      shareCategories: ['CONSTRAINTS', 'ARCHITECTURE'],
    },
    NOW,
  )
  return domainId
}

describe('schema v8 migration', () => {
  it('is the current version and upgrades a v7 store without losing rows', () => {
    const dir = tempDir()
    const store = openStore(dir)
    expect(SCHEMA_VERSION).toBe(9)
    store.allocateTag('s1', { kind: 'user-message', messageId: 'm1' }, NOW)
    store.saveBaselineState({
      sessionId: 's1',
      epoch: 3,
      frozenAt: NOW,
      maxMemoryId: 42,
      updatedAt: NOW,
    })
    store.close()

    // Rewind to the v7 shape: drop what v8 added, restore the old version stamp.
    const dbPath = join(dir, 'dsh-magic-context.db')
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      DROP TABLE profile_confirmations;
      DROP TABLE global_candidate_observations;
      DROP TABLE global_candidates;
      DROP TABLE domain_members;
      DROP TABLE domains;
      ALTER TABLE baseline_state DROP COLUMN profile_watermark;
      ALTER TABLE baseline_state DROP COLUMN profile_m0_digest;
      UPDATE meta SET value = '7' WHERE key = 'schema_version';
    `)
    raw.close()

    const upgraded = openStore(dir)
    // Pre-existing rows survived the upgrade...
    expect(upgraded.getTag('s1', { kind: 'user-message', messageId: 'm1' })).toBe(1)
    const baseline = upgraded.baselineState('s1')
    expect(baseline?.maxMemoryId).toBe(42)
    expect(baseline?.epoch).toBe(3)
    // ...and the v8 surface exists.
    expect(upgraded.listDomains()).toEqual([])
    expect(upgraded.listProfileConfirmations()).toEqual([])
    upgraded.saveBaselineState({ ...baseline!, profileWatermark: 7, profileM0Digest: 'digest' })
    expect(upgraded.baselineState('s1')?.profileWatermark).toBe(7)
    expect(upgraded.baselineState('s1')?.profileM0Digest).toBe('digest')
    upgraded.close()
  })

  it('refuses to open a store newer than this build', () => {
    const dir = tempDir()
    const store = openStore(dir)
    store.close()
    const dbPath = join(dir, 'dsh-magic-context.db')
    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run()
    raw.close()
    expect(() => openStores(dir)).toThrow(StoreAheadOfAdapterError)
  })

  it('carries the v9 candidate metadata through the store API', () => {
    const store = openStore(tempDir())
    const domainId = seedDomain(store, 'org', true)
    const candidate = store.upsertGlobalCandidate(
      {
        domainId,
        content: 'org-level rule',
        normalizedHash: 'hash-v9',
        firstIdentity: 'git:a',
        category: 'CONSTRAINTS',
        sourceMemoryId: 4242,
      },
      NOW,
    )
    expect(candidate.category).toBe('CONSTRAINTS')
    expect(candidate.sourceMemoryId).toBe(4242)
    // A later sighting that carries no metadata must not erase what is recorded.
    store.upsertGlobalCandidate(
      { domainId, content: 'org-level rule', normalizedHash: 'hash-v9', firstIdentity: 'git:b' },
      NOW + 1,
    )
    const reread = store.listGlobalCandidates({ domainId })[0]!
    expect(reread.category).toBe('CONSTRAINTS')
    expect(reread.sourceMemoryId).toBe(4242)
    store.close()
  })
})

describe('schema v8 constraints', () => {
  it('rejects an unknown domain kind and an unknown candidate state at the database', () => {
    const dir = tempDir()
    const store = openStore(dir)
    seedDomain(store, 'org', true)
    store.close()

    const raw = new DatabaseSync(join(dir, 'dsh-magic-context.db'))
    expect(() => raw.exec(
      "INSERT INTO domains(domain_id, kind, enabled, budget_tokens, cap, created_at, updated_at) "
        + "VALUES('dir:global:vendor', 'vendor', 1, 100, 4, 1, 1)",
    )).toThrow(/CHECK/)
    expect(() => raw.exec(
      "INSERT INTO global_candidates(domain_id, content, normalized_hash, first_identity, distinct_identities, "
        + "observation_count, state, created_at, updated_at) "
        + "VALUES('dir:global:org', 'x', 'h', 'id', 1, 1, 'maybe', 1, 1)",
    )).toThrow(/CHECK/)
    expect(() => raw.exec(
      "INSERT INTO profile_confirmations(contract_candidate_id, question, content, state, created_at) "
        + "VALUES(1, 'q', 'c', 'half', 1)",
    )).toThrow(/CHECK/)
    raw.close()
  })

  it('cascades domain members away with their domain', () => {
    const dir = tempDir()
    const store = openStore(dir)
    const domainId = seedDomain(store, 'org', true)
    store.addDomainMember(domainId, 'git:aaa', NOW)
    expect(store.listDomainMembers(domainId)).toHaveLength(1)
    store.close()

    const raw = new DatabaseSync(join(dir, 'dsh-magic-context.db'))
    raw.exec('PRAGMA foreign_keys = ON')
    raw.prepare('DELETE FROM domains WHERE domain_id = ?').run(domainId)
    raw.close()

    const reopened = openStore(dir)
    expect(reopened.listDomainMembers(domainId)).toEqual([])
    reopened.close()
  })
})

describe('domains', () => {
  it('returns only enabled domains the identity actually belongs to', () => {
    const store = openStore(tempDir())
    const org = seedDomain(store, 'org', true)
    const machine = seedDomain(store, 'machine', true)
    const user = seedDomain(store, 'user', false)
    store.addDomainMember(org, 'git:company', NOW)
    store.addDomainMember(machine, 'git:company', NOW)
    store.addDomainMember(user, 'git:company', NOW)
    store.addDomainMember(org, 'git:opensource', NOW)

    expect(store.activeDomainIdentities('git:company').map(d => d.kind).sort()).toEqual(['machine', 'org'])
    expect(store.activeDomainIdentities('git:opensource').map(d => d.kind)).toEqual(['org'])
    expect(store.activeDomainIdentities('git:stranger')).toEqual([])

    store.setDomainEnabled(machine, false, NOW)
    expect(store.activeDomainIdentities('git:company').map(d => d.kind)).toEqual(['org'])
    expect(store.getDomain(machine)?.enabled).toBe(false)
    expect(store.listDomains().map(d => d.kind)).toEqual(['machine', 'org', 'user'])
    // The allowlist round-trips through the fail-closed parser.
    expect(store.getDomain(org)?.shareCategories).toEqual(['ARCHITECTURE', 'CONSTRAINTS'])
    store.close()
  })
})

describe('global candidates', () => {
  it('folds one normalized hash into one candidate and derives recurrence from observations', () => {
    const store = openStore(tempDir())
    const org = seedDomain(store, 'org', true)

    const first = store.upsertGlobalCandidate(
      { domainId: org, content: 'DB access goes through the bastion', normalizedHash: 'h1', firstIdentity: 'git:a', sessionId: 's1' },
      NOW,
    )
    expect(first.distinctIdentities).toBe(0)
    store.recordCandidateObservation({ candidateId: first.id, identity: 'git:a', sessionId: 's1', compartmentStart: 1, compartmentEnd: 9 }, NOW)

    const second = store.upsertGlobalCandidate(
      { domainId: org, content: 'DB access goes through the bastion', normalizedHash: 'h1', firstIdentity: 'git:b', sessionId: 's2' },
      NOW + 1,
    )
    expect(second.id).toBe(first.id)
    store.recordCandidateObservation({ candidateId: first.id, identity: 'git:b', sessionId: 's2' }, NOW + 1)
    // Same identity, same session again: weight grows, the DISTINCT count does not.
    store.recordCandidateObservation({ candidateId: first.id, identity: 'git:a', sessionId: 's1' }, NOW + 2)

    const row = store.getGlobalCandidate(first.id)!
    expect(row.distinctIdentities).toBe(2)
    expect(row.observationCount).toBe(3)
    expect(store.listCandidateObservations(first.id).map(o => `${o.identity}/${o.observations}`)).toEqual(['git:a/2', 'git:b/1'])
    expect(store.listGlobalCandidates({ domainId: org, state: 'pending' })).toHaveLength(1)

    store.setGlobalCandidateState(first.id, 'rejected', NOW + 3)
    expect(store.listGlobalCandidates({ state: 'pending' })).toEqual([])
    expect(store.listGlobalCandidates({ state: 'rejected' })).toHaveLength(1)
    store.close()
  })

  it('reopens an expired candidate when it is observed again', () => {
    const store = openStore(tempDir())
    const machine = seedDomain(store, 'machine', true)
    const row = store.upsertGlobalCandidate(
      { domainId: machine, content: 'uv is preferred', normalizedHash: 'h2', firstIdentity: 'git:a' },
      NOW,
    )
    store.setGlobalCandidateState(row.id, 'expired', NOW + 1)
    store.upsertGlobalCandidate(
      { domainId: machine, content: 'uv is preferred', normalizedHash: 'h2', firstIdentity: 'git:a' },
      NOW + 2,
    )
    expect(store.getGlobalCandidate(row.id)?.state).toBe('pending')
    store.close()
  })
})

describe('profile confirmations', () => {
  it('is idempotent per pending candidate and records the decision', () => {
    const store = openStore(tempDir())
    const a = store.enqueueProfileConfirmation(
      { contractCandidateId: 7, question: 'always run the tests?', content: 'always run the tests' },
      NOW,
    )
    const b = store.enqueueProfileConfirmation(
      { contractCandidateId: 7, question: 'always run the tests?', content: 'always run the tests' },
      NOW + 1,
    )
    expect(b.id).toBe(a.id)
    expect(store.listProfileConfirmations('pending')).toHaveLength(1)

    store.decideProfileConfirmation(a.id, 'approved', NOW + 2)
    const decided = store.listProfileConfirmations('approved')[0]!
    expect(decided.id).toBe(a.id)
    expect(decided.decidedAt).toBe(NOW + 2)
    expect(store.listProfileConfirmations('pending')).toEqual([])

    // A NEW observation of the same contract candidate may ask again.
    const c = store.enqueueProfileConfirmation(
      { contractCandidateId: 7, question: 'again?', content: 'again' },
      NOW + 3,
    )
    expect(c.id).not.toBe(a.id)
    store.close()
  })
})

describe('domain caps', () => {
  it('derives the cap from a token target instead of accepting a picked number', () => {
    expect(deriveDomainCap(750)).toBe(30)
    expect(deriveDomainCap(768)).toBe(30)
    expect(deriveDomainCap(500)).toBe(20)
    expect(deriveDomainCap(0)).toBe(1)
    expect(deriveDomainCap(-5)).toBe(1)
    expect(deriveDomainCap(Number.NaN)).toBe(1)
    expect(deriveDomainCap(Number.POSITIVE_INFINITY)).toBe(1)
    expect(defaultDomainCap('user')).toBe(30)
    expect(defaultDomainCap('org')).toBe(30)
    expect(defaultDomainCap('machine')).toBe(20)
    expect(domainIdentity('org')).toBe('dir:global:org')
  })
})
