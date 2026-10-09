/**
 * WP8 — the user profile in m[0]/m[1].
 *
 * The profile is the one global lane with no activation rule (it is about the
 * person, not a project), so it renders in m[0] above the project memories and
 * its additions ride the m[1] delta like every other additive lane. Two
 * behaviours are pinned here because they are the whole point of taking the lane
 * over from Magic Context:
 *
 *   - a new entry NEVER rebuilds the cached prefix (m[1] only);
 *   - a rewritten or DISMISSED entry DOES (upstream bumped a version number that
 *     deliberately never folded m[0], so a retracted profile line kept being
 *     injected indefinitely).
 *
 * The digest semantics are asserted directly, because that is where a subtle
 * mistake is invisible: `digest` covers the pool the watermark defines (a few
 * bytes of drift there means either a cache bust on every pass or a stale
 * prefix forever), while `foldDigest` covers every active row and is what a
 * HARD fold records.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROFILE_M0_BUDGET_TOKENS,
  openMemoryBridge,
  renderProfileLine,
  type ProfileRecallResult,
} from '../src/core/memory-bridge.ts'
import { BASELINE_CLOSE, BASELINE_OPEN, renderBaseline } from '../src/core/compartments.ts'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores } from '../src/index.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'
import type { Session } from '../src/dsh/seams.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

const NOW = 1_700_000_000_000
const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-profile-'))
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
      // never mask the assertion that failed
    }
  }
})

const logger = { info: () => {}, warn: () => {} }

interface ProfileFixture {
  readonly path: string
  readonly db: DatabaseSync
}

/**
 * A contract-shaped store: the real `memories` DDL (the bridge requires it — a
 * contract without `memories` is not a contract) plus `user_memories`.
 */
function makeProfileDb(rows: Array<{ id: number; content: string; status?: string; promotedAt: number; updatedAt: number }>): ProfileFixture {
  const created = makeMemoryDb({ prefix: 'mc-profile-', schemaVersion: 94 })
  dirs.push(created.dir)
  const db = new DatabaseSync(created.path)
  db.exec(`
    CREATE TABLE user_memories(
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      promoted_at INTEGER NOT NULL,
      source_candidate_ids TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_candidate_provenance TEXT
    );
  `)
  const insert = db.prepare(
    'INSERT INTO user_memories(id, content, status, promoted_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(row.id, row.content, row.status ?? 'active', row.promotedAt, row.promotedAt, row.updatedAt)
  }
  return { path: created.path, db }
}

function bridgeFor(fixture: ProfileFixture) {
  return openMemoryBridge({ dbPath: fixture.path, logger })
}

const SEED = [
  { id: 1, content: '用户全程使用简体中文沟通。', promotedAt: 100, updatedAt: 100 },
  { id: 2, content: '用户偏好先规划后执行。', promotedAt: 200, updatedAt: 200 },
]

describe('profile recall', () => {
  it('reads the active rows in promoted_at order and digests them', () => {
    const fixture = makeProfileDb(SEED)
    const result = bridgeFor(fixture).profileRecall({ now: NOW })!
    expect(result.rows.map(row => row.id)).toEqual([1, 2])
    expect(result.lines).toEqual([renderProfileLine(result.rows[0]!), renderProfileLine(result.rows[1]!)])
    expect(result.currentMaxId).toBe(2)
    // No watermark given: everything is the pool, so the two digests agree.
    expect(result.digest).toBe(result.foldDigest)
  })

  it('ignores dismissed rows entirely', () => {
    const fixture = makeProfileDb([
      ...SEED,
      { id: 3, content: '已退役的旧规则。', status: 'dismissed', promotedAt: 300, updatedAt: 300 },
    ])
    const result = bridgeFor(fixture).profileRecall({ now: NOW })!
    expect(result.rows.map(row => row.id)).toEqual([1, 2])
    expect(result.currentMaxId).toBe(2)
    expect(result.lines.join('\n')).not.toContain('已退役')
  })

  it('splits additions from the pool without letting them touch the pool digest', () => {
    const fixture = makeProfileDb([
      ...SEED,
      { id: 3, content: '新增的一条画像。', promotedAt: 300, updatedAt: 300 },
    ])
    const bridge = bridgeFor(fixture)
    const frozen = bridge.profileRecall({ now: NOW, maxId: 2 })!
    expect(frozen.rows.map(row => row.id)).toEqual([1, 2])
    expect(frozen.newRows.map(row => row.id)).toEqual([3])
    expect(frozen.newLines.join('\n')).toContain('新增的一条画像')
    // The pool digest is the same as if row 3 did not exist — that is what keeps
    // a new profile entry from busting the cached prefix.
    const withoutAddition = bridgeFor(makeProfileDb(SEED)).profileRecall({ now: NOW, maxId: 2 })!
    expect(frozen.digest).toBe(withoutAddition.digest)
    // ...while the fold digest does see it, because a fold renders everything.
    expect(frozen.foldDigest).not.toBe(withoutAddition.foldDigest)
  })

  it('changes the pool digest when a rendered row is rewritten or dismissed', () => {
    const bridge = bridgeFor(makeProfileDb(SEED))
    const before = bridge.profileRecall({ now: NOW })!
    const rewritten = bridgeFor(makeProfileDb([
      { ...SEED[0]!, content: '改写后的画像正文。', updatedAt: 150 },
      SEED[1]!,
    ])).profileRecall({ now: NOW })!
    expect(rewritten.digest).not.toBe(before.digest)
    const dismissed = bridgeFor(makeProfileDb([SEED[0]!, { ...SEED[1]!, status: 'dismissed' }]))
      .profileRecall({ now: NOW })!
    expect(dismissed.digest).not.toBe(before.digest)
  })

  it('returns undefined when there is no profile at all', () => {
    const fixture = makeProfileDb([])
    expect(bridgeFor(fixture).profileRecall({ now: NOW })).toBeUndefined()
  })

  it('degrades to "no profile" when the table is missing', () => {
    const created = makeMemoryDb({ prefix: 'mc-profile-nouser-', schemaVersion: 94 })
    dirs.push(created.dir)
    const bridge = openMemoryBridge({ dbPath: created.path, logger })
    expect(bridge.status.ok).toBe(true)
    expect(bridge.profileRecall({ now: NOW })).toBeUndefined()
  })

  it('trims with continue semantics, so one huge entry cannot hide the cheaper ones', () => {
    const fixture = makeProfileDb([
      { id: 1, content: 'x'.repeat(PROFILE_M0_BUDGET_TOKENS * 8), promotedAt: 100, updatedAt: 100 },
      { id: 2, content: '便宜且重要的一条。', promotedAt: 200, updatedAt: 200 },
    ])
    const result = bridgeFor(fixture).profileRecall({ now: NOW })!
    expect(result.rows.map(row => row.id)).toEqual([2])
    expect(result.lines).toHaveLength(1)
  })
})

describe('profile rendering', () => {
  function render(profile: ProfileRecallResult | undefined, hard = false): string {
    const pool = hard
      ? [...(profile?.lines ?? []), ...(profile?.newLines ?? [])]
      : profile?.lines ?? []
    const delta = hard ? [] : profile?.newLines ?? []
    return renderBaseline({
      now: NOW,
      baseline: [],
      delta: [],
      memories: ['- [CONSTRAINTS] never commit secrets'],
      ...pool.length === 0 ? {} : { profileLines: pool },
      ...delta.length === 0 ? {} : { newProfileLines: delta },
      budgetTokens: 8000,
    })
  }

  it('puts the profile in m[0], above the project memories', () => {
    const fixture = makeProfileDb(SEED)
    const block = render(bridgeFor(fixture).profileRecall({ now: NOW }))
    expect(block).toContain('<user-profile>')
    expect(block).toContain('用户全程使用简体中文沟通。')
    expect(block.indexOf('<user-profile>')).toBeLessThan(block.indexOf('<project-memories>'))
    expect(block).not.toContain('<new-user-profile>')
  })

  it('renders additions in the m[1] region, after the project memories', () => {
    const fixture = makeProfileDb([...SEED, { id: 3, content: '新增的一条画像。', promotedAt: 300, updatedAt: 300 }])
    const block = render(bridgeFor(fixture).profileRecall({ now: NOW, maxId: 2 }))
    expect(block).toContain('<new-user-profile>')
    expect(block.indexOf('<new-user-profile>')).toBeGreaterThan(block.indexOf('<project-memories>'))
    expect(block.slice(0, block.indexOf('</project-memories>'))).not.toContain('新增的一条画像')
  })

  it('folds the delta into m[0] on a HARD rebuild', () => {
    const fixture = makeProfileDb([...SEED, { id: 3, content: '新增的一条画像。', promotedAt: 300, updatedAt: 300 }])
    const block = render(bridgeFor(fixture).profileRecall({ now: NOW, maxId: 2 }), true)
    expect(block).not.toContain('<new-user-profile>')
    expect(block).toContain('新增的一条画像。')
  })

  it('renders two consecutive reads byte-identically', () => {
    const fixture = makeProfileDb(SEED)
    const bridge = bridgeFor(fixture)
    expect(render(bridge.profileRecall({ now: NOW }))).toBe(render(bridge.profileRecall({ now: NOW + 5000 })))
  })

  it('omits the block entirely when the profile is empty', () => {
    const block = render(undefined)
    expect(block).toContain(BASELINE_OPEN)
    expect(block).not.toContain('<user-profile>')
    expect(block).toContain(BASELINE_CLOSE)
  })
})

// ── the pass: HARD vs soft, the freeze, and the journal reason ───────────────

interface SurfaceEvent {
  seq: number
  type: string
  data: { id: string; role: string; content: Array<{ type: string; text?: string }> }
  surfaceOp?: { op: string; startSeq: number; endSeq: number }
  sourceEventSeqs?: number[]
}

function makeSurface() {
  const events: SurfaceEvent[] = []
  const nodes: number[] = []
  let nextSeq = 1
  let replaceGeneration = 0
  const append = (
    type: string,
    data: unknown,
    options?: { surfaceOp?: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] },
  ): { seq: number } => {
    replaceGeneration += 1
    const seq = nextSeq
    nextSeq += 1
    events.push({ seq, type, data: data as SurfaceEvent['data'], ...options === undefined ? {} : options })
    const op = options?.surfaceOp
    if (op !== undefined && op.op === 'replace') {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const current = nodes[index] as number
        if (current >= op.startSeq && current <= op.endSeq) nodes.splice(index, 1)
      }
    }
    nodes.push(seq)
    return { seq }
  }
  append('user/message', { id: 'seed-user', role: 'user', content: [{ type: 'text', text: '§1§ go' }] })
  const session = {
    get surface() {
      return { nodes, replaceGeneration }
    },
    snapshotEvents: () => events,
    append,
  }
  const textOfSeq = (seq: number): string => {
    const event = events.find(candidate => candidate.seq === seq)
    return event === undefined
      ? ''
      : event.data.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  }
  return {
    session: session as unknown as Session,
    text: () => nodes.map(textOfSeq).filter(part => part !== '').join('\n'),
  }
}

function makePassHarness() {
  const stores = openStores(tempDir())
  opened.push(stores)
  const surface = makeSurface()
  const entries: Array<{ kind: string; summary: string; data?: Record<string, unknown> }> = []
  const journal = {
    info: (kind: string, summary: string, data?: Record<string, unknown>) => { entries.push({ kind, summary, data }) },
    warn: () => {},
    error: () => {},
  }
  let profile: ProfileRecallResult | undefined
  let clock = 1_000_000
  const pass = (): boolean => runManagementPass({
    session: surface.session,
    sessionId: 's-profile',
    stores,
    policy: DEFAULT_POLICY,
    logger,
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 70,
    now: () => clock,
    memories: { digest: 'memories-digest', lines: ['- [CONSTRAINTS] never commit secrets'] },
    ...profile === undefined ? {} : { profile },
    journal: journal as never,
  }).baselineUpdated
  return {
    stores,
    text: surface.text,
    entries,
    setProfile: (next: ProfileRecallResult | undefined) => { profile = next },
    setNow: (value: number) => { clock = value },
    pass,
    state: () => stores.baselineState('s-profile'),
  }
}

describe('the profile in the management pass', () => {
  it('folds the profile on the first pass and freezes its watermark and digest', () => {
    const h = makePassHarness()
    const fixture = makeProfileDb(SEED)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW })!)
    expect(h.pass()).toBe(true)
    expect(h.text()).toContain('<user-profile>')
    expect(h.state()?.epoch).toBe(1)
    expect(h.state()?.profileWatermark).toBe(2)
    expect(h.state()?.profileM0Digest).toBe(h.state()?.profileM0Digest)
    expect(h.state()?.profileM0Digest).not.toBe('')
    expect(h.entries.some(entry => entry.data?.reason === 'first-baseline')).toBe(true)
  })

  it('renders a new entry in m[1] without a HARD rebuild', () => {
    const h = makePassHarness()
    const fixture = makeProfileDb(SEED)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW })!)
    h.pass()
    const epochAfterFirst = h.state()?.epoch
    expect(epochAfterFirst).toBe(1)

    // A new row appears above the frozen watermark.
    fixture.db.exec("INSERT INTO user_memories(id, content, status, promoted_at, created_at, updated_at) VALUES (9, '刚学到的一条画像。', 'active', 900, 900, 900)")
    h.setNow(1_000_500)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW, maxId: h.state()?.profileWatermark })!)
    expect(h.pass()).toBe(true)
    expect(h.state()?.epoch).toBe(1)
    expect(h.text()).toContain('<new-user-profile>')
    expect(h.text()).toContain('刚学到的一条画像。')
    expect(h.entries.some(entry => entry.data?.reason === 'profile-digest-changed')).toBe(false)
  })

  it('rebuilds HARD when a rendered entry is rewritten', () => {
    const h = makePassHarness()
    const fixture = makeProfileDb(SEED)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW })!)
    h.pass()
    expect(h.state()?.epoch).toBe(1)

    fixture.db.exec("UPDATE user_memories SET content = '被改写的画像。', updated_at = 500 WHERE id = 1")
    h.setNow(1_001_000)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW, maxId: h.state()?.profileWatermark })!)
    expect(h.pass()).toBe(true)
    expect(h.state()?.epoch).toBe(2)
    expect(h.text()).toContain('被改写的画像。')
    expect(h.entries.some(entry => entry.data?.reason === 'profile-digest-changed')).toBe(true)
  })

  it('removes a dismissed entry from both blocks with one rebuild', () => {
    const h = makePassHarness()
    const fixture = makeProfileDb(SEED)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW })!)
    h.pass()
    expect(h.text()).toContain('用户偏好先规划后执行。')

    fixture.db.exec("UPDATE user_memories SET status = 'dismissed', updated_at = 600 WHERE id = 2")
    h.setNow(1_002_000)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW, maxId: h.state()?.profileWatermark })!)
    h.pass()
    expect(h.state()?.epoch).toBe(2)
    expect(h.text()).not.toContain('用户偏好先规划后执行。')
    expect(h.text()).toContain('用户全程使用简体中文沟通。')
    // A second pass with the same inputs must be byte-stable: no rebuild loop.
    const before = h.text()
    h.setNow(1_003_000)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW, maxId: h.state()?.profileWatermark })!)
    expect(h.pass()).toBe(false)
    expect(h.text()).toBe(before)
    expect(h.state()?.epoch).toBe(2)
  })

  it('folds once when the profile lane is switched off, then stays quiet', () => {
    const h = makePassHarness()
    const fixture = makeProfileDb(SEED)
    h.setProfile(bridgeFor(fixture).profileRecall({ now: NOW })!)
    h.pass()
    h.setNow(1_004_000)
    h.setProfile(undefined)
    expect(h.pass()).toBe(true)
    expect(h.state()?.epoch).toBe(2)
    expect(h.text()).not.toContain('<user-profile>')
    expect(h.state()?.profileM0Digest).toBe('')
    // The empty sentinel means the next pass does not rebuild again.
    h.setNow(1_005_000)
    expect(h.pass()).toBe(false)
    expect(h.state()?.epoch).toBe(2)
  })
})
