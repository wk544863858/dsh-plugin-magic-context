/**
 * WP9 — publishing a candidate into the organisation's domain.
 *
 * The step that makes the domain real. Two things are worth more than the happy
 * path:
 *
 *  1. **The row must be published VISIBLE.** A domain memory that is written
 *     with the schema defaults (`scope='project'`, `shareable=0`) is invisible to
 *     every other project — published and seen by nobody, with no error to show
 *     for it. The visibility columns get their own assertion, and the last block
 *     proves the clause end to end by recalling the row through the bridge as a
 *     PEER project.
 *  2. **A refusal must cost nothing.** Credentials, a category outside the
 *     allowlist, a read-only store: each has to leave the store untouched and the
 *     candidate `pending`, because the state transition is what makes a failed
 *     publish look successful.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryBridge } from '../src/core/memory-bridge.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { openStores } from '../src/index.ts'
import { ORG_DOMAIN_ID, approvalGate, publishGlobalCandidate } from '../src/core/global-domains.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import { makeMemoryDb } from './helpers/memory-db'

const NOW = 1_700_000_000_000
const PEER = 'git:alpha'
const OUTSIDER = 'git:outsider'
const ORG = ORG_DOMAIN_ID
const silentLogger = { info: () => {}, warn: () => {} }

const dirs: string[] = []
const opened: Array<{ close(): void }> = []
const writers: Array<{ close(): void }> = []
const bridges: Array<{ close(): void }> = []

afterEach(() => {
  for (const closeable of [...bridges.splice(0), ...writers.splice(0), ...opened.splice(0)]) {
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
      // never mask the assertion that failed
    }
  }
})

function contractDb(): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-publish-',
    schemaVersion: 94,
    mutationLog: true,
    projectState: true,
    fts: true,
  })
  dirs.push(dir)
  return path
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-publish-store-'))
  dirs.push(dir)
  const store = openStores(dir)
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
  store.addDomainMember(ORG, 'dir:global:org', NOW)
  return store
}

function writerFor(path: string) {
  const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => NOW })
  writers.push(writer)
  return writer
}

function bridgeFor(path: string) {
  const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
  bridges.push(bridge)
  return bridge
}

function rows(path: string): Array<{
  id: number
  project_path: string
  category: string
  content: string
  scope: string | null
  shareable: number | null
  source_type: string | null
  expires_at: number | null
  status: string
  seen_count: number | null
}> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(
      `SELECT id, project_path, category, content, scope, shareable, source_type,
              expires_at, status, seen_count FROM memories ORDER BY id`,
    ).all() as unknown as ReturnType<typeof rows>
  } finally {
    db.close()
  }
}

/** A publishable candidate: two independent projects saw it, with a category. */
function seedCandidate(store: ReturnType<typeof openStores>, content: string, category: string | undefined = 'CONSTRAINTS') {
  const candidate = store.upsertGlobalCandidate(
    {
      domainId: ORG,
      content,
      normalizedHash: `h-${content.slice(0, 8)}`,
      firstIdentity: PEER,
      ...category === undefined ? {} : { category },
    },
    NOW,
  )
  store.recordCandidateObservation({ candidateId: candidate.id, identity: PEER, sessionId: 's1' }, NOW)
  store.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:beta', sessionId: 's2' }, NOW)
  return store.getGlobalCandidate(candidate.id)!
}

describe('publishDomainMemory — the write that makes a domain row visible', () => {
  it('writes the two visibility columns explicitly, plus the human source', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const result = writer.publishDomainMemory({
      identity: ORG,
      category: 'CONSTRAINTS',
      content: 'DB access goes through the bastion',
      importance: 80,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    const [row] = rows(path)
    expect(row).toMatchObject({
      project_path: ORG,
      category: 'CONSTRAINTS',
      scope: 'universe',
      shareable: 1,
      source_type: 'user',
      status: 'active',
    })
    // Organisation knowledge does not rot: a domain row must not carry a TTL,
    // or its visibility would expire silently.
    expect(row!.expires_at).toBeNull()
  })

  it('is idempotent: the same content bumps the counter instead of duplicating', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const first = writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'same fact' })
    const second = writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'same fact' })
    expect(first.ok && first.created).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.ok ? first.id : -1)
    expect(rows(path)).toHaveLength(1)
    expect(rows(path)[0]!.seen_count).toBe(2)
  })

  it('refuses a category the contract cannot store', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const result = writer.publishDomainMemory({ identity: ORG, category: 'NOT_A_CATEGORY', content: 'x' })
    expect(result.ok).toBe(false)
    expect(rows(path)).toEqual([])
  })

  it('refuses empty content', () => {
    const path = contractDb()
    const writer = writerFor(path)
    expect(writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: '   ' }).ok).toBe(false)
    expect(rows(path)).toEqual([])
  })
})

describe('publishGlobalCandidate — the gate protects the store', () => {
  it('publishes an approved candidate under the domain identity', () => {
    const path = contractDb()
    const store = makeStore()
    const candidate = seedCandidate(store, 'one true organisation rule')
    const result = publishGlobalCandidate(store, { candidateId: candidate.id, writer: writerFor(path), now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity).toBe(ORG)
    expect(result.category).toBe('CONSTRAINTS')
    expect(result.created).toBe(true)
    expect(rows(path).map(row => row.content)).toEqual(['one true organisation rule'])
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('approved')
  })

  it('refuses a credential body and writes nothing', () => {
    const path = contractDb()
    const store = makeStore()
    const candidate = seedCandidate(store, 'the bastion needs DB_PASSWORD=hunter2 to connect')
    const result = publishGlobalCandidate(store, { candidateId: candidate.id, writer: writerFor(path), now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/credential|password/i)
    expect(rows(path)).toEqual([])
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('pending')
  })

  it('refuses a category outside the domain allowlist and writes nothing', () => {
    const path = contractDb()
    const store = makeStore()
    const candidate = seedCandidate(store, 'a naming convention', 'NAMING')
    const result = publishGlobalCandidate(store, { candidateId: candidate.id, writer: writerFor(path), now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('invisible')
    expect(rows(path)).toEqual([])
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('pending')
  })

  it('leaves the candidate pending when the store refuses the write', () => {
    const path = contractDb()
    const store = makeStore()
    const candidate = seedCandidate(store, 'a rule the store will refuse')
    const result = publishGlobalCandidate(store, {
      candidateId: candidate.id,
      writer: {
        publishDomainMemory: () => ({ ok: false as const, detail: 'contract is read-only' }),
        countDomainMemories: () => 0,
      },
      now: NOW,
    })
    expect(result.ok).toBe(false)
    // The state transition runs LAST, so the failure stays retryable.
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('pending')
    expect(rows(path)).toEqual([])
  })

  it('refuses to publish the same candidate twice', () => {
    const path = contractDb()
    const store = makeStore()
    const candidate = seedCandidate(store, 'publish me once')
    const writer = writerFor(path)
    expect(publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW }).ok).toBe(true)
    const again = publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW + 1000 })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error).toContain('approved')
    expect(rows(path)).toHaveLength(1)
  })

  it('reports an unknown candidate', () => {
    const store = makeStore()
    const result = publishGlobalCandidate(store, { candidateId: 4242, writer: writerFor(contractDb()), now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('#4242')
  })
})

describe('a published domain row is visible to peers — and retirable', () => {
  const recall = (path: string, project: string, peers: readonly string[]) => {
    const bridge = bridgeFor(path)
    const result = bridge.recall({
      project,
      domainProjects: peers,
      shareCategories: ['CONSTRAINTS'],
      budgetTokens: 8_000,
      limit: 40,
      now: NOW,
    })
    return (result?.lines ?? []).join('\n')
  }

  it('reaches a peer project, not an outsider, and disappears when retired', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const published = writer.publishDomainMemory({
      identity: ORG,
      category: 'CONSTRAINTS',
      content: 'DB access goes through the bastion',
    })
    expect(published.ok).toBe(true)
    if (!published.ok) return

    // The whole point of publishing: a MEMBER project sees it ...
    expect(recall(path, PEER, [ORG])).toContain('bastion')
    // ... and a project that is not in the domain does not. Visibility without
    // isolation would be a leak, not a feature.
    expect(recall(path, OUTSIDER, [])).not.toContain('bastion')

    // Retirement is the ordinary archive path, and it must remove the row from
    // the same clause that admitted it.
    const archived = writer.archiveMemory({ identity: ORG, id: published.id, reason: 'retired' })
    expect(archived.ok).toBe(true)
    expect(recall(path, PEER, [ORG])).not.toContain('bastion')
  })

  it('keeps a REWRITTEN domain row visible (the WP4 restore, in its real use)', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const published = writer.publishDomainMemory({
      identity: ORG,
      category: 'CONSTRAINTS',
      content: 'DB access goes through the bastion',
    })
    expect(published.ok).toBe(true)
    if (!published.ok) return

    // A rewrite clears `shareable` in MC's contract; WP4's restore puts it back.
    // Without it, editing an organisation rule would silently withdraw it from
    // every other project — this is that scenario, end to end.
    const updated = writer.updateMemory({
      identity: ORG,
      id: published.id,
      content: 'DB access goes through the bastion (rotated weekly)',
    })
    expect(updated.ok).toBe(true)
    const text = recall(path, PEER, [ORG])
    expect(text).toContain('rotated weekly')
    expect(rows(path)[0]!.shareable).toBe(1)
  })

  it('shows the credential refusal through the gate the command uses', () => {
    const store = makeStore()
    const candidate = seedCandidate(store, 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(approvalGate(store, candidate).ok).toBe(false)
  })
})

/**
 * The admission cap (2026-10-16). `domains.cap` was derived from the domain's
 * token budget and displayed by `/ctx-global list`, but nothing enforced it: a
 * domain could grow past its ceiling with no signal anywhere. These cases pin
 * the enforcement to LIVE rows, so an archived row frees its slot.
 */
describe('the domain admission cap (domains.cap)', () => {
  function storeWithCap(cap: number) {
    const dir = mkdtempSync(join(tmpdir(), 'mc-publish-cap-'))
    dirs.push(dir)
    const store = openStores(dir)
    opened.push(store)
    store.upsertDomain(
      { domainId: ORG, kind: 'org', enabled: true, budgetTokens: 40, cap, shareCategories: ['CONSTRAINTS'] },
      NOW,
    )
    store.addDomainMember(ORG, 'dir:global:org', NOW)
    return store
  }

  it('refuses a publish once the domain holds cap live rows, and leaves it pending', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const store = storeWithCap(2)
    // Fill the domain through the real writer, so the count is over real rows.
    expect(writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'org rule one' }).ok).toBe(true)
    expect(writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'org rule two' }).ok).toBe(true)
    expect(writer.countDomainMemories(ORG)).toBe(2)

    const candidate = seedCandidate(store, 'the third rule that must wait')
    // The gate the card and the command both run refuses BEFORE the write ...
    const gate = approvalGate(store, candidate, writer)
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('cap (2/2')
    // ... and the publish path agrees, because it runs the same gate.
    const refused = publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('cap')
    expect(rows(path)).toHaveLength(2)
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('pending')
  })

  it('lets the next publish through once an archived row frees a slot', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const store = storeWithCap(1)
    const first = writer.publishDomainMemory({ identity: ORG, category: 'CONSTRAINTS', content: 'org rule one' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const candidate = seedCandidate(store, 'the rule that was waiting')
    expect(publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW }).ok).toBe(false)

    // Withdrawal is the ordinary archive path — the cap counts live rows only.
    expect(writer.archiveMemory({ identity: ORG, id: first.id, reason: 'retired' }).ok).toBe(true)
    expect(writer.countDomainMemories(ORG)).toBe(0)
    const published = publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW })
    expect(published.ok).toBe(true)
    expect(store.getGlobalCandidate(candidate.id)?.state).toBe('approved')
  })

  it('counts only the domain identity asked for', () => {
    const path = contractDb()
    const writer = writerFor(path)
    const store = storeWithCap(1)
    expect(writer.publishDomainMemory({ identity: 'dir:global:machine', category: 'CONSTRAINTS', content: 'machine rule' }).ok).toBe(true)
    // The machine row must not consume the org domain's slot.
    expect(writer.countDomainMemories(ORG)).toBe(0)
    const candidate = seedCandidate(store, 'the org rule that fits')
    expect(publishGlobalCandidate(store, { candidateId: candidate.id, writer, now: NOW }).ok).toBe(true)
  })
})
