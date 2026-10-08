/**
 * task-9: the memory gate, `retrieval_count` telemetry and the storage-contract
 * fence.
 *
 * Three deliverables, three describes:
 *
 *  ① `memory.enabled` — absent configuration turns the whole memory block off
 *     (no bridge, no writer, no `ctx_memory` registration), explicit `false`
 *     reports `disabled-by-config`, and the enabled path still registers the
 *     tool. Asserted through a REAL plugin boot, because the gate lives in
 *     `src/index.ts` and its failure mode (a half-open adapter that recalls but
 *     cannot write, or a tool that exists with no store behind it) is only
 *     observable there.
 *
 *  ② `retrieval_count` / `last_retrieved_at` — MC's explicit-retrieval
 *     telemetry (write contract §9.1) as `MemoryWriter.recordRetrieval`.
 *
 *  ③ the contract fence — reading `schema_migrations` at open time and
 *     DOWNGRADING TO READ-ONLY when the database is newer than the adapter
 *     (v94). A v95+ store must never be written by this adapter: unknown DDL
 *     means unknown invariants.
 *
 * Every database here is a throwaway under the OS temp dir. The user's real
 * `context.db` is never opened, let alone written.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import mcDshPlugin, { openStores } from '<path>'
import {
  normalizedMemoryHash,
  openMemoryWriter,
} from '<path>'
import { defineCtxMemoryTool } from '<path>'

const OWN = 'git:1111111111111111111111111111111111111111'
const OTHER = 'git:2222222222222222222222222222222222222222'
/** MC's own schema version, and one published revision past it. */
const SUPPORTED = 94
const NEWER = 95

const T0 = 1_700_000_000_000

const tempDirs: string[] = []
const disposers: Array<() => Promise<void> | void> = []

const silentLogger = { info: () => {}, warn: () => {} }

function collectingLogger(): { readonly messages: string[]; info: (m: string) => void; warn: (m: string) => void } {
  const messages: string[] = []
  return {
    messages,
    info: (message: string) => { messages.push(`info:${message}`) },
    warn: (message: string) => { messages.push(`warn:${message}`) },
  }
}

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
  CREATE TABLE authority_managed (
    project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL);
  CREATE TABLE authority_repair_pending (
    project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
  CREATE TABLE context_privilege_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)));
  INSERT INTO context_privilege_state(id, enabled) VALUES(1, 0);

  CREATE TRIGGER memories_authority_guard_insert
  BEFORE INSERT ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

  CREATE TRIGGER memories_authority_guard_update
  BEFORE UPDATE ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

  CREATE TRIGGER memories_authority_guard_delete
  BEFORE DELETE ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
`

/**
 * An isolated store. `version: null` builds a LEGACY database with no
 * `schema_migrations` table at all (the fence then cannot read a version).
 */
function createDb(version: number | null = SUPPORTED): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-fence-'))
  tempDirs.push(dir)
  const path = join(dir, 'context.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(MEMORIES_DDL)
    if (version !== null) {
      db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, 0)').run(version)
    }
  } finally {
    db.close()
  }
  return path
}

/** Push the store past v94 (the migration a future MC release would apply). */
function withSchemaVersion(path: string, version: number): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, 0)').run(version)
  } finally {
    db.close()
  }
}

function run(path: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function one<T>(path: string, sql: string, ...params: Array<string | number | null>): T | undefined {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).get(...params) as unknown as T | undefined
  } finally {
    db.close()
  }
}

function count(path: string, sql: string, ...params: Array<string | number | null>): number {
  return one<{ c: number }>(path, sql, ...params)?.c ?? 0
}

interface SeedMemory {
  readonly project: string
  readonly category?: string
  readonly content: string
  readonly seenCount?: number
  readonly retrievalCount?: number
  readonly updatedAt?: number
  readonly lastSeenAt?: number
  readonly lastRetrievedAt?: number | null
  readonly status?: string
}

function seedMemory(path: string, row: SeedMemory): number {
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
         last_seen_at, last_retrieved_at, status, verification_status)
       VALUES(?, ?, ?, ?, 50, 'project', 0, 'agent', ?, ?, 0, 0, ?, ?, ?, ?, 'unverified')`,
    ).run(
      row.project,
      row.category ?? 'CONSTRAINTS',
      row.content,
      normalizedMemoryHash(row.content),
      row.seenCount ?? 1,
      row.retrievalCount ?? 0,
      row.updatedAt ?? 1000,
      row.lastSeenAt ?? row.updatedAt ?? 1000,
      row.lastRetrievedAt ?? null,
      row.status ?? 'active',
    )
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

interface TelemetryRow {
  retrieval_count: number
  last_retrieved_at: number | null
  seen_count: number
  updated_at: number
  last_seen_at: number
}

function telemetry(path: string, id: number): TelemetryRow {
  const row = one<TelemetryRow>(
    path,
    'SELECT retrieval_count, last_retrieved_at, seen_count, updated_at, last_seen_at FROM memories WHERE id = ?',
    id,
  )
  if (row === undefined) throw new Error(`memory ${String(id)} disappeared`)
  return row
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      await dispose()
    } catch {
      /* best effort */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('the storage-contract fence (task-9 ③)', () => {
  it('opens a v95 store READ-ONLY: reads survive, every mutation is refused', () => {
    const path = createDb(SUPPORTED)
    const id = seedMemory(path, { project: OWN, content: 'the fence keeps this row readable' })
    withSchemaVersion(path, NEWER)
    const logger = collectingLogger()
    const writer = openMemoryWriter({ dbPath: path, logger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(true)
      expect(writer.status.contractVersion).toBe(NEWER)
      expect(writer.status.readOnly).toBe(true)
      expect(writer.status.detail).toContain(`v${String(NEWER)}`)
      expect(writer.status.detail).toContain(`v${String(SUPPORTED)}`)
      expect(writer.status.detail).toContain('READ-ONLY')

      // Reads are unaffected: the fence is about invariants we do not know.
      expect(writer.getMemory(OWN, id)?.content).toBe('the fence keeps this row readable')
      expect(writer.listMemories(OWN)).toHaveLength(1)

      for (const [operation, result] of [
        ['write', writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'must not land' })],
        ['update', writer.updateMemory({ identity: OWN, id, content: 'must not land either' })],
        ['archive', writer.archiveMemory({ identity: OWN, id })],
        ['merge', writer.mergeMemory({ identity: OWN, targetId: id, sourceIds: [id + 1], content: 'nope' })],
      ] as const) {
        expect(result.ok, `${operation} must be refused`).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toBe('contract-version-unsupported')
        expect(result.detail).toContain('READ-ONLY')
        expect(result.detail).toContain(`v${String(NEWER)}`)
      }

      // Promotion is a write too: it must not even attempt the insert.
      const promoted = writer.promoteFacts({
        identity: OWN,
        facts: [{ category: 'CONSTRAINTS', content: 'promotion must not land' }],
      })
      expect(promoted.inserted).toHaveLength(0)
      expect(promoted.skipped).toHaveLength(0)
      expect(promoted.authorityBlocked).toBe(true)

      // Nothing moved except the row we seeded by hand.
      expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(1)
      expect(count(path, 'SELECT COUNT(*) AS c FROM memory_mutation_log')).toBe(0)
      expect(count(path, 'SELECT COUNT(*) AS c FROM project_state')).toBe(0)
      expect(one<{ content: string }>(path, 'SELECT content FROM memories WHERE id = ?', id)?.content)
        .toBe('the fence keeps this row readable')

      expect(logger.messages.some(message => message.includes('newer than the adapter understands'))).toBe(true)
    } finally {
      writer.close()
    }
  })

  it('keeps a v94 store writable and reports the version it read', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(true)
      expect(writer.status.contractVersion).toBe(SUPPORTED)
      expect(writer.status.readOnly).toBeUndefined()

      const result = writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'v94 still writes' })
      expect(result.ok).toBe(true)
      expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(1)
    } finally {
      writer.close()
    }
  })

  it('leaves a legacy store with no schema_migrations unfenced', () => {
    // Reachable only from a direct caller: the reader refuses a database whose
    // version it cannot recognize, so the host never opens a writer with it.
    const path = createDb(null)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(true)
      expect(writer.status.contractVersion).toBeUndefined()
      expect(writer.status.readOnly).toBeUndefined()
      expect(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'legacy write' }).ok).toBe(true)
    } finally {
      writer.close()
    }
  })

  it('surfaces the fence through ctx_memory instead of a write that half-happens', async () => {
    const path = createDb(NEWER)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const tool = defineCtxMemoryTool({
        writer,
        resolveIdentity: () => OWN,
        recall: () => undefined,
      }) as { execute(args: unknown, exec: unknown): Promise<unknown> }
      const result = await tool.execute(
        { action: 'write', category: 'NAMING', content: 'must not land' },
        { callId: 'c1', name: 'ctx_memory', agent: { session: { id: 'ses-fence', header: { cwd: 'D:/work' } } } },
      ) as { outcome?: string; detail?: string }
      expect(result.outcome).toBe('write refused (contract-version-unsupported).')
      expect(result.detail).toContain('READ-ONLY')
      expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(0)
    } finally {
      writer.close()
    }
  })
})

describe('explicit-retrieval telemetry (task-9 ②)', () => {
  it('counts one retrieval per id and leaves updated_at alone', () => {
    const path = createDb()
    const id = seedMemory(path, { project: OWN, content: 'retrieved explicitly', updatedAt: 1000, lastSeenAt: 900 })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const first = writer.recordRetrieval({ identity: OWN, ids: [id] })
      expect(first).toEqual({ ok: true, recorded: [id], skipped: [] })

      const after = telemetry(path, id)
      expect(after.retrieval_count).toBe(1)
      expect(after.last_retrieved_at).toBe(T0)
      // `seen_count` is WRITE dedup, not an injection counter (§9.2).
      expect(after.seen_count).toBe(1)
      expect(after.last_seen_at).toBe(900)
      // The divergence that keeps m[0] cache-stable: memory-bridge.ts composes
      // the pool digest from `id:updatedAt` and orders the pool by `updatedAt`,
      // so a retrieval must not move it (MC's statement does set it).
      expect(after.updated_at).toBe(1000)

      const second = writer.recordRetrieval({ identity: OWN, ids: [id, id] })
      expect(second).toEqual({ ok: true, recorded: [id], skipped: [] })
      expect(telemetry(path, id).retrieval_count).toBe(2)
      expect(telemetry(path, id).updated_at).toBe(1000)
      // Telemetry is not a write: no mutation-log delta, no epoch bump.
      expect(count(path, 'SELECT COUNT(*) AS c FROM memory_mutation_log')).toBe(0)
      expect(count(path, 'SELECT COUNT(*) AS c FROM project_state')).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('skips ids this project does not own, unknown ids and malformed ids', () => {
    const path = createDb()
    const mine = seedMemory(path, { project: OWN, content: 'mine' })
    const foreign = seedMemory(path, { project: OTHER, content: 'not mine' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = writer.recordRetrieval({ identity: OWN, ids: [mine, foreign, 999_999, 0, -3, 1.5] })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('unreachable')
      expect(outcome.recorded).toEqual([mine])
      expect(outcome.skipped).toEqual([foreign, 999_999, 0, -3, 1.5])

      expect(telemetry(path, mine).retrieval_count).toBe(1)
      expect(telemetry(path, foreign).retrieval_count).toBe(0)
      expect(telemetry(path, foreign).last_retrieved_at).toBeNull()
    } finally {
      writer.close()
    }
  })

  it('is telemetry, not correctness: an empty batch and a missing identity are reported, never thrown', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.recordRetrieval({ identity: OWN, ids: [] })).toEqual({ ok: true, recorded: [], skipped: [] })
      expect(writer.recordRetrieval({ identity: '', ids: [1, 2] })).toEqual({
        ok: false,
        recorded: [],
        skipped: [1, 2],
        reason: 'invalid-argument',
      })
      expect(writer.recordRetrieval({ identity: OWN, ids: [0, -1] })).toEqual({
        ok: true,
        recorded: [],
        skipped: [0, -1],
      })
    } finally {
      writer.close()
    }
  })

  it('skips the bump under module authority instead of failing the caller (§9.1)', () => {
    const path = createDb()
    const id = seedMemory(path, { project: OWN, content: 'module managed' })
    run(
      path,
      'INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES(?, ?, ?)',
      OWN,
      'store-uuid',
      T0,
    )
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = writer.recordRetrieval({ identity: OWN, ids: [id] })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toBe('authority-blocked')
      expect(outcome.skipped).toEqual([id])
      expect(telemetry(path, id).retrieval_count).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('refuses the bump on a fenced store without writing', () => {
    const path = createDb()
    const id = seedMemory(path, { project: OWN, content: 'fenced row' })
    withSchemaVersion(path, NEWER)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = writer.recordRetrieval({ identity: OWN, ids: [id] })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toBe('contract-version-unsupported')
      expect(telemetry(path, id).retrieval_count).toBe(0)
      expect(telemetry(path, id).last_retrieved_at).toBeNull()
    } finally {
      writer.close()
    }
  })
})

/** Boot the real plugin on an isolated dataDir, exactly as a profile would. */
async function bootPlugin(options: {
  dataDir: string
  /** Omitted = the profile config has no `memory` key at all. */
  memory?: Record<string, unknown>
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(mcDshPlugin, {
    dataDir: options.dataDir,
    registerCompactionEngine: false,
    ...options.memory === undefined ? {} : { memory: options.memory },
  } as never)
  disposers.push(async () => {
    try {
      await ctx.fiber.dispose()
    } catch {
      /* best effort */
    }
  })
  return ctx
}

function toolNames(ctx: Context): string[] {
  return (ctx.tools as unknown as { schemas(): Array<{ name: string }> }).schemas().map(schema => schema.name)
}

function meta(dataDir: string, key: string): string | undefined {
  const stores = openStores(dataDir)
  try {
    return stores.getMeta(key)
  } finally {
    stores.close()
  }
}

describe('the memory.enabled gate (task-9 ①)', () => {
  it('registers ctx_memory and reports the store when memory is configured and enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-gate-on-'))
    tempDirs.push(dataDir)
    const dbPath = createDb()
    const ctx = await bootPlugin({ dataDir, memory: { dbPath, enabled: true, autoPromote: false } })

    expect(toolNames(ctx)).toContain('ctx_memory')
    expect(meta(dataDir, 'memory_bridge')).toBe(`ok schema v${String(SUPPORTED)}`)
    expect(meta(dataDir, 'memory_write')).toBe('read-write (promotion off)')
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM memories')).toBe(0)
  })

  it('turns the whole memory block off when the profile has no memory key', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-gate-off-'))
    tempDirs.push(dataDir)
    const ctx = await bootPlugin({ dataDir })

    // Not "read-only": ABSENT. A tool with no store behind it is the failure
    // mode this gate exists to prevent.
    expect(toolNames(ctx)).not.toContain('ctx_memory')
    expect(meta(dataDir, 'memory_bridge')).toBe('off')
    expect(meta(dataDir, 'memory_write')).toBe('off')
  })

  it('honours an explicit memory.enabled:false and names the reason', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-gate-disabled-'))
    tempDirs.push(dataDir)
    const dbPath = createDb()
    const ctx = await bootPlugin({ dataDir, memory: { dbPath, enabled: false } })

    expect(toolNames(ctx)).not.toContain('ctx_memory')
    expect(meta(dataDir, 'memory_bridge')).toBe('disabled-by-config')
    expect(meta(dataDir, 'memory_write')).toBe('disabled-by-config')
    // The store is not merely unwritten: it is never opened, so nothing can
    // leak out of a disabled adapter's memory path.
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM memories')).toBe(0)
  })

  it('still registers ctx_reduce / ctx_expand when memory is off', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-gate-tools-'))
    tempDirs.push(dataDir)
    const ctx = await bootPlugin({ dataDir })
    const names = toolNames(ctx)
    expect(names).toContain('ctx_reduce')
    expect(names).toContain('ctx_expand')
  })
})
