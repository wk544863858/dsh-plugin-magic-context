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
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin from '<path>'
import { resolveIdentitySpec } from '<path>'

const tempDirs: string[] = []
const VERIFY_ROUTE = { provider: 'mock-verify', model: 'mock' }

/** Magic Context's `memories` DDL plus the tables the writer touches. */
const MEMORIES_DDL = `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    importance INTEGER,
    scope TEXT NOT NULL DEFAULT 'project',
    shareable INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT,
    source_type TEXT DEFAULT 'historian',
    seen_count INTEGER DEFAULT 1,
    retrieval_count INTEGER DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_retrieved_at INTEGER,
    status TEXT DEFAULT 'active',
    expires_at INTEGER,
    verification_status TEXT DEFAULT 'unverified',
    verified_at INTEGER,
    classified_at INTEGER,
    superseded_by_memory_id INTEGER,
    merged_from TEXT,
    metadata_json TEXT,
    mural_cue TEXT,
    mural_cue_hash TEXT,
    mural_cue_at INTEGER,
    mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_path, category, normalized_hash)
  );
  CREATE TABLE memory_mutation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
    target_memory_id INTEGER NOT NULL,
    superseded_by_id INTEGER,
    category TEXT,
    new_content TEXT,
    queued_at INTEGER NOT NULL
  );
  CREATE TABLE project_state (
    project_path TEXT PRIMARY KEY,
    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER);
`

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A memory store seeded with one unverified row owned by `identity`. */
function makeMemoryDb(identity: string): { path: string; id: number } {
  const path = join(tempDir('mc-maint-wire-'), 'context.db')
  const db = new DatabaseSync(path)
  db.exec(MEMORIES_DDL)
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(94, 0)').run()
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
 * sweep and the interval are ours to drive. */
async function boot(options: {
  memoryDbPath: string
  cwd: string
  maintenance: boolean
}): Promise<Booted> {
  const dataDir = tempDir('mc-maint-data-')
  const maintenance = options.maintenance
    ? { maintenance: { intervalMs: 60_000, verifyProvider: VERIFY_ROUTE.provider, verifyModel: VERIFY_ROUTE.model } }
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
    memory: { dbPath: options.memoryDbPath },
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
})
