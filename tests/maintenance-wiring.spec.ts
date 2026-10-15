/**
 * Maintenance sweep WIRING — the layer the unit spec cannot see.
 *
 * Every one of the six live failures lived here rather than in
 * `runMaintenanceTick`: the sweep had no identity in a quiet conversation
 * (registration sat in the pass-execute branch, which a session below the
 * compaction threshold never reaches), the llm request was shaped wrong, and
 * the timer itself was never driven by any test. The unit spec hands the tick
 * an identity and calls it directly, so it stays green while the plugin spins.
 *
 * This spec boots the REAL plugin into the real service tree, drives one quiet
 * turn, and advances fake timers to the tick. It fails if identity
 * registration, the timer, the configured route, the llm seam or the verdict
 * application regress - i.e. on the whole class of defects above.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'
import mcDshPlugin from '../src/index.ts'
import { vectorBackfillEnabled } from '../src/dsh/maintenance-wiring.ts'
import { resolveIdentitySpec } from '../src/core/memory-bridge.ts'
import { ROUTE_QUOTA_HOLD_MS } from '../src/core/route-health.ts'
import { makeMemoryDb as makeBareMemoryDb } from './helpers/memory-db'

const tempDirs: string[] = []
const VERIFY_ROUTE = { provider: 'mock-verify', model: 'mock' }

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A memory store seeded with one unverified row owned by `identity`. */
function makeMemoryDb(identity: string): { path: string; id: number } {
  const { path, dir } = makeBareMemoryDb({
    prefix: 'mc-maint-wire-', schemaVersion: 94, mutationLog: true, projectState: true,
  })
  tempDirs.push(dir)
  const db = new DatabaseSync(path)
  const now = Date.now()
  const inserted = db.prepare(
    `INSERT INTO memories(project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at,
       status, verification_status)
     VALUES(?, 'ARCHITECTURE', 'the sweep must reach me', 'hash-sweep-1', 50, 'project', 0,
       'historian', 1, 0, ?, ?, ?, ?, 'active', 'unverified')`,
  ).run(identity, now, now, now, now)
  const id = Number(inserted.lastInsertRowid)
  db.close()
  return { path, id }
}

function rowSnapshot(path: string, id: number): { verificationStatus: string; verifiedAt: number | null } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT verification_status, verified_at FROM memories WHERE id = ?').get(id) as
      { verification_status: string; verified_at: number | null }
    return { verificationStatus: row.verification_status, verifiedAt: row.verified_at }
  } finally {
    db.close()
  }
}

interface Booted {
  ctx: Context
  agent: Agent
  dataDir: string
  journalPath: string
}

/** Boot the real plugin with fake timers already installed, so the 60s first
 * sweep and the interval are ours to drive. `route` pins maintenance's route;
 * pass the session's own route to exercise the quota-skip rule (which only ever
 * suppresses the main conversation's exact route). `dataDir` reuses an existing
 * adapter store (the config-drift test boots the SAME store twice). */
async function boot(options: {
  memoryDbPath: string
  cwd: string
  maintenance: boolean
  route?: { provider: string; model: string }
  dataDir?: string
  memoryOverrides?: Record<string, unknown>
}): Promise<Booted> {
  const dataDir = options.dataDir ?? tempDir('mc-maint-data-')
  const route = options.route ?? VERIFY_ROUTE
  const maintenance = options.maintenance
    ? { maintenance: { intervalMs: 60_000, verifyProvider: route.provider, verifyModel: route.model } }
    : {}
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(mcDshPlugin, {
    dataDir,
    // A tiny conversation must stay BELOW the compaction threshold: that quiet
    // path is exactly where the identity registration used to be missing.
    policy: { executeThreshold: 95, forceThreshold: 99 },
    memory: { dbPath: options.memoryDbPath, ...options.memoryOverrides },
    ...maintenance,
  })
  const agent = await ctx.agentLoop.create(
    SessionId(`mc-maint-${String(Date.now())}`),
    { provider: 'mock', model: 'mock' },
    { cwd: options.cwd },
  )
  return { ctx, agent, dataDir, journalPath: join(dataDir, 'dsh-magic-context.db') }
}

/** One quiet turn, driven by advancing the fake clock until the agent idles. */
async function driveTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  let idle = false
  const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle = true
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  for (let i = 0; i < 600 && !idle; i += 1) await vi.advanceTimersByTimeAsync(10)
  dispose()
  if (!idle) throw new Error('the agent never idled under fake timers')
}

function maintenanceRows(journalPath: string): Array<{ level: string; summary: string; data: Record<string, unknown> }> {
  const db = new DatabaseSync(journalPath, { readOnly: true })
  try {
    return db.prepare("SELECT level, summary, data FROM journal WHERE kind = 'maintenance' ORDER BY id ASC").all()
      .map(row => ({
        level: String(row.level),
        summary: String(row.summary),
        data: JSON.parse(String(row.data ?? '{}')) as Record<string, unknown>,
      }))
  } finally {
    db.close()
  }
}

/** The newest `boot` row (effective switches live in its data.switches). */
function bootRow(journalPath: string): { level: string; data: Record<string, unknown> } {
  const db = new DatabaseSync(journalPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT level, data FROM journal WHERE kind = 'boot' ORDER BY id DESC LIMIT 1").get() as
      { level: string; data: string | null }
    return { level: String(row.level), data: JSON.parse(String(row.data ?? '{}')) as Record<string, unknown> }
  } finally {
    db.close()
  }
}

function driftRows(journalPath: string): Array<{ level: string; summary: string }> {
  const db = new DatabaseSync(journalPath, { readOnly: true })
  try {
    return db.prepare("SELECT level, summary FROM journal WHERE kind = 'config-drift' ORDER BY id ASC").all()
      .map(row => ({ level: String(row.level), summary: String(row.summary) }))
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('maintenance sweep wiring (real plugin, fake clock)', () => {
  it('a quiet session registers its identity, so the first tick verifies a row', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd-')
    const identity = resolveIdentitySpec(cwd)!
    const store = makeMemoryDb(identity)
    const { ctx, agent, journalPath } = await boot({ memoryDbPath: store.path, cwd, maintenance: true })
    try {
      // The boot row carries the EFFECTIVE switch snapshot: "what is on right
      // now" is one query away and needs no profile parse (the lost-key
      // defense, C1). The distribution defaults (2026-10-13) pin as ON.
      const bootLine = bootRow(journalPath)
      const switches = bootLine.data.switches as Record<string, unknown>
      expect(switches.vectorBackfill).toBe(true)
      expect(switches.scoring).toBe(true)
      expect(switches.machine).toBe(true)
      expect(switches.machineAutoStage).toBe(true)
      expect(switches.userCollect).toBe(true)
      expect(switches.userReview).toBe(true)

      // The verdict route is the configured one, not the session's.
      ctx.llm.registerAdapter(['mock-verify'], new MockAdapter([
        textResponse(JSON.stringify({ verdicts: [{ id: store.id, verdict: 'verified' }] })),
      ]))

      await driveTurn(ctx, agent, 'one small question')
      // Quiet: the turn stayed under the threshold, so no pass ever executed.
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      expect(maintenanceRows(journalPath)).toHaveLength(0)

      // 60s later the first sweep runs - and only because preStep registered
      // the session's identity.
      await vi.advanceTimersByTimeAsync(60_000)

      const rows = maintenanceRows(journalPath)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.level).toBe('info')
      expect(rows[0]!.data.route).toBe('mock-verify/mock')
      expect(rows[0]!.data.verified).toBe(1)
      expect(rowSnapshot(store.path, store.id)).toMatchObject({ verificationStatus: 'verified' })
      // banked as metadata only: the memory's content and status are untouched
      expect(rowSnapshot(store.path, store.id).verifiedAt).not.toBeNull()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs on the configured interval and stops when the adapter is disposed', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd2-')
    const identity = resolveIdentitySpec(cwd)!
    const store = makeMemoryDb(identity)
    const { ctx, agent, journalPath } = await boot({ memoryDbPath: store.path, cwd, maintenance: true })
    ctx.llm.registerAdapter(['mock-verify'], new MockAdapter([
      textResponse(JSON.stringify({ verdicts: [{ id: store.id, verdict: 'verified' }] })),
      textResponse(JSON.stringify({ verdicts: [] })),
      textResponse(JSON.stringify({ verdicts: [] })),
    ]))

    await driveTurn(ctx, agent, 'hello')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(maintenanceRows(journalPath)).toHaveLength(1)

    // The interval ticks again 60s later (the second call finds nothing left to
    // verify, which is itself the proof that progress was banked).
    await vi.advanceTimersByTimeAsync(60_000)
    expect(maintenanceRows(journalPath)).toHaveLength(2)

    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(maintenanceRows(journalPath)).toHaveLength(2)
  })

  it('samples process memory once per tick — the long-run growth sentinel', async () => {
    // 0.49.1 (#681) upstream was a per-pass retention leak that only a series
    // would have caught; the static audit (2026-10-15) found no such retention
    // here, so the row per tick is what keeps a future one visible.
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-rss-')
    const store = makeMemoryDb(resolveIdentitySpec(cwd)!)
    const { ctx, agent, journalPath } = await boot({ memoryDbPath: store.path, cwd, maintenance: true })
    await driveTurn(ctx, agent, 'hello')

    const db = new DatabaseSync(journalPath, { readOnly: true })
    const rows = (): Array<{ data: string }> =>
      db.prepare("SELECT data FROM journal WHERE kind = 'memory-sample' ORDER BY id ASC").all() as Array<{ data: string }>

    await vi.advanceTimersByTimeAsync(60_000)
    expect(rows()).toHaveLength(1)
    const sample = JSON.parse(rows()[0]?.data ?? '{}') as { rssMb?: number; heapUsedMb?: number; heapTotalMb?: number }
    expect(sample.rssMb).toBeGreaterThan(0)
    expect(sample.heapUsedMb).toBeGreaterThan(0)
    expect(sample.heapTotalMb).toBeGreaterThan(0)

    // One row per tick, so the trend is readable across days.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rows()).toHaveLength(2)
    db.close()
  })

  it('a sweep ticks without identities only when a session has registered one', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd3-')
    const store = makeMemoryDb(resolveIdentitySpec(cwd)!)
    const { ctx, journalPath } = await boot({ memoryDbPath: store.path, cwd, maintenance: true })
    try {
      // No turn yet: no identity, so the timer fires into an empty sweep and
      // writes nothing (the shape that made the live failure silent).
      await vi.advanceTimersByTimeAsync(60_000)
      expect(maintenanceRows(journalPath)).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  /**
   * The quota hold, end to end on the real wiring. `route-health.spec.ts` proves
   * the arithmetic; this proves the CHAIN: real traffic's `agent/request-error`
   * reaches the observation, the observation suppresses the tick's LLM steps,
   * and the lane re-opens by itself once the hold expires. Until now only the
   * arithmetic and the reporting side had tests — the wiring between them is
   * where the live behaviour actually lives.
   */
  it('holds the LLM steps while the tick route is quota-exhausted, and re-opens after the hold', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd4-')
    const identity = resolveIdentitySpec(cwd)!
    const store = makeMemoryDb(identity)
    // The tick is pinned to the SESSION's own route on purpose: the skip rule
    // only ever suppresses the main conversation's exact route (a provider-keyed
    // skip once stalled a live sibling model).
    const { ctx, agent, journalPath } = await boot({
      memoryDbPath: store.path,
      cwd,
      maintenance: true,
      route: { provider: 'mock', model: 'mock' },
    })
    const adapter = new MockAdapter([
      textResponse('quiet answer'),
      textResponse('second quiet answer'),
      textResponse(JSON.stringify({ verdicts: [{ id: store.id, verdict: 'verified' }] })),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    try {
      // TWO quiet turns: the session's request context is only readable once a
      // request has been logged, and pre-step is what notes the route — so the
      // first turn is what makes the route known, the second what records it.
      await driveTurn(ctx, agent, 'one small question')
      await driveTurn(ctx, agent, 'and one more')
      expect(adapter.requests).toHaveLength(2)

      // Real traffic reports the route exhausted. This event is the ONLY way an
      // observation enters, so feeding it here is what makes the test live.
      await ctx.waterfall(
        'agent/request-error',
        { provider: 'mock', failure: { code: 'QUOTA', message: 'insufficient quota' } },
        async () => ({ kind: 'passthrough' }),
      )

      // First tick inside the hold: one info line, and NOT ONE model request.
      await vi.advanceTimersByTimeAsync(60_000)
      const held = maintenanceRows(journalPath)
      expect(held.some(row => row.summary.startsWith('LLM steps skipped: mock/mock observed quota-exhausted'))).toBe(true)
      expect(adapter.requests).toHaveLength(2)
      expect(rowSnapshot(store.path, store.id)).toMatchObject({ verificationStatus: 'unverified' })

      // past the hold the lane re-opens with no restart and no durable state
      await vi.advanceTimersByTimeAsync(ROUTE_QUOTA_HOLD_MS)
      expect(adapter.requests).toHaveLength(3)
      expect(maintenanceRows(journalPath).some(row => row.data.verified === 1)).toBe(true)
      expect(rowSnapshot(store.path, store.id)).toMatchObject({ verificationStatus: 'verified' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('alarms on the journal when a switch went off between mounts of the same store', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd5-')
    const dataDir = tempDir('mc-maint-data5-')
    const store = makeMemoryDb(resolveIdentitySpec(cwd)!)

    // First mount: defaults (vectorBackfill ON) seed the snapshot silently.
    const first = await boot({ memoryDbPath: store.path, cwd, maintenance: true, dataDir })
    await first.ctx.fiber.dispose()

    // Second mount on the SAME store with the key turned OFF — the exact shape
    // a profile rewrite produces (the 2026-10-11 incident). The drift alarm
    // must name the switch at warn level the moment it happens.
    const second = await boot({
      memoryDbPath: store.path,
      cwd,
      maintenance: true,
      dataDir,
      memoryOverrides: { vectorBackfill: false },
    })
    try {
      const rows = driftRows(second.journalPath)
      expect(rows.some(row => row.level === 'warn' && row.summary.includes('switch went OFF: vectorBackfill'))).toBe(true)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('auto-stages a recurred allowlisted memory into the machine domain (L1① v10)', async () => {
    vi.useFakeTimers()
    const cwd = tempDir('mc-maint-cwd6-')
    const dataDir = tempDir('mc-maint-data6-')
    const store = makeMemoryDb(resolveIdentitySpec(cwd)!)
    // A recurred, allowlisted, project-scope fact in the contract store — the
    // narrow profile the auto-stage lane is allowed to pick up.
    const contract = new DatabaseSync(store.path)
    try {
      contract
        .prepare(
          "INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, "
            + "seen_count, first_seen_at, created_at, updated_at, last_seen_at, status) "
            + "VALUES(1001, ?, 'CONSTRAINTS', '端到端自动入队约束。', 'hash-e2e-machine', 'project', 0, "
            + "2, 1, 1, 1, 1, 'active')",
        )
        .run(resolveIdentitySpec(cwd))
    } finally {
      contract.close()
    }
    // The classifier route rides the maintenance route (v10): without a route
    // nothing stages, so the test must pin one — mirroring the live pin. The
    // SAME adapter serves both lanes because a tick reuses one route: first
    // reply = the verify verdict for the seeded row, second = the classifier's
    // domain verdict (verify runs before auto-stage inside one tick).
    const { ctx, journalPath } = await boot({
      memoryDbPath: store.path,
      cwd,
      maintenance: true,
      dataDir,
      memoryOverrides: { global: { machine: { enabled: true, autoStage: true } } },
    })
    // The classifier is the FIRST LLM consumer of this tick: no session ever
    // ran a turn, so `seenIdentities` is empty and the verify lane (which is
    // per-identity) never fires — the auto-stage classify call is the only one.
    // One reply is what the wiring actually needs; a second reply would
    // silently become the classify input and fail to parse.
    ctx.llm.registerAdapter(['mock-verify'], new MockAdapter([
      textResponse(JSON.stringify({ domain: 'machine', reason: 'machine env' })),
    ]))
    try {
      // The mount projection created the machine domain row (enabled); the
      // first sweep at 60s runs the auto-stage pass.
      await vi.advanceTimersByTimeAsync(60_000)
      const adapter = new DatabaseSync(join(dataDir, 'dsh-magic-context.db'), { readOnly: true })
      try {
        const row = adapter
          .prepare("SELECT domain_id, state, source_memory_id, suggested_domain FROM global_candidates WHERE source_memory_id = 1001")
          .get() as { domain_id: string; state: string; source_memory_id: number; suggested_domain: string | null } | undefined
        expect(row).toMatchObject({ domain_id: 'dir:global:machine', state: 'pending', source_memory_id: 1001, suggested_domain: 'machine' })
      } finally {
        adapter.close()
      }
      const jdb = new DatabaseSync(journalPath, { readOnly: true })
      try {
        const promoted = jdb
          .prepare("SELECT summary FROM journal WHERE kind = 'memory-promote' AND summary LIKE 'auto-staged%'")
          .all()
        expect(promoted.length).toBeGreaterThanOrEqual(1)
      } finally {
        jdb.close()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('vectorBackfill default (WP11 gate)', () => {
  it('is ON for a config that never mentions it — a fresh install backfills', () => {
    expect(vectorBackfillEnabled(undefined)).toBe(true)
    expect(vectorBackfillEnabled({})).toBe(true)
  })

  it('stays operator-off-able with an explicit false', () => {
    expect(vectorBackfillEnabled({ vectorBackfill: false })).toBe(false)
    expect(vectorBackfillEnabled({ vectorBackfill: true })).toBe(true)
  })
})