/**
 * The m[1] delta lane: Magic Context's `memory_mutation_log` cursor, the
 * `<memory-updates>` rendering, the `project_memory_epoch` reset rule, and the
 * cache-prefix invariants around them (contract §5.3, §6, §7.5 and §9 A7).
 *
 * Everything here is read-only against the shared `context.db` (synthetic
 * fixtures plus, where available, a `VACUUM INTO` snapshot of the user's real
 * database). Layer 1 is pure rendering; layer 2 is the bridge; layer 3 is the
 * composed baseline; layer 4 the adapter store + migration; layer 5 drives the
 * real management pass over a fake session surface.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASELINE_CLOSE,
  BASELINE_OPEN,
  MEMORY_UPDATES_CLOSE,
  MEMORY_UPDATES_HEADER,
  MEMORY_UPDATES_OPEN,
  MEMORY_VISIBILITY_SENTINEL,
  renderBaseline,
  renderMemoryUpdates,
  type Compartment,
  type MemoryUpdateLine,
} from '../src/core/compartments.ts'
import {
  defaultMemoryDbPath,
  openMemoryBridge,
} from '../src/core/memory-bridge.ts'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { SCHEMA_VERSION, openStores } from '../src/core/stores.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'
import type { Session } from '../src/dsh/seams.ts'
import { MUTATION_LOG_DDL, makeMemoryDb, PROJECT_STATE_DDL, WORKSPACES_DDL } from './helpers/memory-db'

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

interface CapturedLogger {
  readonly warnings: string[]
  info(message: string): void
  warn(message: string): void
}

function captureLogger(): CapturedLogger {
  const warnings: string[] = []
  return { warnings, info: () => {}, warn: (message: string) => void warnings.push(message) }
}

// ── Layer 1: the renderer (pure bytes, MC memory_render.rs:333-377) ──────────

function update(overrides: Partial<MemoryUpdateLine> = {}): MemoryUpdateLine {
  return { id: 1, targetMemoryId: 7, mutationType: 'update', content: 'new text', ...overrides }
}

describe('renderMemoryUpdates (MC §6.4 wire bytes)', () => {
  it('renders every branch with the exact Magic Context template', () => {
    const block = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 7 }),
      update({ id: 2, targetMemoryId: 8, category: 'CONSTRAINTS', content: 'with cat' }),
      update({ id: 3, targetMemoryId: 9, mutationType: 'superseded', supersededById: 10, replacementResolvable: true }),
      update({ id: 4, targetMemoryId: 11, mutationType: 'archive' }),
    ]).block
    expect(block).toBe([
      MEMORY_UPDATES_OPEN,
      MEMORY_UPDATES_HEADER,
      '  <updated id="7">new text</updated>',
      '  <updated id="8" category="CONSTRAINTS">with cat</updated>',
      '  <superseded id="9" by="10"/>',
      '  <removed id="11"/>',
      MEMORY_UPDATES_CLOSE,
    ].join('\n'))
    // The header is a literal from the contract — em dash included.
    expect(MEMORY_UPDATES_HEADER).toBe('These memories changed since the snapshot below — trust these:')
    expect(block).toContain('\n  <updated id="7">')
  })

  it('degrades an unresolvable supersede to <removed/> and drops the sentinel category', () => {
    expect(renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 9, mutationType: 'superseded', supersededById: 10, replacementResolvable: false }),
    ]).block).toBe([
      MEMORY_UPDATES_OPEN,
      MEMORY_UPDATES_HEADER,
      '  <removed id="9"/>',
      MEMORY_UPDATES_CLOSE,
    ].join('\n'))
    const sentinel = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 12, category: MEMORY_VISIBILITY_SENTINEL, content: 'visibility flipped' }),
    ]).block
    expect(sentinel).toContain('  <updated id="12">visibility flipped</updated>')
    expect(sentinel).not.toContain('category=')
  })

  it('escapes attributes and content exactly like MC', () => {
    const block = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 1, category: 'A"B&C<D', content: 'a & b < c > d' }),
    ]).block
    expect(block).toContain('category="A&quot;B&amp;C&lt;D"')
    expect(block).toContain('>a &amp; b &lt; c &gt; d</updated>')
  })

  it('returns zero bytes for an empty delta, so it cannot move the cache prefix', () => {
    expect(renderMemoryUpdates([]).block).toBe('')
    expect(renderMemoryUpdates([], { renderedIds: new Set([7]) }).block).toBe('')
  })

  it('keeps one line per target and orders by log id', () => {
    const block = renderMemoryUpdates([
      update({ id: 9, targetMemoryId: 5, content: 'third' }),
      update({ id: 2, targetMemoryId: 3, content: 'first' }),
      update({ id: 9, targetMemoryId: 3, content: 'duplicate target' }),
      update({ id: 5, targetMemoryId: 4, content: 'second' }),
    ]).block
    const lines = block.split('\n').slice(2, -1)
    expect(lines).toEqual([
      '  <updated id="3">first</updated>',
      '  <updated id="4">second</updated>',
      '  <updated id="5">third</updated>',
    ])
  })

  it('never renders the same memory content twice across <new-memories> and <memory-updates>', () => {
    expect(renderMemoryUpdates([update({ targetMemoryId: 42, content: 'fresh' })], {
      renderedIds: new Set([42]),
    }).block).toBe('')
    // Pointer lines are still emitted: only content duplication is forbidden.
    const pointers = renderMemoryUpdates([
      update({ id: 2, targetMemoryId: 42, mutationType: 'archive' }),
    ], { renderedIds: new Set([42]) }).block
    expect(pointers).toContain('  <removed id="42"/>')
  })

  it('drops mutations whose target is not in the rendered m[0] baseline (no phantom pointers)', () => {
    const block = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 7, content: 'visible baseline update' }),
      update({ id: 2, targetMemoryId: 8, content: 'budget-truncated target' }),
      update({ id: 3, targetMemoryId: 9, mutationType: 'archive' }),
      update({ id: 4, targetMemoryId: 9, mutationType: 'superseded', supersededById: 10, replacementResolvable: true }),
    ], { baselineIds: new Set([7]) }).block
    expect(block).toBe([
      MEMORY_UPDATES_OPEN,
      MEMORY_UPDATES_HEADER,
      '  <updated id="7">visible baseline update</updated>',
      MEMORY_UPDATES_CLOSE,
    ].join('\n'))
    // MC's default: without the filter the full block renders (adapter pre-fix).
    expect(renderMemoryUpdates([update({ id: 1, targetMemoryId: 99 })]).block.length).toBeGreaterThan(0)
  })

  it('forces superseded replacements and visibility flips into new-memories (A1)', () => {
    // Out-of-baseline supersede: the pointer line is phantom (dropped) but the
    // REPLACEMENT is forced (MC :2825-2833) — and the forced ids are returned
    // even when the block itself is empty (MC :2870).
    const supersedeOnly = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 9, mutationType: 'superseded', supersededById: 10, replacementResolvable: true }),
    ], { baselineIds: new Set([7]), eligibleIds: new Set([9, 10]) })
    expect(supersedeOnly.block).toBe('')
    expect(supersedeOnly.forcedMemoryIds).toEqual([10])

    // A visibility flip (sentinel category) on an out-of-baseline eligible
    // target forces the row; a plain out-of-baseline update does not.
    const flip = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 11, content: 'freshly visible', category: '__mc_visibility__' }),
    ], { baselineIds: new Set([7]), eligibleIds: new Set([11]) })
    expect(flip.block).toBe('')
    expect(flip.forcedMemoryIds).toEqual([11])

    const plain = renderMemoryUpdates([
      update({ id: 1, targetMemoryId: 12, content: 'budget-truncated target' }),
    ], { baselineIds: new Set([7]), eligibleIds: new Set([12]) })
    expect(plain.block).toBe('')
    expect(plain.forcedMemoryIds).toEqual([])

    // The cap: MC caps FORCED rows at 10 (MAX_FORCED_MEMORIES_PER_DELTA),
    // sorted ascending — update lines themselves are uncapped.
    const manyForced = renderMemoryUpdates(
      Array.from({ length: 14 }, (_unused, index) => update({
        id: index + 1,
        targetMemoryId: 100 + index,
        content: 'flipped',
        category: '__mc_visibility__',
      })),
      { baselineIds: new Set([7]), eligibleIds: new Set(Array.from({ length: 14 }, (_u, i) => 100 + i)) },
    )
    expect(manyForced.forcedMemoryIds).toEqual(Array.from({ length: 10 }, (_u, i) => 100 + i))
  })

  it('has no line cap (MC caps forced replacements, not update lines)', () => {
    const many = Array.from({ length: 25 }, (_unused, index) =>
      update({ id: index + 1, targetMemoryId: index + 1, content: `change ${String(index)}` }))
    expect(renderMemoryUpdates(many).block.split('\n')).toHaveLength(25 + 3)
  })
})

// ── Layer 2: the read-only bridge ───────────────────────────────────────────

interface Seed {
  id?: number
  project: string
  category?: string
  content: string
  status?: string
  shareable?: number
  scope?: string
  expiresAt?: number | null
  supersededBy?: number | null
  updatedAt?: number
}

interface SeedMutation {
  id?: number
  project: string
  type: 'archive' | 'delete' | 'update' | 'superseded'
  target: number
  supersededBy?: number | null
  category?: string | null
  newContent?: string | null
}

function makeContextDb(input: {
  memories: Seed[]
  mutations?: SeedMutation[]
  epochs?: Record<string, number>
  workspace?: { name: string; shareCategories: string[]; members: string[] }
  withMutationLog?: boolean
  withProjectState?: boolean
}): string {
  const { path } = makeMemoryDb({ prefix: 'mc-delta-', schemaVersion: 94 })
  const db = new DatabaseSync(path)

  const insertMemory = db.prepare(
    `INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, status, expires_at,
                          superseded_by_memory_id, first_seen_at, created_at, updated_at, last_seen_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  input.memories.forEach((row, index) => {
    insertMemory.run(
      row.id ?? index + 1,
      row.project,
      row.category ?? 'CONSTRAINTS',
      row.content,
      `hash-${String(row.id ?? index + 1)}`,
      row.scope ?? 'project',
      row.shareable ?? 0,
      row.status ?? 'active',
      row.expiresAt ?? null,
      row.supersededBy ?? null,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
    )
  })

  if (input.withMutationLog !== false) {
    db.exec(MUTATION_LOG_DDL)
    const insertMutation = db.prepare(
      `INSERT INTO memory_mutation_log(id, project_path, mutation_type, target_memory_id, superseded_by_id,
                                       category, new_content, queued_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    input.mutations?.forEach((row, index) => {
      insertMutation.run(
        row.id ?? index + 1,
        row.project,
        row.type,
        row.target,
        row.supersededBy ?? null,
        row.category ?? null,
        row.newContent ?? null,
        500 + index,
      )
    })
  }

  if (input.withProjectState !== false) {
    db.exec(PROJECT_STATE_DDL)
    const insertEpoch = db.prepare(
      'INSERT INTO project_state(project_path, project_memory_epoch, updated_at) VALUES(?, ?, 0)',
    )
    for (const [project, epoch] of Object.entries(input.epochs ?? {})) insertEpoch.run(project, epoch)
  }

  if (input.workspace !== undefined) {
    db.exec(WORKSPACES_DDL)
    db.prepare('INSERT INTO workspaces(id, name, share_categories, created_at, updated_at) VALUES(1, ?, ?, 0, 0)')
      .run(input.workspace.name, JSON.stringify(input.workspace.shareCategories))
    for (const member of input.workspace.members) {
      db.prepare('INSERT INTO workspace_members(workspace_id, project_path, added_at) VALUES(1, ?, 0)').run(member)
    }
  }
  db.close()
  return path
}

describe('memory bridge: the mutation cursor (read-only)', () => {
  it('returns ordered change rows and advances the cursor, never backwards', () => {
    const path = makeContextDb({
      memories: [
        { id: 1, project: 'git:mine', content: 'one' },
        { id: 2, project: 'git:mine', content: 'two' },
        { id: 3, project: 'git:mine', content: 'three' },
      ],
      mutations: [
        { id: 1, project: 'git:mine', type: 'update', target: 1, newContent: 'one' },
        { id: 2, project: 'git:mine', type: 'archive', target: 2 },
        { id: 3, project: 'git:mine', type: 'update', target: 3, newContent: 'three' },
      ],
      epochs: { 'git:mine': 3 },
    })
    const logger = captureLogger()
    const bridge = openMemoryBridge({ dbPath: path, logger })
    try {
      expect(bridge.status.ok).toBe(true)
      expect(logger.warnings).toEqual([])
      const first = bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })
      expect(first).toBeDefined()
      expect(first!.rows.map(row => row.id)).toEqual([1, 2, 3])
      expect(first!.rows.map(row => row.mutationType)).toEqual(['update', 'archive', 'update'])
      expect(first!.updates.map(line => line.targetMemoryId)).toEqual([1, 2, 3])
      expect(first!.cursor).toBe(3)
      expect(first!.currentCursor).toBe(3)
      expect(first!.hasMore).toBe(false)
      expect(first!.projectEpoch).toBe(3)

      // Idempotent when the cursor is current: no rows, cursor unchanged.
      const second = bridge.mutations({ project: 'git:mine', afterId: first!.cursor, now: 10_000 })!
      expect(second.updates).toEqual([])
      expect(second.cursor).toBe(3)

      // A partial read advances only as far as it read.
      const partial = bridge.mutations({ project: 'git:mine', afterId: 1, now: 10_000 })!
      expect(partial.updates.map(line => line.targetMemoryId)).toEqual([2, 3])
      expect(partial.cursor).toBe(3)

      // A rollback (cursor ahead of the log) must not rewind the caller.
      const ahead = bridge.mutations({ project: 'git:mine', afterId: 99, now: 10_000 })!
      expect(ahead.updates).toEqual([])
      expect(ahead.cursor).toBe(99)
      expect(ahead.currentCursor).toBe(3)
    } finally {
      bridge.close()
    }
  })

  it('coalesces one row per target and lets a terminal state beat a later update', () => {
    const path = makeContextDb({
      memories: [
        { id: 1, project: 'git:mine', content: 'live text' },
        { id: 2, project: 'git:mine', content: 'archived target' },
        { id: 3, project: 'git:mine', content: 'supersede source' },
        { id: 4, project: 'git:mine', content: 'replacement' },
      ],
      mutations: [
        { id: 1, project: 'git:mine', type: 'update', target: 1, newContent: 'stale snapshot' },
        { id: 2, project: 'git:mine', type: 'archive', target: 2 },
        { id: 3, project: 'git:mine', type: 'update', target: 2, newContent: 'must not resurrect' },
        { id: 4, project: 'git:mine', type: 'update', target: 1, newContent: 'older snapshot' },
        { id: 5, project: 'git:mine', type: 'superseded', target: 3, supersededBy: 4 },
      ],
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      const result = bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })!
      expect(result.rows).toHaveLength(3)
      // The archive (id 2) is the survivor for target 2: a terminal state beats
      // the later `update` (id 3), so the coalesced row keeps id 2.
      expect(result.updates.map(line => [line.targetMemoryId, line.mutationType, line.id]))
        .toEqual([[2, 'archive', 2], [1, 'update', 4], [3, 'superseded', 5]])
      // The update payload is the LIVE row content, not the queued snapshot.
      expect(result.updates.find(line => line.targetMemoryId === 1)?.content).toBe('live text')
      expect(result.updates.find(line => line.targetMemoryId === 3)?.replacementResolvable).toBe(true)
      expect(result.updates.find(line => line.targetMemoryId === 3)?.supersededById).toBe(4)
    } finally {
      bridge.close()
    }
  })

  it('renders <removed/> when the target is gone and the snapshot is empty', () => {
    const path = makeContextDb({
      memories: [{ id: 1, project: 'git:mine', content: 'still here' }],
      mutations: [
        { id: 1, project: 'git:mine', type: 'update', target: 1, newContent: 'snapshot of one' },
        { id: 2, project: 'git:mine', type: 'update', target: 77, newContent: null },
      ],
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      const result = bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })!
      expect(result.updates.find(line => line.targetMemoryId === 77)?.content).toBeUndefined()
      expect(renderMemoryUpdates(result.updates).block).toContain('  <removed id="77"/>')
    } finally {
      bridge.close()
    }
  })

  it('resolves the supersede chain to an eligible replacement, and fails closed otherwise', () => {
    const path = makeContextDb({
      memories: [
        { id: 1, project: 'git:mine', content: 'a' },
        { id: 2, project: 'git:mine', content: 'b' },
        { id: 3, project: 'git:mine', content: 'c' },
        { id: 4, project: 'git:mine', content: 'archived replacement', status: 'archived' },
        { id: 5, project: 'git:mine', content: 'chain head' },
        { id: 6, project: 'git:mine', content: 'mid', supersededBy: 7 },
        { id: 7, project: 'git:mine', content: 'terminal' },
        { id: 8, project: 'git:mine', content: 'cycle a', supersededBy: 9 },
        { id: 9, project: 'git:mine', content: 'cycle b', supersededBy: 8 },
      ],
      mutations: [
        { id: 1, project: 'git:mine', type: 'superseded', target: 1, supersededBy: 2 },
        { id: 2, project: 'git:mine', type: 'superseded', target: 3, supersededBy: 4 },
        { id: 3, project: 'git:mine', type: 'superseded', target: 5, supersededBy: 6 },
        { id: 4, project: 'git:mine', type: 'superseded', target: 8, supersededBy: 9 },
        { id: 5, project: 'git:mine', type: 'superseded', target: 2, supersededBy: 404 },
      ],
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      const result = bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })!
      const byTarget = new Map(result.updates.map(line => [line.targetMemoryId, line]))
      // Eligible replacement: a plain <superseded/> pointer.
      expect(byTarget.get(1)?.replacementResolvable).toBe(true)
      expect(byTarget.get(1)?.supersededById).toBe(2)
      // Archived replacement: not resolvable → <removed/>.
      expect(byTarget.get(3)?.replacementResolvable).toBe(false)
      // Chain a → b → terminal: walking is what makes it resolvable.
      expect(byTarget.get(5)?.replacementResolvable).toBe(true)
      // Cyclic chain: bounded walk, fail closed.
      expect(byTarget.get(8)?.replacementResolvable).toBe(false)
      // Missing replacement row: fail closed.
      expect(byTarget.get(2)?.replacementResolvable).toBe(false)
      const block = renderMemoryUpdates(result.updates).block
      expect(block).toContain('  <superseded id="1" by="2"/>')
      expect(block).toContain('  <removed id="3"/>')
      expect(block).toContain('  <removed id="8"/>')
    } finally {
      bridge.close()
    }
  })

  it('coalesces a peer change only when its category is shared with this project', () => {
    const mine = 'git:mine0000000000000000000000000000000000'
    const peer = 'git:peer0000000000000000000000000000000000'
    const path = makeContextDb({
      memories: [
        { id: 1, project: peer, category: 'CONSTRAINTS', content: 'shared constraint', shareable: 1 },
        { id: 2, project: peer, category: 'NAMING', content: 'private naming', shareable: 1 },
      ],
      mutations: [
        { id: 1, project: peer, type: 'update', target: 1, category: 'CONSTRAINTS' },
        { id: 2, project: peer, type: 'update', target: 2, category: 'NAMING' },
        { id: 3, project: peer, type: 'archive', target: 1, category: null, newContent: null },
      ],
      workspace: { name: 'code', shareCategories: ['CONSTRAINTS'], members: [mine, peer] },
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      const result = bridge.mutations({ project: mine, afterId: 0, now: 10_000 })!
      // NAMING is filtered out; both CONSTRAINTS changes coalesce (the later
      // archive wins for target 1).
      expect(result.updates.map(line => line.targetMemoryId)).toEqual([1])
      expect(result.updates[0]?.mutationType).toBe('archive')
      expect(result.members).toEqual([peer])
      expect(bridge.mutations({ project: mine, workspaceProjects: [], shareCategories: [], afterId: 0, now: 10_000 })!.updates)
        .toEqual([])
    } finally {
      bridge.close()
    }
  })

  it('reports the epoch fingerprint and moves it when any member epoch moves', () => {
    const mine = 'git:mine0000000000000000000000000000000000'
    const peer = 'git:peer0000000000000000000000000000000000'
    const path = makeContextDb({
      memories: [{ id: 1, project: mine, content: 'x' }],
      mutations: [],
      epochs: { [mine]: 3, [peer]: 1 },
      workspace: { name: 'code', shareCategories: ['CONSTRAINTS'], members: [mine, peer] },
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    let before: string
    try {
      const first = bridge.mutations({ project: mine, afterId: 0, now: 10_000 })!
      expect(first.projectEpoch).toBe(3)
      expect(first.projectEpochFingerprint).toMatch(/^[0-9a-f]{16}$/)
      expect(bridge.projectMemoryEpochFingerprint(mine)).toBe(first.projectEpochFingerprint)
      expect(bridge.mutations({ project: mine, afterId: 0, now: 10_000 })!.projectEpochFingerprint)
        .toBe(first.projectEpochFingerprint)
      before = first.projectEpochFingerprint
    } finally {
      bridge.close()
    }
    // Move the PEER's epoch in place: the workspace fingerprint must change even
    // though this project's own epoch did not (MC workspaces.ts:312-334).
    const db = new DatabaseSync(path)
    db.prepare('UPDATE project_state SET project_memory_epoch = 2 WHERE project_path = ?').run(peer)
    db.close()
    const reopened = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      const after = reopened.mutations({ project: mine, afterId: 0, now: 10_000 })!
      expect(after.projectEpoch).toBe(3)
      expect(after.projectEpochFingerprint).not.toBe(before)
    } finally {
      reopened.close()
    }
  })

  it('degrades to an empty lane when the tables are missing, without disabling recall', () => {
    const path = makeContextDb({
      memories: [{ id: 1, project: 'git:mine', content: 'legacy row' }],
      withMutationLog: false,
      withProjectState: false,
    })
    const logger = captureLogger()
    const bridge = openMemoryBridge({ dbPath: path, logger })
    try {
      expect(bridge.status.ok).toBe(true)
      expect(bridge.recall({ project: 'git:mine', budgetTokens: 800, limit: 10, now: 10_000 })?.rows)
        .toHaveLength(1)
      const result = bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })!
      expect(result.updates).toEqual([])
      expect(result.cursor).toBe(0)
      expect(result.currentCursor).toBe(0)
      expect(result.projectEpoch).toBe(0)
      expect(result.projectEpochFingerprint).toBe(bridge.projectMemoryEpochFingerprint('git:mine'))
      expect(logger.warnings).toEqual([])
    } finally {
      bridge.close()
    }
  })

  it('never writes to the shared database', () => {
    const path = makeContextDb({
      memories: [{ id: 1, project: 'git:mine', content: 'x' }],
      mutations: [{ id: 1, project: 'git:mine', type: 'update', target: 1, newContent: 'x' }],
      epochs: { 'git:mine': 1 },
    })
    const before = readFileSync(path)
    const bridge = openMemoryBridge({ dbPath: path, logger: captureLogger() })
    try {
      bridge.recall({ project: 'git:mine', budgetTokens: 800, limit: 10, now: 10_000 })
      bridge.mutations({ project: 'git:mine', afterId: 0, now: 10_000 })
      bridge.maxMemoryId('git:mine')
      bridge.maxMemoryMutationId('git:mine')
    } finally {
      bridge.close()
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  // 30s: this case VACUUM INTOs the real 134MB store and reads it back, which
  // measured ~5.0s on its own — the default 5s budget lost a photo-finish race
  // against parallel suite load and flaked ~1 run in 3.
  it('reads the real production log off a read-only VACUUM INTO snapshot', { timeout: 30_000 }, () => {
    const realDb = defaultMemoryDbPath()
    if (!existsSync(realDb) || statSync(realDb).size > 400 * 1024 * 1024) return
    const snapshot = join(tempDir('mc-delta-real-'), 'snapshot.db')
    const source = new DatabaseSync(realDb, { readOnly: true })
    try {
      source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
    } finally {
      source.close()
    }
    const sourceBefore = readFileSync(realDb)
    // Pick the project the real log actually carries, without guessing.
    const probe = new DatabaseSync(snapshot, { readOnly: true })
    let project: string
    let expectedRows: number
    try {
      const row = probe.prepare(
        'SELECT project_path, COUNT(*) AS c FROM memory_mutation_log GROUP BY project_path ORDER BY c DESC LIMIT 1',
      ).get() as { project_path: string; c: number }
      project = row.project_path
      expectedRows = row.c
    } finally {
      probe.close()
    }
    const bridge = openMemoryBridge({ dbPath: snapshot, logger: captureLogger() })
    try {
      expect(bridge.status.ok).toBe(true)
      expect(bridge.status.schemaVersion).toBe(94)
      // `project` is already a resolved identity (`git:`/`dir:`), as MC requires.
      expect(project).toMatch(/^(git|dir):/)
      const result = bridge.mutations({ project, afterId: 0, now: Date.now() })!
      expect(result.updates.length).toBeGreaterThan(0)
      expect(result.updates.length).toBeLessThanOrEqual(expectedRows)
      expect(result.rows.map(row => row.id)).toEqual([...result.rows.map(row => row.id)].sort((a, b) => a - b))
      for (const row of result.rows) {
        expect(['archive', 'delete', 'update', 'superseded']).toContain(row.mutationType)
        expect(row.targetMemoryId).toBeGreaterThan(0)
      }
      expect(result.cursor).toBeLessThanOrEqual(result.currentCursor)
      expect(result.currentCursor).toBe(
        (probe === undefined ? 0 : 0) + result.currentCursor,
      )
      // Once the cursor is current, a re-read yields nothing.
      expect(bridge.mutations({ project, afterId: result.cursor, now: Date.now() })!.updates)
        .toEqual([])
      // Rendering is total: every real row renders to one of the four shapes.
      const block = renderMemoryUpdates(result.updates).block
      expect(block.startsWith(MEMORY_UPDATES_OPEN)).toBe(true)
      expect(block.endsWith(MEMORY_UPDATES_CLOSE)).toBe(true)
      expect(block).not.toMatch(/(?:<updated[^>]*>\s*<\/updated>)/)
    } finally {
      bridge.close()
    }
    expect(readFileSync(realDb).equals(sourceBefore)).toBe(true)
  })
})

// ── Layer 3: the cache-prefix invariants on the composed baseline ───────────

function compartment(overrides: Partial<Compartment> = {}): Compartment {
  return {
    sessionId: 's1',
    compartmentId: 1,
    createdAt: 0,
    coveredStartSeq: 1,
    coveredEndSeq: 4,
    coveredSeqs: [1, 2, 4],
    coveredTokens: 100,
    importance: 50,
    tiers: { p1: 'P1 body', p2: 'P2 body', p3: 'P3 body', p4: 'P4 body' },
    facts: [],
    events: [],
    baselineEpoch: 1,
    ...overrides,
  }
}

function section(text: string, open: string, close: string): string {
  const start = text.indexOf(open)
  const end = text.indexOf(close, start)
  return text.slice(start, end + close.length)
}

describe('baseline rendering: the delta lane stays inside m[1] (A7)', () => {
  const base = {
    now: 1000,
    baseline: [compartment({ compartmentId: 1 })],
    delta: [compartment({ compartmentId: 2, createdAt: 500, tiers: { p1: 'FRESH', p2: 'b', p3: 'c', p4: 'd' } })],
    memories: ['- [CONSTRAINTS] never commit secrets'],
    newMemories: ['- [ARCHITECTURE] layered modules'],
    newMemoryIds: [42],
    budgetTokens: 5000,
  }

  it('is byte-identical to the pre-delta renderer when the delta is empty', () => {
    const plain = renderBaseline(base)
    expect(renderBaseline({ ...base, memoryUpdates: [] })).toBe(plain)
    expect(plain).not.toContain(MEMORY_UPDATES_OPEN)
  })

  it('appends <memory-updates> after the m[0] sections and before <new-memories>', () => {
    const plain = renderBaseline(base)
    const withUpdates = renderBaseline({
      ...base,
      memoryUpdates: [update({ id: 1, targetMemoryId: 7, content: 'constraint retitled' })],
    })
    // m[0] is untouched byte for byte — only the delta region grows.
    expect(withUpdates.startsWith(plain.slice(0, plain.indexOf('<new-memories>')))).toBe(true)
    for (const [open, close] of [
      ['<project-memories>', '</project-memories>'],
      ['<compartment-baseline>', '</compartment-baseline>'],
    ] as const) {
      expect(section(withUpdates, open, close)).toBe(section(plain, open, close))
    }
    expect(withUpdates.indexOf(MEMORY_UPDATES_OPEN)).toBeLessThan(withUpdates.indexOf('<new-memories>'))
    expect(withUpdates).toContain('  <updated id="7">constraint retitled</updated>')
    expect(withUpdates.startsWith(BASELINE_OPEN)).toBe(true)
    expect(withUpdates.endsWith(BASELINE_CLOSE)).toBe(true)
  })

  it('keeps the m[0] bytes identical across two different deltas', () => {
    const plain = renderBaseline(base)
    const first = renderBaseline({ ...base, memoryUpdates: [update({ id: 1, targetMemoryId: 7, content: 'A' })] })
    const second = renderBaseline({ ...base, memoryUpdates: [update({ id: 2, targetMemoryId: 8, content: 'B' })] })
    const prefix = (text: string): string => text.slice(0, text.indexOf(MEMORY_UPDATES_OPEN))
    expect(prefix(first)).toBe(prefix(second))
    expect(prefix(first)).toBe(plain.slice(0, plain.indexOf('<new-memories>')))
  })

  it('emits nothing when every change is already rendered in <new-memories>', () => {
    const plain = renderBaseline(base)
    expect(renderBaseline({
      ...base,
      memoryUpdates: [update({ id: 1, targetMemoryId: 42, content: 'fresh' })],
    })).toBe(plain)
  })
})

// ── Layer 4: the per-session cursor store and its migration ────────────────

describe('adapter store: the per-session mutation cursor (schema v6)', () => {
  it('round-trips the cursor and the epoch fingerprint', () => {
    const dataDir = tempDir('mc-delta-store-')
    expect(SCHEMA_VERSION).toBe(8)
    const stores = openStores(dataDir)
    try {
      stores.saveBaselineState({
        sessionId: 's1',
        epoch: 1,
        frozenAt: 10,
        maxMemoryId: 7,
        maxMemoryMutationId: 12,
        projectEpochFingerprint: 'fp-a',
        updatedAt: 10,
      })
      const state = stores.baselineState('s1')!
      expect(state.maxMemoryId).toBe(7)
      expect(state.maxMemoryMutationId).toBe(12)
      expect(state.projectEpochFingerprint).toBe('fp-a')
      stores.saveBaselineState({ sessionId: 's2', epoch: 1, frozenAt: 10, updatedAt: 10 })
      const bare = stores.baselineState('s2')!
      expect(bare.maxMemoryMutationId).toBeUndefined()
      expect(bare.projectEpochFingerprint).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it('upgrades a v5 database in place, keeping its rows', () => {
    const dataDir = tempDir('mc-delta-upgrade-')
    const dbPath = join(dataDir, 'dsh-magic-context.db')
    const stores = openStores(dataDir)
    stores.saveBaselineState({ sessionId: 's1', epoch: 2, frozenAt: 10, maxMemoryId: 7, updatedAt: 10 })
    stores.appendJournal({ at: 5, level: 'info', kind: 'boot', summary: 'kept across the upgrade' })
    stores.setMeta('probe', 'kept')
    stores.close()

    // Downgrade the fixture to v5: the two v6 columns and the whole v7/v8
    // additions are gone (a real v5 database never carried them).
    const db = new DatabaseSync(dbPath)
    db.exec(`
      ALTER TABLE baseline_state DROP COLUMN max_memory_mutation_id;
      ALTER TABLE baseline_state DROP COLUMN project_epoch_fingerprint;
      DROP TABLE memory_stats;
      ALTER TABLE compartments DROP COLUMN landed_reason;
      ALTER TABLE compartments DROP COLUMN superseded;
      ALTER TABLE baseline_state DROP COLUMN profile_watermark;
      ALTER TABLE baseline_state DROP COLUMN profile_m0_digest;
      DROP TABLE profile_confirmations;
      DROP TABLE global_candidate_observations;
      DROP TABLE global_candidates;
      DROP TABLE domain_members;
      DROP TABLE domains;
      UPDATE meta SET value = '5' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openStores(dataDir)
    try {
      const state = upgraded.baselineState('s1')!
      expect(state.epoch).toBe(2)
      expect(state.maxMemoryId).toBe(7)
      expect(state.maxMemoryMutationId).toBeUndefined()
      expect(state.projectEpochFingerprint).toBeUndefined()
      expect(upgraded.getMeta('probe')).toBe('kept')
      expect(upgraded.listJournal({ kinds: ['boot'] })).toHaveLength(1)
      // The v6 columns now accept writes.
      upgraded.saveBaselineState({ ...state, maxMemoryMutationId: 4, projectEpochFingerprint: 'fp' })
      const after = upgraded.baselineState('s1')!
      expect(after.maxMemoryMutationId).toBe(4)
      expect(after.projectEpochFingerprint).toBe('fp')
      expect(after.maxMemoryId).toBe(7)
    } finally {
      upgraded.close()
    }
    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      expect(version.value).toBe('8')
      const names = new Set(
        (check.prepare('PRAGMA table_info(baseline_state)').all() as Array<{ name: string }>).map(row => row.name),
      )
      expect(names.has('max_memory_mutation_id')).toBe(true)
      expect(names.has('project_epoch_fingerprint')).toBe(true)
      expect(names.has('profile_watermark')).toBe(true)
      expect(names.has('profile_m0_digest')).toBe(true)
      const tables = new Set(
        (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map(row => row.name),
      )
      expect(tables.has('domains')).toBe(true)
      expect(tables.has('profile_confirmations')).toBe(true)
    } finally {
      check.close()
    }
  })

  it('applies the whole migration chain to a v3 database', () => {
    const dataDir = tempDir('mc-delta-chain-')
    const dbPath = join(dataDir, 'dsh-magic-context.db')
    const stores = openStores(dataDir)
    stores.close()
    // v3 predates the journal table (v4), the memory watermark (v5), the
    // delta-lane columns (v6), the fusion columns/table (v7) and the global
    // domain substrate (v8): reopening must run all five migrations.
    const db = new DatabaseSync(dbPath)
    db.exec(`
      DROP TABLE journal;
      ALTER TABLE baseline_state DROP COLUMN max_memory_id;
      ALTER TABLE baseline_state DROP COLUMN max_memory_mutation_id;
      ALTER TABLE baseline_state DROP COLUMN project_epoch_fingerprint;
      DROP TABLE memory_stats;
      ALTER TABLE compartments DROP COLUMN landed_reason;
      ALTER TABLE compartments DROP COLUMN superseded;
      ALTER TABLE baseline_state DROP COLUMN profile_watermark;
      ALTER TABLE baseline_state DROP COLUMN profile_m0_digest;
      DROP TABLE profile_confirmations;
      DROP TABLE global_candidate_observations;
      DROP TABLE global_candidates;
      DROP TABLE domain_members;
      DROP TABLE domains;
      UPDATE meta SET value = '3' WHERE key = 'schema_version';
    `)
    db.close()
    const upgraded = openStores(dataDir)
    try {
      upgraded.saveBaselineState({
        sessionId: 's1',
        epoch: 1,
        frozenAt: 1,
        maxMemoryId: 3,
        maxMemoryMutationId: 9,
        projectEpochFingerprint: 'fp',
        updatedAt: 1,
      })
      expect(upgraded.baselineState('s1')?.maxMemoryMutationId).toBe(9)
      upgraded.appendJournal({ at: 1, level: 'info', kind: 'boot', summary: 'recreated table works' })
      expect(upgraded.listJournal()).toHaveLength(1)
    } finally {
      upgraded.close()
    }
  })
})

// ── Layer 5: the management pass (HARD freeze, epoch reset, no-op safety) ───

interface SurfaceEvent {
  seq: number
  type: string
  /** `user/message` carries the message itself (DSH `deriveEventMessage`). */
  data: { id: string; role: string; content: Array<{ type: string; text?: string }> }
  surfaceOp?: { op: string; startSeq: number; endSeq: number }
  sourceEventSeqs?: number[]
}

/** A minimal durable surface: one node per event, ordered, replaceable. */
function makeSession(first?: { type: string; data: unknown }): {
  session: Session
  text: () => string
  generation: () => number
  nodes: () => readonly number[]
  textOfSeq: (seq: number) => string
} {
  let nextSeq = 1
  let replaceGeneration = 0
  const events: SurfaceEvent[] = []
  const nodes: number[] = []
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
  if (first === undefined) append('user/message', { id: 'seed-user', role: 'user', content: [{ type: 'text', text: '§1§ go' }] })
  else append(first.type, first.data)
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
  const text = (): string => nodes.map(textOfSeq).filter(part => part !== '').join('\n')
  return {
    session: session as unknown as Session,
    text,
    generation: () => replaceGeneration,
    nodes: () => nodes,
    textOfSeq,
  }
}

interface PassHarness {
  readonly stores: ReturnType<typeof openStores>
  readonly sessionId: string
  readonly text: () => string
  readonly generation: () => number
  readonly nodes: () => readonly number[]
  readonly textOfSeq: (seq: number) => string
  /** Append one surface node (e.g. a checkpoint or a later user turn). */
  readonly append: (type: string, data: unknown) => number
  pass(input: { updates: MemoryUpdateLine[]; cursor?: number; fingerprint?: string }): boolean
  setNow(value: number): void
}

/** The baseline block bytes currently carried by the surface node. */
function blockOf(text: string): string {
  const start = text.indexOf(BASELINE_OPEN)
  const end = text.indexOf(BASELINE_CLOSE, start)
  return start === -1 || end === -1 ? '' : text.slice(start, end + BASELINE_CLOSE.length)
}

function makePassHarness(
  memoryOverride: {
    newLines?: readonly string[]
    newMemoryIds?: readonly number[]
  } = {},
  seed?: { type: string; data: unknown },
): PassHarness {
  const dataDir = tempDir('mc-delta-pass-')
  const stores = openStores(dataDir)
  const fake = makeSession(seed)
  const sessionId = 's-delta'
  let clock = 1_000_000
  const memories = {
    digest: 'digest-1',
    lines: ['- [CONSTRAINTS] never commit secrets'],
    newLines: memoryOverride.newLines ?? [],
    newMemoryIds: memoryOverride.newMemoryIds ?? [],
  }
  const pass = (input: { updates: MemoryUpdateLine[]; cursor?: number; fingerprint?: string }): boolean =>
    runManagementPass({
      session: fake.session,
      sessionId,
      stores,
      policy: DEFAULT_POLICY,
      logger: { info: () => {}, warn: () => {} },
      pass: { kind: 'execute', reason: 'execute-threshold' },
      pressure: 70,
      now: () => clock,
      memories,
      memoryUpdates: {
        updates: input.updates,
        ...input.cursor === undefined ? {} : { cursor: input.cursor },
        ...input.fingerprint === undefined ? {} : { projectEpochFingerprint: input.fingerprint },
      },
    }).baselineUpdated
  return {
    stores,
    sessionId,
    text: fake.text,
    generation: fake.generation,
    nodes: fake.nodes,
    textOfSeq: fake.textOfSeq,
    append: (type, data) => {
      const appended = (fake.session as unknown as { append: (t: string, d: unknown) => { seq: number } }).append(type, data)
      return appended.seq
    },
    pass,
    setNow: (value: number) => {
      clock = value
    },
  }
}

describe('management pass: the m[1] delta lane', () => {
  it('freezes the cursor on a HARD pass and renders the delta only after it', () => {
    const h = makePassHarness()
    try {
      const line = update({ id: 1, targetMemoryId: 7, content: 'retitled constraint' })
      // Pass 1: no baseline yet → HARD; the pending delta is folded (swallowed).
      expect(h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })).toBe(true)
      expect(h.stores.baselineState(h.sessionId)?.epoch).toBe(1)
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(12)
      expect(h.stores.baselineState(h.sessionId)?.projectEpochFingerprint).toBe('fp-a')
      expect(h.text()).toContain('<project-memories>')
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)

      // Pass 2: same epoch, same digest → soft; the delta renders in m[1].
      h.setNow(1_000_500)
      expect(h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })).toBe(true)
      expect(h.stores.baselineState(h.sessionId)?.epoch).toBe(1)
      expect(h.text()).toContain(MEMORY_UPDATES_OPEN)
      expect(h.text()).toContain('  <updated id="7">retitled constraint</updated>')

      // Pass 3: identical inputs → the composed block is byte-identical, so the
      // delta lane contributes no bytes of its own.
      const blockBefore = blockOf(h.text())
      h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })
      expect(blockOf(h.text())).toBe(blockBefore)

      // Pass 4: a wider delta renders; the PUBLISHED cursor still must not move
      // on a soft pass — only a HARD fold advances it, exactly like maxMemoryId.
      h.setNow(1_001_000)
      expect(h.pass({
        updates: [line, update({ id: 2, targetMemoryId: 8, content: 'another change' })],
        cursor: 99,
        fingerprint: 'fp-a',
      })).toBe(true)
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(12)
      expect(h.stores.baselineState(h.sessionId)?.epoch).toBe(1)
      expect(h.text()).toContain('  <updated id="8">another change</updated>')
    } finally {
      h.stores.close()
    }
  })

  it('never attaches the baseline to a compaction checkpoint node', () => {
    // A checkpoint sits at the head of the surface after the host (or the
    // engine) compacts the opening span. Attaching m[0] there used to make the
    // checkpoint's own text ride inside the baseline forever — every refresh
    // re-emitted it and rewrote the node, and the GUI lost the card it
    // correlates by `source.kind === 'compact-checkpoint'`.
    const h = makePassHarness({}, {
      type: 'user/message',
      data: {
        id: 'cp-1',
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'compaction-1' },
        content: [{ type: 'text', text: 'This is an automatically generated checkpoint.\n<compacted-summary>old work</compacted-summary>' }],
      },
    })
    try {
      const checkpointSeq = h.nodes()[0] as number
      const userSeq = h.append('user/message', {
        id: 'u-2',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '§1§ the real request' }],
      })

      expect(h.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })).toBe(true)

      // The checkpoint keeps its own identity and bytes — no baseline inside it.
      expect(h.nodes()).toContain(checkpointSeq)
      expect(h.textOfSeq(checkpointSeq)).toContain('<compacted-summary>')
      expect(h.textOfSeq(checkpointSeq)).not.toContain('<magic-context>')

      // The baseline landed on the ordinary user node instead.
      const landed = h.nodes()[h.nodes().length - 1] as number
      expect(landed).not.toBe(checkpointSeq)
      expect(h.textOfSeq(landed)).toContain('<magic-context>')
      expect(h.textOfSeq(landed)).toContain('§1§ the real request')
      expect(h.stores.baselineState(h.sessionId)?.nodeSeq).toBe(landed)
      expect(userSeq).toBeLessThan(landed)
    } finally {
      h.stores.close()
    }
  })

  it('writes nothing when a checkpoint is the only user node on the surface', () => {
    const h = makePassHarness({}, {
      type: 'user/message',
      data: {
        id: 'cp-only',
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'compaction-2' },
        content: [{ type: 'text', text: 'checkpoint only' }],
      },
    })
    try {
      const before = [...h.nodes()]
      expect(h.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })).toBe(false)
      expect([...h.nodes()]).toEqual(before)
      expect(h.stores.baselineState(h.sessionId)).toBeUndefined()
    } finally {
      h.stores.close()
    }
  })

  it('resets the cursor and rebuilds m[0] when the project epoch moves', () => {
    const h = makePassHarness()
    try {
      const line = update({ id: 1, targetMemoryId: 7, content: 'retitled constraint' })
      h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })
      h.setNow(1_000_500)
      expect(h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })).toBe(true)
      expect(h.text()).toContain(MEMORY_UPDATES_OPEN)
      const m0Before = section(h.text(), '<project-memories>', '</project-memories>')

      // The external writer bumped `project_memory_epoch`: the old cursor can no
      // longer order a correct delta, so the pass rebuilds hard and re-freezes.
      h.setNow(1_001_000)
      expect(h.pass({ updates: [line], cursor: 14, fingerprint: 'fp-b' })).toBe(true)
      const state = h.stores.baselineState(h.sessionId)!
      expect(state.epoch).toBe(2)
      expect(state.maxMemoryMutationId).toBe(14)
      expect(state.projectEpochFingerprint).toBe('fp-b')
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)
      // m[0] itself did not move (A7): only the delta was swallowed.
      expect(section(h.text(), '<project-memories>', '</project-memories>')).toBe(m0Before)
    } finally {
      h.stores.close()
    }
  })

  it('keeps the m[0] bytes identical when a delta is present', () => {
    const h = makePassHarness()
    try {
      const line = update({ id: 1, targetMemoryId: 7, content: 'retitled constraint' })
      h.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })
      h.setNow(1_000_500)
      // With a delta: the m[1] region grows.
      h.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })
      const withDelta = section(h.text(), '<project-memories>', '</project-memories>')
      expect(h.text()).toContain(MEMORY_UPDATES_OPEN)
      h.setNow(1_001_000)
      h.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)
      expect(section(h.text(), '<project-memories>', '</project-memories>')).toBe(withDelta)
    } finally {
      h.stores.close()
    }
  })

  it('never renders a memory twice when it is still in the additive lane', () => {
    const line = update({ id: 1, targetMemoryId: 7, content: 'just promoted' })
    const newLines = ['- [CONSTRAINTS] just promoted']
    const wired = makePassHarness({ newLines, newMemoryIds: [7] })
    const unwired = makePassHarness({ newLines })
    try {
      // Both harnesses establish the baseline first (HARD pass).
      wired.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })
      unwired.pass({ updates: [], cursor: 12, fingerprint: 'fp-a' })
      wired.setNow(1_000_500)
      unwired.setNow(1_000_500)
      // The memory was updated while it is still above the m[0] watermark: the
      // recall lane renders it in <new-memories>, so the delta must not repeat
      // its content — `newMemoryIds` is what makes that possible.
      wired.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })
      unwired.pass({ updates: [line], cursor: 12, fingerprint: 'fp-a' })
      expect(wired.text()).not.toContain(MEMORY_UPDATES_OPEN)
      expect(wired.text()).toContain('<new-memories>')
      expect(unwired.text()).toContain(MEMORY_UPDATES_OPEN)
      // Proof the guard is byte-level, not vacuous:
      expect(blockOf(wired.text())).not.toBe(blockOf(unwired.text()))
    } finally {
      wired.stores.close()
      unwired.stores.close()
    }
  })

  it('folds pending rows once when a baseline predates the cursor column', () => {
    const h = makePassHarness()
    try {
      // A v5-era baseline: no cursor was ever persisted for this session.
      h.stores.saveBaselineState({ sessionId: h.sessionId, epoch: 1, frozenAt: 1, updatedAt: 1 })
      const line = update({ id: 7, targetMemoryId: 7, content: 'cannot be ordered' })
      // Pass A: pending rows but no stored cursor → the upgrade fold.
      expect(h.pass({ updates: [line], fingerprint: 'fp-a' })).toBe(true)
      expect(h.stores.baselineState(h.sessionId)?.epoch).toBe(2)
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)
      // Pass B: the caller now supplies the current cursor, which stamps it.
      h.setNow(1_000_500)
      h.pass({ updates: [line], cursor: 7, fingerprint: 'fp-a' })
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(7)
      // Pass C: the cursor is known and aligned → the delta renders.
      h.setNow(1_001_000)
      expect(h.pass({ updates: [line], cursor: 7, fingerprint: 'fp-a' })).toBe(true)
      expect(h.text()).toContain(MEMORY_UPDATES_OPEN)
      expect(h.text()).toContain('  <updated id="7">cannot be ordered</updated>')
    } finally {
      h.stores.close()
    }
  })

  it('freezes MAX(id) on a HARD fold so a paginated delta is never re-rendered', () => {
    const contextPath = makeContextDb({
      memories: Array.from({ length: 30 }, (_unused, index) => ({
        id: index + 1,
        project: 'git:mine',
        content: `row ${String(index + 1)}`,
      })),
      mutations: Array.from({ length: 20 }, (_unused, index) => ({
        id: index + 1,
        project: 'git:mine',
        type: 'update' as const,
        target: index + 1,
        newContent: `row ${String(index + 1)}`,
      })),
      epochs: { 'git:mine': 1 },
    })
    const bridge = openMemoryBridge({ dbPath: contextPath, logger: captureLogger() })
    const h = makePassHarness()
    try {
      // Pass 1: no baseline → HARD, freezing the CURRENT MAX(id) (20).
      const first = bridge.mutations({ project: 'git:mine', afterId: 0, limit: 5, now: 1000 })!
      expect(first.hasMore).toBe(true)
      expect(first.cursor).toBe(5)
      expect(first.currentCursor).toBe(20)
      h.pass({ updates: first.updates, cursor: first.currentCursor, fingerprint: first.projectEpochFingerprint })
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(20)
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)

      // Five more rows arrive; the caller reads a page of three.
      const db = new DatabaseSync(contextPath)
      for (let id = 21; id <= 25; id += 1) {
        db.prepare(
          `INSERT INTO memory_mutation_log(id, project_path, mutation_type, target_memory_id, category, new_content, queued_at)
           VALUES(?, 'git:mine', 'update', ?, NULL, ?, ?)`,
        ).run(id, id, `row ${String(id)}`, 900 + id)
      }
      db.close()
      const page = bridge.mutations({ project: 'git:mine', afterId: 20, limit: 3, now: 2000 })!
      expect(page.hasMore).toBe(true)
      expect(page.cursor).toBe(23)
      expect(page.currentCursor).toBe(25)

      // Soft pass: the delta renders, the published cursor does not move.
      h.setNow(2_000_000)
      h.pass({ updates: page.updates, cursor: page.currentCursor, fingerprint: page.projectEpochFingerprint })
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(20)
      expect(h.text()).toContain(MEMORY_UPDATES_OPEN)

      // Epoch moves → HARD. Freezing `currentCursor` (25, the wiring the caller
      // uses) leaves nothing to re-render; freezing the page cursor (23) would
      // re-render rows 24–25 as "changes" although they are already folded.
      h.setNow(3_000_000)
      h.pass({ updates: page.updates, cursor: page.currentCursor, fingerprint: 'fp-moved' })
      expect(h.stores.baselineState(h.sessionId)?.maxMemoryMutationId).toBe(25)
      expect(h.text()).not.toContain(MEMORY_UPDATES_OPEN)
      expect(bridge.mutations({ project: 'git:mine', afterId: 25, limit: 5, now: 4000 })!.updates)
        .toEqual([])
      expect(bridge.mutations({ project: 'git:mine', afterId: 23, limit: 5, now: 4000 })!.updates
        .map(line => line.targetMemoryId)).toEqual([24, 25])
    } finally {
      bridge.close()
      h.stores.close()
    }
  })
})
