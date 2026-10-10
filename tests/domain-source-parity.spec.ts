/**
 * A-7 — the dual-source parity that turns `memory.domains.source` from a code
 * path into a proven rollback lever, plus the copy-not-mirror reconciliation
 * (phase D blind, 报告盲区 2).
 *
 * Part 1 (parity): over the SAME contract database, a contract-source bridge
 * (workspaces/workspace_members) and an adapter-source bridge (domains/
 * domain_members) that model the same provider identity and the same category
 * allowlist must produce IDENTICAL recall sets, watermarks, search spaces and
 * epoch fingerprints. If they ever disagree, flipping the source is not a
 * rollback — it is a behavior change for every reader. A divergence control
 * (a contract member the adapter domain deliberately lacks) proves the
 * comparison is sensitive rather than vacuous.
 *
 * Part 2 (copy-not-mirror): publishing is a COPY. After a domain row is
 * published, rewriting the source row (`updateMemory`) and archiving it
 * (`archiveMemory`) must leave the domain row byte-identical — no propagation,
 * no counter drift, no timestamp bump.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryBridge, type ActivePeerDomain } from '../src/core/memory-bridge.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { openStores } from '../src/index.ts'
import { ORG_DOMAIN_ID } from '../src/core/global-domains.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

const NOW = 1_700_000_000_000
const READER = 'git:company'
const ORG = 'dir:global:org'
const PEER = 'git:peer'

const silentLogger = { info: () => {}, warn: () => {} }

const dirs: string[] = []
const opened: Array<{ close(): void }> = []

afterEach(() => {
  for (const closeable of opened.splice(0)) {
    try {
      closeable.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // never mask the assertion that actually failed
    }
  }
})

interface Seeded {
  contractPath: string
  store: ReturnType<typeof openStores>
}

/**
 * One contract fixture: own rows, provider rows (shareable and not), a row
 * outside the allowlist, and a peer row that stays invisible until the
 * divergence control turns it on. The workspace models the SAME provider
 * identity the adapter domain will: members {READER, ORG}.
 */
function seed(): Seeded {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-parity-',
    schemaVersion: 94,
    workspaces: true,
  })
  dirs.push(dir)

  const db = new DatabaseSync(path)
  try {
    db.exec(`
      INSERT INTO workspaces(id, name, share_categories, created_at, updated_at)
        VALUES(1, 'code', '["CONSTRAINTS"]', 0, 0);
      INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at)
        VALUES(1, '${READER}', 'company', '', 0), (1, '${ORG}', 'org', '', 0);
    `)
    const insert = db.prepare(
      'INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, '
        + 'first_seen_at, created_at, updated_at, last_seen_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const rows: Array<[number, string, string, boolean, string]> = [
      [1, READER, 'CONSTRAINTS', false, 'own baseline rule'],
      [2, ORG, 'CONSTRAINTS', true, 'org bastion pointer'],
      [5, ORG, 'NAMING', true, 'org row outside the allowlist'],
      [6, PEER, 'CONSTRAINTS', true, 'peer row the adapter domain never sees'],
      [7, READER, 'CONSTRAINTS', false, 'own newest rule'],
      [8, ORG, 'CONSTRAINTS', false, 'org row that is NOT shareable'],
    ]
    for (const [id, projectPath, category, shareable, content] of rows) {
      insert.run(id, projectPath, category, content, `hash-${id}`, 'universe', shareable ? 1 : 0, 1, 1, 1, 1, 'active')
    }
  } finally {
    db.close()
  }

  const storeDir = mkdtempSync(join(tmpdir(), 'mc-parity-store-'))
  dirs.push(storeDir)
  const store = openStores(storeDir)
  opened.push(store)
  store.upsertDomain(
    {
      domainId: ORG,
      kind: 'org',
      enabled: true,
      budgetTokens: 768,
      cap: defaultDomainCap('org'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  store.addDomainMember(ORG, READER, NOW)
  return { contractPath: path, store }
}

function resolverFor(store: ReturnType<typeof openStores>) {
  return (identity: string): readonly ActivePeerDomain[] =>
    store.activeDomainIdentities(identity).map(domain => ({
      identity: domain.identity,
      shareCategories: store.getDomain(domain.domainId)?.shareCategories ?? [],
      kind: domain.kind,
    }))
}

function contractBridge(seeded: Seeded) {
  const bridge = openMemoryBridge({ dbPath: seeded.contractPath, logger: silentLogger })
  opened.push(bridge)
  return bridge
}

function adapterBridge(seeded: Seeded) {
  const bridge = openMemoryBridge({
    dbPath: seeded.contractPath,
    logger: silentLogger,
    domainResolver: resolverFor(seeded.store),
  })
  opened.push(bridge)
  return bridge
}

function recall(bridge: ReturnType<typeof openMemoryBridge>, maxMemoryId?: number) {
  return bridge.recall({
    project: READER,
    budgetTokens: 100_000,
    limit: 100,
    now: NOW,
    ...maxMemoryId === undefined ? {} : { maxMemoryId },
  })!
}

function visibleIds(bridge: ReturnType<typeof openMemoryBridge>, maxMemoryId?: number): number[] {
  const result = recall(bridge, maxMemoryId)
  return [...result.rows, ...result.newRows].map(row => row.id).sort((a, b) => a - b)
}

describe('A-7 dual-source parity: contract vs adapter over the same database', () => {
  it('yields identical recall sets, digests and watermarks for the same reader', () => {
    const seeded = seed()
    const contract = contractBridge(seeded)
    const adapter = adapterBridge(seeded)

    // Both sources resolve the SAME provider identity (ORG), so the visible
    // pool must be identical: own 1/7, org 2; hidden 5 (outside the allowlist),
    // 6 (not a member), 8 (not shareable — the phantom-watermark row).
    expect(visibleIds(contract)).toEqual([1, 2, 7])
    expect(visibleIds(adapter)).toEqual([1, 2, 7])

    // Byte-identical reader experience, not merely the same ids.
    expect(recall(contract).digest).toBe(recall(adapter).digest)

    // The watermark — one activation answer feeding two consumers — agrees,
    // and neither source lets the hidden row 8 poison it.
    expect(contract.maxMemoryId(READER)).toBe(7)
    expect(adapter.maxMemoryId(READER)).toBe(7)
    expect(recall(contract).currentMaxMemoryId).toBe(recall(adapter).currentMaxMemoryId)
  })

  it('resolves the same foreign identities for searchSpace and the same epoch fingerprint', () => {
    const seeded = seed()
    const contract = contractBridge(seeded)
    const adapter = adapterBridge(seeded)

    expect([...contract.searchSpace(READER)!.foreignIdentities].sort())
      .toEqual([...adapter.searchSpace(READER)!.foreignIdentities].sort())
    expect(contract.searchSpace(READER)!.foreignIdentities).toEqual([ORG])

    // The fingerprint hashes every member's epoch; equal peer sets over the
    // same contract rows must produce the same fingerprint, so a baseline
    // frozen under one source stays valid under the other.
    expect(contract.projectMemoryEpochFingerprint(READER))
      .toBe(adapter.projectMemoryEpochFingerprint(READER))
  })

  it('divergence control: a contract member the domain lacks IS visible — the comparison is sensitive', () => {
    const seeded = seed()
    const contract = contractBridge(seeded)
    const adapter = adapterBridge(seeded)

    // Give ONLY the contract source the extra member. If the parity assertions
    // above can never fail, they prove nothing; this control shows they can.
    const db = new DatabaseSync(seeded.contractPath)
    try {
      db.exec(`INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at)
        VALUES(1, '${PEER}', 'peer', '', 0)`)
    } finally {
      db.close()
    }

    expect(visibleIds(contract)).toEqual([1, 2, 6, 7])
    expect(visibleIds(adapter)).toEqual([1, 2, 7])
    expect([...contract.searchSpace(READER)!.foreignIdentities].sort()).toEqual([ORG, PEER])
    expect(adapter.searchSpace(READER)!.foreignIdentities).toEqual([ORG])
  })
})

describe('publishing is a copy, not a mirror (reconciliation for 报告盲区 2)', () => {
  function domainRow(path: string) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare(
        `SELECT id, project_path, content, status, seen_count, updated_at, scope, shareable
           FROM memories WHERE project_path = ? ORDER BY id`,
      ).all(ORG_DOMAIN_ID)
    } finally {
      db.close()
    }
  }

  it('rewriting and archiving the source row never propagates to the domain row', () => {
    const { path, dir } = makeMemoryDb({
      prefix: 'mc-parity-copy-',
      schemaVersion: 94,
      mutationLog: true,
      projectState: true,
      fts: true,
    })
    dirs.push(dir)

    // The source row: a plain project memory that the publisher copied from.
    const seedDb = new DatabaseSync(path)
    try {
      seedDb.prepare(
        'INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, '
          + 'first_seen_at, created_at, updated_at, last_seen_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(10, 'git:alpha', 'CONSTRAINTS', 'v1 — the source text', 'hash-src', 'project', 1, 1, 1, 1, 1, 'active')
    } finally {
      seedDb.close()
    }

    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => NOW })
    opened.push(writer)
    const published = writer.publishDomainMemory({
      identity: ORG_DOMAIN_ID,
      category: 'CONSTRAINTS',
      content: 'v1 — the source text',
      importance: 60,
    })
    expect(published.ok).toBe(true)
    if (!published.ok) return

    const before = domainRow(path)
    expect(before).toHaveLength(1)
    const snapshot = JSON.stringify(before)

    // Source-side churn through the product path: a rewrite and an archive.
    const rewritten = writer.updateMemory({ identity: 'git:alpha', id: 10, content: 'v2 — rewritten upstream', importance: 95 })
    expect(rewritten.ok).toBe(true)
    expect(JSON.stringify(domainRow(path))).toBe(snapshot)

    const archived = writer.archiveMemory({ identity: 'git:alpha', id: 10, reason: 'superseded upstream' })
    expect(archived.ok).toBe(true)
    // No propagation: content, status, seen_count, updated_at all untouched.
    expect(JSON.stringify(domainRow(path))).toBe(snapshot)
    expect((domainRow(path)[0] as { content: string }).content).toBe('v1 — the source text')
  })
})
