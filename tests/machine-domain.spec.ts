/**
 * WP10 — the `machine` domain.
 *
 * It is a domain like any other (same identity shape, same peer lane, same cap
 * derivation), so most of what matters here is not the plumbing but the two
 * rules that decide WHO is inside it:
 *
 *  - **membership is added, never inferred away.** The identities a process has
 *    seen are a partial view, so "not seen" must never mean "removed"; only an
 *    explicit exclusion removes a member. Getting this wrong would drop a
 *    colleague's project from the domain because nobody opened it this hour.
 *  - **off is reversible and non-destructive.** Disabling flips a flag and keeps
 *    the membership, so turning it back on restores exactly what was there.
 *
 * The last block is the one that would catch a real leak: org and machine rows
 * are published under different identities, and a project inside one domain must
 * not see the other's rows. Two domains leaking into each other would be a
 * silent widening of visibility, which is the one failure this whole design is
 * built to prevent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDomainCap, domainIdentity } from '../src/core/domains.ts'
import { planMachineDomain, syncMachineDomain } from '../src/core/machine-domain.ts'
import { openMemoryBridge } from '../src/core/memory-bridge.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { openStores } from '../src/index.ts'
import { makeDomainResolver } from '../src/dsh/memory-lane.ts'
import { makeMemoryDb } from './helpers/memory-db'

const NOW = 1_700_000_000_000
const MACHINE = domainIdentity('machine')
const ORG = domainIdentity('org')
const A = 'git:aaaa1111'
const B = 'git:bbbb2222'
const OUTSIDER = 'git:cccc3333'
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

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-machine-'))
  dirs.push(dir)
  const stores = openStores(dir)
  closers.push(stores)
  return stores
}

function contractDb(): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-machine-db-',
    schemaVersion: 94,
    mutationLog: true,
    projectState: true,
    fts: true,
  })
  dirs.push(dir)
  return path
}

describe('planMachineDomain — pure membership rules', () => {
  it('touches nothing while the switch is off', () => {
    const plan = planMachineDomain({
      identities: [A, B],
      existingMembers: [A],
      config: { enabled: false },
    })
    expect(plan.enabled).toBe(false)
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.changed).toBe(false)
  })

  it('adds every seen project while on', () => {
    const plan = planMachineDomain({
      identities: [A, B],
      existingMembers: [A],
      config: { enabled: true },
    })
    expect(plan.add).toEqual([B])
    expect(plan.members).toEqual([A, B].sort())
    expect(plan.changed).toBe(true)
  })

  it('never removes a member just because it has not been seen', () => {
    // The partial-view rule: B is a member the current process has not served.
    const plan = planMachineDomain({
      identities: [A],
      existingMembers: [A, B],
      config: { enabled: true },
    })
    expect(plan.remove).toEqual([])
    expect(plan.members).toEqual([A, B].sort())
    expect(plan.changed).toBe(false)
  })

  it('removes exactly the excluded members and never adds them', () => {
    const plan = planMachineDomain({
      identities: [A, B, OUTSIDER],
      existingMembers: [A, OUTSIDER],
      config: { enabled: true, excludeProjects: [OUTSIDER] },
    })
    expect(plan.add).toEqual([B])
    expect(plan.remove).toEqual([OUTSIDER])
    expect(plan.members).toEqual([A, B].sort())
  })

  it('is idempotent and de-duplicated', () => {
    const plan = planMachineDomain({
      identities: [A, A, B],
      existingMembers: [B, A],
      config: { enabled: true },
    })
    expect(plan.changed).toBe(false)
    expect(plan.members).toEqual([A, B].sort())
  })
})

describe('syncMachineDomain — the store side', () => {
  it('leaves no row at all while it has never been enabled', () => {
    const stores = store()
    const plan = syncMachineDomain(stores, { identities: [A], config: {}, now: NOW })
    expect(plan.changed).toBe(false)
    expect(stores.getDomain(MACHINE)).toBeUndefined()
    expect(stores.listDomains()).toEqual([])
  })

  it('creates the domain with the derived cap and the machine birth allowlist', () => {
    const stores = store()
    const plan = syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    expect(plan.add).toEqual([A, B].sort())
    const domain = stores.getDomain(MACHINE)
    expect(domain?.kind).toBe('machine')
    expect(domain?.enabled).toBe(true)
    expect(domain?.cap).toBe(defaultDomainCap('machine'))
    // Birth allowlist, widened 2026-10-12: native machine facts are
    // CONFIG_VALUES/ARCHITECTURE rows; scope stays the v2 five share
    // categories (ENVIRONMENT is a decay class, not a share class).
    // Serialized order is the store's localeCompare normalization.
    expect(domain?.shareCategories).toEqual(['ARCHITECTURE', 'CONFIG_VALUES', 'CONSTRAINTS'])
    expect(stores.listDomainMembers(MACHINE).map(member => member.identity).sort()).toEqual([A, B].sort())
  })

  it('never overwrites a hand-edited allowlist on later syncs', () => {
    const stores = store()
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    stores.upsertDomain({
      domainId: MACHINE,
      kind: 'machine',
      enabled: true,
      budgetTokens: 512,
      cap: defaultDomainCap('machine'),
      shareCategories: ['CONSTRAINTS'],
    }, NOW + 1_000)
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: false }, now: NOW + 2_000 })
    const back = syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW + 3_000 })
    expect(back.enabled).toBe(true)
    expect(stores.getDomain(MACHINE)?.shareCategories).toEqual(['CONSTRAINTS'])
  })

  it('writes nothing the second time', () => {
    const stores = store()
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    const second = syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW + 5_000 })
    expect(second.changed).toBe(false)
    expect(stores.listDomainMembers(MACHINE)).toHaveLength(2)
  })

  it('applies an exclusion to an existing member', () => {
    const stores = store()
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    const plan = syncMachineDomain(stores, {
      identities: [A, B],
      config: { enabled: true, excludeProjects: [B] },
      now: NOW + 1_000,
    })
    expect(plan.remove).toEqual([B])
    expect(stores.listDomainMembers(MACHINE).map(member => member.identity)).toEqual([A])
  })

  it('turns off reversibly: the flag moves, the membership stays', () => {
    const stores = store()
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: false }, now: NOW + 1_000 })
    expect(stores.getDomain(MACHINE)?.enabled).toBe(false)
    expect(stores.listDomainMembers(MACHINE)).toHaveLength(2)

    // Back on: nothing to re-add, which is what "reversible" has to mean.
    const back = syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW + 2_000 })
    expect(back.changed).toBe(false)
    expect(stores.getDomain(MACHINE)?.enabled).toBe(true)
    expect(stores.listDomainMembers(MACHINE)).toHaveLength(2)
  })

  it('keeps a hand-edited cap and allowlist across a sync', () => {
    const stores = store()
    syncMachineDomain(stores, { identities: [A], config: { enabled: true }, now: NOW })
    stores.upsertDomain(
      { domainId: MACHINE, kind: 'machine', enabled: true, budgetTokens: 9_999, cap: 7, shareCategories: ['CONSTRAINTS', 'ARCHITECTURE'] },
      NOW + 500,
    )
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW + 1_000 })
    const domain = stores.getDomain(MACHINE)
    expect(domain?.cap).toBe(7)
    expect(domain?.budgetTokens).toBe(9_999)
    // The allowlist is a SET; the loader serializes it in sorted order, so the
    // assertion is on membership rather than on the order it was written in.
    expect([...(domain?.shareCategories ?? [])].sort()).toEqual(['ARCHITECTURE', 'CONSTRAINTS'])
  })
})

describe('visibility through the real activation function', () => {
  function lane(stores: ReturnType<typeof openStores>, path: string) {
    const bridge = openMemoryBridge({
      dbPath: path,
      logger: silentLogger,
      domainResolver: makeDomainResolver(stores),
    })
    closers.push(bridge)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => NOW })
    closers.push(writer)
    return { bridge, writer }
  }

  const recall = (bridge: ReturnType<typeof openMemoryBridge>, project: string) =>
    ((bridge.recall({ project, budgetTokens: 8_000, limit: 40, now: NOW })?.lines ?? []) as string[]).join('\n')

  it('shows a machine row to every local project and to nobody excluded', () => {
    const stores = store()
    const path = contractDb()
    const { bridge, writer } = lane(stores, path)
    syncMachineDomain(stores, { identities: [A, B], config: { enabled: true }, now: NOW })
    const published = writer.publishDomainMemory({
      identity: MACHINE,
      category: 'CONSTRAINTS',
      content: 'this machine proxies npm through the internal registry',
    })
    expect(published.ok).toBe(true)

    expect(recall(bridge, A)).toContain('internal registry')
    expect(recall(bridge, B)).toContain('internal registry')
    // Neither a stranger nor an excluded project may see it.
    expect(recall(bridge, OUTSIDER)).not.toContain('internal registry')

    syncMachineDomain(stores, {
      identities: [A, B],
      config: { enabled: true, excludeProjects: [B] },
      now: NOW + 1_000,
    })
    expect(recall(bridge, B)).not.toContain('internal registry')
    expect(recall(bridge, A)).toContain('internal registry')
  })

  it('keeps the org and machine domains from leaking into each other', () => {
    const stores = store()
    const path = contractDb()
    const { bridge, writer } = lane(stores, path)

    // One project in each domain, disjoint; one project in neither.
    stores.upsertDomain(
      { domainId: ORG, kind: 'org', enabled: true, budgetTokens: 768, cap: defaultDomainCap('org'), shareCategories: ['CONSTRAINTS'] },
      NOW,
    )
    stores.addDomainMember(ORG, 'git:orgmember', NOW)
    syncMachineDomain(stores, { identities: ['git:machinemember'], config: { enabled: true }, now: NOW })

    expect(writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'org rule about the bastion' }).ok).toBe(true)
    expect(writer.publishDomainMemory({ identity: MACHINE, category: 'CONSTRAINTS', content: 'machine rule about the proxy' }).ok).toBe(true)

    const orgView = recall(bridge, 'git:orgmember')
    expect(orgView).toContain('bastion')
    expect(orgView).not.toContain('proxy')

    const machineView = recall(bridge, 'git:machinemember')
    expect(machineView).toContain('proxy')
    expect(machineView).not.toContain('bastion')

    const nobodyView = recall(bridge, OUTSIDER)
    expect(nobodyView).not.toContain('bastion')
    expect(nobodyView).not.toContain('proxy')
  })

  it('hides machine rows again when the domain is switched off', () => {
    const stores = store()
    const path = contractDb()
    const { bridge, writer } = lane(stores, path)
    syncMachineDomain(stores, { identities: [A], config: { enabled: true }, now: NOW })
    expect(writer.publishDomainMemory({ identity: MACHINE, category: 'CONSTRAINTS', content: 'a local-only rule' }).ok).toBe(true)
    expect(recall(bridge, A)).toContain('local-only rule')

    // Off: the flag is what activation reads, so the row becomes invisible while
    // remaining in the store (nothing was destroyed by switching it off).
    syncMachineDomain(stores, { identities: [A], config: { enabled: false }, now: NOW + 1_000 })
    expect(recall(bridge, A)).not.toContain('local-only rule')

    syncMachineDomain(stores, { identities: [A], config: { enabled: true }, now: NOW + 2_000 })
    expect(recall(bridge, A)).toContain('local-only rule')
  })
})
