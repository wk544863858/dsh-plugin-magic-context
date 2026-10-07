// @ts-nocheck
/**
 * MIRROR of the runnable suite at `packages/test-support/mc-dsh-poc/tests/memory-tool-bridge.spec.ts`
 * in the DSH checkout — this repository has no node_modules and cannot resolve bare
 * vitest. Keep the two files identical; this header is the only intended difference.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin from '<path>'
import { openMemoryBridge } from '<path>'
import { openMemoryWriter } from '<path>'
import {
  defineCtxMemoryTool,
  type MemoryToolRunContext,
} from '<path>'

const IDENTITY = 'git:1111111111111111111111111111111111111111'
const OTHER_IDENTITY = 'git:2222222222222222222222222222222222222222'
const silentLogger = { info: () => {}, warn: () => {} }

/** The structural shape the real `defineTool` returns for ctx_memory. */
interface BuiltTool {
  readonly name: string
  readonly description: string
  readonly parameters: { readonly type: string; readonly properties: Record<string, unknown>; readonly required?: readonly string[] }
  readonly output: { readonly schema: unknown; render(args: unknown, value: unknown): unknown[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      /* best effort */
    }
  }
})

/** An isolated v94-compatible `context.db` (contract §1.1, §5.1, §6.1, §8.4). */
function makeMemoryDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-toolbridge-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
  const path = join(dir, 'context.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER);
      CREATE TABLE memories(
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
      CREATE TABLE memory_mutation_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive','delete','update','superseded')),
        target_memory_id INTEGER NOT NULL,
        superseded_by_id INTEGER,
        category TEXT,
        new_content TEXT,
        queued_at INTEGER NOT NULL
      );
      CREATE TABLE project_state(
        project_path TEXT PRIMARY KEY,
        project_memory_epoch INTEGER NOT NULL DEFAULT 0,
        project_user_profile_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE authority_managed(project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL);
      CREATE TABLE authority_repair_pending(project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
      CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)));
      INSERT INTO context_privilege_state(id, enabled) VALUES(1, 0);
    `)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(94, 0)').run()
  } finally {
    db.close()
  }
  return path
}

function run(path: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function count(path: string, sql: string, ...params: Array<string | number | null>): number {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c
  } finally {
    db.close()
  }
}

/** A run context shaped like the one the real tool runtime passes. */
function fakeExec(cwd: string): MemoryToolRunContext {
  return {
    callId: 'call-1',
    name: 'ctx_memory',
    agent: { session: { id: 'ses-toolbridge', header: { cwd } } },
  } as MemoryToolRunContext
}

/** Build `ctx_memory` on the real host constructor plus an isolated store. */
function buildTool(path: string, recall: (request: { query?: string; limit?: number; identity?: string }, exec?: MemoryToolRunContext) => { lines: readonly string[]; digest: string } | undefined): { tool: BuiltTool; close: () => void } {
  const writer = openMemoryWriter({ dbPath: path, logger: silentLogger })
  const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
  const tool = defineCtxMemoryTool({
    defineTool,
    writer,
    resolveIdentity: () => IDENTITY,
    recall,
  }) as BuiltTool
  return {
    tool,
    close: () => {
      writer.close()
      bridge.close()
    },
  }
}

describe('ctx_memory under the real host defineTool', () => {
  it('compiles the parameter DSL through the host constructor, not the local builder', () => {
    const path = makeMemoryDb()
    const built = buildTool(path, () => undefined)
    cleanups.push(built.close)
    // The host constructor returns a compiled JSON Schema object; the local
    // builder would produce the same shape but with our own validation.
    expect(built.tool.name).toBe('ctx_memory')
    expect(built.tool.parameters.type).toBe('object')
    expect(Object.keys(built.tool.parameters.properties)).toEqual(expect.arrayContaining([
      'action', 'query', 'id', 'ids', 'category', 'content', 'target_id', 'superseded_by',
    ]))
    expect(built.tool.parameters.properties.action).toMatchObject({ enum: ['list', 'search', 'get', 'write', 'update', 'archive', 'merge'] })
    expect(typeof built.tool.execute).toBe('function')
    expect(typeof built.tool.output.render).toBe('function')
  })

  it('reproduces the live ReferenceError from the shipped closure shape', () => {
    // Verbatim structure of index.ts:542-546 with the default config:
    // `memory.project` is unset, so the `&&` left side is true and the right
    // side — the only reader of `exec` — is evaluated.
    const config: { memory?: { project?: string } } = { memory: {} }
    const shippedRecall = (request: { query?: string }): unknown => ({
      project: config.memory?.project === undefined && exec.agent?.session.header.cwd === undefined
        ? undefined
        : config.memory?.project ?? exec.agent?.session.header.cwd,
      query: request.query,
    })
    let thrown: unknown
    try {
      shippedRecall({ query: 'anything' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ReferenceError)
    expect((thrown as Error).message).toBe('exec is not defined')
  })

  it('hands the host recall callback the run context and the resolved identity', async () => {
    const path = makeMemoryDb()
    const seen: Array<{ request: { identity?: string }; exec?: MemoryToolRunContext }> = []
    const built = buildTool(path, (request, exec) => {
      seen.push({ request, exec })
      return { lines: ['- [CONSTRAINTS] recall saw the session'], digest: 'digest-1' }
    })
    cleanups.push(built.close)

    const result = await built.tool.execute({ action: 'list', query: 'anything' }, fakeExec('D:/work/project'))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.request.identity).toBe(IDENTITY)
    expect(seen[0]!.exec?.agent?.session.header?.cwd).toBe('D:/work/project')
    expect(built.tool.output.render({ action: 'list' }, result)).toEqual([
      { type: 'text', text: 'Project memories (1 shown):\n- [CONSTRAINTS] recall saw the session' },
    ])
  })

  it('passes a missing run context through as undefined and never throws on it', async () => {
    const path = makeMemoryDb()
    const seen: Array<MemoryToolRunContext | undefined> = []
    const built = buildTool(path, (request, exec) => {
      seen.push(exec)
      // The guarded read the fixed index.ts uses. `??` is left-associative:
      // `identity ?? configProject ?? exec === undefined ? x : y` parses as
      // `((identity ?? configProject ?? exec) === undefined) ? x : y`, so the
      // exec guard must be parenthesised (`exec === undefined ? undefined : …`).
      const cwd = exec === undefined ? undefined : exec.agent?.session.header.cwd
      const project = request.identity ?? cwd
      return project === undefined
        ? undefined
        : { lines: [`- [NAMING] scoped to ${project}`], digest: 'digest-scoped' }
    })
    cleanups.push(built.close)
    const scoped = `Project memories (1 shown):\n- [NAMING] scoped to ${IDENTITY}`

    const withContext = await built.tool.execute({ action: 'list' }, fakeExec('D:/work/project'))
    expect(built.tool.output.render({ action: 'list' }, withContext))
      .toEqual([{ type: 'text', text: scoped }])

    // No run context at all: the tool must pass `undefined` through and must
    // not throw. `sessionIdOf` used to dereference `exec.agent` unguarded, and
    // this tool still answers because `request.identity` carries the scope.
    const withoutContext = await built.tool.execute({ action: 'list' }, undefined)
    expect(seen).toEqual([fakeExec('D:/work/project'), undefined])
    expect(built.tool.output.render({ action: 'list' }, withoutContext))
      .toEqual([{ type: 'text', text: scoped }])

    // Default config with no identity either (no `memory.project`, no session
    // cwd): the callback decides and nothing throws on the way there.
    const bare = defineCtxMemoryTool({
      defineTool,
      resolveIdentity: () => undefined,
      recall: (request, exec) => {
        const cwd = exec === undefined ? undefined : exec.agent?.session.header.cwd
        const project = request.identity ?? cwd
        return project === undefined
          ? undefined
          : { lines: [`- [NAMING] scoped to ${project}`], digest: 'digest-bare' }
      },
    }) as BuiltTool
    expect(await bare.execute({ action: 'list' }, undefined)).toEqual({ empty: true })
  })

  it('runs write → dedup → update → archive → merge → get/list through the real constructor', async () => {
    const path = makeMemoryDb()
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    cleanups.push(() => bridge.close())
    const built = buildTool(path, (request, exec) => {
      const project = request.identity ?? exec?.agent?.session.header?.cwd
      if (project === undefined) return undefined
      return bridge.recall({
        project,
        budgetTokens: 8_000,
        limit: request.limit ?? 20,
        now: Date.now(),
        ...request.query === undefined ? {} : { query: request.query },
      })
    })
    cleanups.push(built.close)
    const exec = fakeExec('D:/work/project')

    // write
    const written = await built.tool.execute(
      { action: 'write', category: 'CONFIG_VALUES', content: 'the example-service port is 5432' },
      exec,
    ) as { outcome?: string }
    expect(written.outcome).toMatch(/^Saved as memory \d+ \[CONFIG_VALUES\]\.$/)
    const id = Number(/memory (\d+)/.exec(written.outcome!)![1])

    // dedup: the same content (different case/whitespace) only bumps seen_count
    const again = await built.tool.execute(
      { action: 'write', category: 'CONFIG_VALUES', content: '  The Datahub PORT is 5432 ' },
      exec,
    ) as { outcome?: string }
    expect(again.outcome).toContain('Already known')
    expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(1)
    expect(count(path, 'SELECT seen_count AS c FROM memories WHERE id = ?', id)).toBe(2)

    // get + list read the row back through the same tool
    const got = await built.tool.execute({ action: 'get', id }, exec) as { memory?: { content: string } }
    expect(got.memory?.content).toBe('the example-service port is 5432')
    const listed = await built.tool.execute({ action: 'list' }, exec) as { lines?: string[] }
    expect(listed.lines?.join('\n')).toContain('the example-service port is 5432')

    // update
    const updated = await built.tool.execute(
      { action: 'update', id, content: 'the example-service port is 6543', importance: 70 },
      exec,
    ) as { outcome?: string }
    expect(updated.outcome).toBe(`Updated memory ${String(id)}.`)
    expect(count(path, "SELECT COUNT(*) AS c FROM memory_mutation_log WHERE mutation_type = 'update'")).toBe(1)

    // merge: a second row of the same category folds into the first
    const second = await built.tool.execute(
      { action: 'write', category: 'CONFIG_VALUES', content: 'the example-service host is db.internal' },
      exec,
    ) as { outcome?: string }
    const secondId = Number(/memory (\d+)/.exec(second.outcome!)![1])
    const merged = await built.tool.execute(
      { action: 'merge', target_id: id, ids: [secondId], content: 'the example-service endpoint is db.internal:6543' },
      exec,
    ) as { outcome?: string }
    expect(merged.outcome).toBe(`Merged 1 row(s) into memory ${String(id)}.`)
    expect(count(path, "SELECT COUNT(*) AS c FROM memory_mutation_log WHERE mutation_type = 'superseded'")).toBe(1)

    // archive the merged row
    const archived = await built.tool.execute(
      { action: 'archive', id, reason: 'superseded by the service map' },
      exec,
    ) as { outcome?: string }
    expect(archived.outcome).toBe(`Archived memory ${String(id)}.`)
    expect(count(path, "SELECT COUNT(*) AS c FROM memories WHERE id = ? AND status = 'archived'", id)).toBe(1)
    // One update + (one superseded + one target update from the merge) + one archive.
    expect(count(path, "SELECT COUNT(*) AS c FROM memory_mutation_log WHERE mutation_type = 'update'")).toBe(2)
    expect(count(path, "SELECT COUNT(*) AS c FROM memory_mutation_log WHERE mutation_type = 'superseded'")).toBe(1)
    expect(count(path, "SELECT COUNT(*) AS c FROM memory_mutation_log WHERE mutation_type = 'archive'")).toBe(1)
    expect(count(path, 'SELECT COUNT(*) AS c FROM memory_mutation_log')).toBe(4)
    // Additive writes never touch the epoch, and the tool never bumps it.
    expect(count(path, 'SELECT COUNT(*) AS c FROM project_state')).toBe(0)
  })

  it('refuses writes for a module-managed project through the tool, leaving the store untouched', async () => {
    const path = makeMemoryDb()
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    cleanups.push(() => bridge.close())
    const built = buildTool(path, request => (request.identity === undefined
      ? undefined
      : bridge.recall({ project: request.identity, budgetTokens: 8_000, limit: 20, now: Date.now() })))
    cleanups.push(built.close)
    const exec = fakeExec('D:/work/project')

    run(path, 'INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES(?, ?, ?)', IDENTITY, 'store-uuid', Date.now())
    const result = await built.tool.execute(
      { action: 'write', category: 'NAMING', content: 'this must not be written' },
      exec,
    ) as { outcome?: string; detail?: string }
    expect(result.outcome).toBe('write refused (authority-blocked).')
    expect(result.detail).toContain('must use the Rust ctx_memory module facade')
    expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(0)
    // A foreign project is still writable: the guard is per identity.
    expect(count(path, 'SELECT COUNT(*) AS c FROM memories WHERE project_path = ?', OTHER_IDENTITY)).toBe(0)
  })
})

/** Boot the real plugin on an isolated dataDir + snapshot DB and drive one turn. */
async function bootPlugin(options: {
  dataDir: string
  dbPath: string
  /** Omitted mirrors the desktop default (identity from the session cwd). */
  project?: string
  script: ConstructorParameters<typeof MockAdapter>[0]
}): Promise<{
  adapter: MockAdapter
  sendAndSettle: (message: string) => Promise<void>
  requestsText: () => string
}> {
  const adapter = new MockAdapter(options.script)
  const historian = new MockAdapter([textResponse('{}')])
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
    historian: { provider: 'mock-historian', model: 'mock' },
    memory: {
      dbPath: options.dbPath,
      autoPromote: false,
      ...options.project === undefined ? {} : { project: options.project },
    },
    policy: {
      executeThreshold: 50,
      forceThreshold: 90,
      protectedToolResults: 0,
      historianProtectedNodes: 0,
      historianMinNodes: 2,
      historianMinBudgetTokens: 1,
    },
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.llm.registerAdapter(['mock-historian'], historian)
  cleanups.push(async () => {
    try {
      await ctx.fiber.dispose()
    } catch {
      /* best effort */
    }
  })

  const agent = await ctx.agentLoop.create(SessionId(`mc-toolbridge-${String(Date.now())}`), {
    provider: 'mock',
    model: 'mock',
  })
  const requestsText = (): string => (adapter.requests.at(-1)?.messages ?? [])
    .flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
  return {
    adapter,
    requestsText,
    async sendAndSettle(message: string): Promise<void> {
      const settled = new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }))
      await settled
    },
  }
}

describe('ctx_memory through the real plugin boot (no memory.project configured)', () => {
  /**
   * The live failure: `tools.mode=dynamic-import`, `memory.project` unset, the
   * agent calls `ctx_memory` → the tool result is `Error: exec is not defined`.
   */
  it('answers list through the real agent loop instead of failing the tool call', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-toolbridge-e2e-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
    const dbPath = makeMemoryDb()
    const booted = await bootPlugin({
      dataDir,
      dbPath,
      script: [toolCallResponse('call-1', 'ctx_memory', { action: 'list' }), textResponse('ok')],
    })
    await booted.sendAndSettle('what do you remember?')

    const reply = booted.requestsText()
    expect(reply).not.toContain('exec is not defined')
    expect(reply).toMatch(/No matching project memories\.|Project memories \(\d+ shown\):/)
  }, 20_000)
})

describe('isolated snapshot round-trip through the real loop', () => {
  /**
   * The acceptance walk: one isolated profile (temp `dataDir`), one snapshot
   * `context.db`, the real plugin and the real tools, no user profile or shared
   * store involved. Every action goes through an actual agent turn.
   */
  it('writes, dedups, updates, merges, archives and reads back', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-toolbridge-snap-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
    const dbPath = makeMemoryDb()
    const SNAPSHOT = 'git:8888888888888888888888888888888888888888'
    const booted = await bootPlugin({
      dataDir,
      dbPath,
      project: SNAPSHOT,
      script: [
        toolCallResponse('call-w1', 'ctx_memory', { action: 'write', category: 'CONFIG_VALUES', content: 'the example-service port is 5432' }),
        textResponse('noted'),
        // Same fact, different case and spacing: the UNIQUE dedup key must hit.
        toolCallResponse('call-w2', 'ctx_memory', { action: 'write', category: 'CONFIG_VALUES', content: '  The Datahub PORT is 5432 ' }),
        textResponse('noted'),
        toolCallResponse('call-w3', 'ctx_memory', { action: 'write', category: 'CONFIG_VALUES', content: 'the example-service host is db.internal' }),
        textResponse('noted'),
        toolCallResponse('call-u1', 'ctx_memory', { action: 'update', id: 1, content: 'the example-service port is 6543', importance: 70 }),
        textResponse('noted'),
        toolCallResponse('call-m1', 'ctx_memory', { action: 'merge', target_id: 1, ids: [2], content: 'the example-service endpoint is db.internal:6543' }),
        textResponse('noted'),
        toolCallResponse('call-g1', 'ctx_memory', { action: 'get', id: 1 }),
        textResponse('noted'),
        toolCallResponse('call-a1', 'ctx_memory', { action: 'archive', id: 1, reason: 'superseded by the service map' }),
        textResponse('noted'),
        toolCallResponse('call-w4', 'ctx_memory', { action: 'write', category: 'NAMING', content: 'the replica is db.replica.internal' }),
        textResponse('noted'),
        toolCallResponse('call-l1', 'ctx_memory', { action: 'list' }),
        textResponse('noted'),
      ],
    })

    const observed: string[] = []
    for (const step of [
      'remember the example-service port',
      'remember it again',
      'remember the host too',
      'correct the port',
      'fold the host row in',
      'read it back',
      'retire the merged row',
      'remember the replica',
      'what do you remember now?',
    ]) {
      await booted.sendAndSettle(step)
      observed.push(booted.requestsText())
    }

    expect(observed[0]).toContain('Saved as memory 1 [CONFIG_VALUES].')
    expect(observed[1]).toContain('Already known (memory 1, seen 2 times).')
    expect(observed[2]).toContain('Saved as memory 2 [CONFIG_VALUES].')
    expect(observed[3]).toContain('Updated memory 1.')
    expect(observed[4]).toContain('Merged 1 row(s) into memory 1.')
    expect(observed[5]).toContain('the example-service endpoint is db.internal:6543')
    expect(observed[6]).toContain('Archived memory 1.')
    expect(observed[7]).toContain('Saved as memory 3 [NAMING].')
    expect(observed[8]).toContain('the replica is db.replica.internal')

    // Snapshot state: three rows, the canonical and its source both archived.
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM memories')).toBe(3)
    expect(count(dbPath, "SELECT COUNT(*) AS c FROM memories WHERE id = 1 AND status = 'archived'")).toBe(1)
    expect(count(dbPath, "SELECT COUNT(*) AS c FROM memories WHERE id = 2 AND status = 'archived' AND superseded_by_memory_id = 1")).toBe(1)
    expect(count(dbPath, "SELECT COUNT(*) AS c FROM memories WHERE id = 3 AND status = 'active'")).toBe(1)
    expect(count(dbPath, 'SELECT seen_count AS c FROM memories WHERE id = 1')).toBe(3)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM memory_mutation_log')).toBe(4)
    // In-session writes never bump the epoch (contract §5.2).
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM project_state')).toBe(0)
    expect(booted.adapter.requests.length).toBeGreaterThanOrEqual(18)
  }, 30_000)
})

/** The boot helper above must keep exercising the shipped tool mode. */
describe('tool mode', () => {
  it('resolves the real host defineTool for the dynamic-import path', async () => {
    await expect(import('@deepseek-ai/dsh-tools')).resolves.toHaveProperty('defineTool')
    expect(typeof defineTool).toBe('function')
  })
})

/**
 * The `project` argument: DSH has no OpenCode-style per-turn working directory,
 * so a session opened in project1 that starts working on project2 can only be
 * scoped by the model NAMING the other project. Every action accepts it; the
 * same normalizer (git:/dir: passthrough, else path resolution) decides scope,
 * and an unresolvable spec is a structured refusal — never a guessed scope.
 */
describe('ctx_memory explicit project scoping', () => {
  interface JournalCall { readonly summary: string; readonly data: Record<string, unknown> }
  function buildScopedTool(path: string, options: {
    readonly resolveIdentityOf?: (spec: string) => string | undefined
    readonly recall?: (request: { query?: string; limit?: number; identity?: string }) => { lines: readonly string[]; digest: string } | undefined
  }): { tool: BuiltTool; journal: JournalCall[]; close: () => void } {
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger })
    const journal: JournalCall[] = []
    const tool = defineCtxMemoryTool({
      defineTool,
      writer,
      resolveIdentity: () => IDENTITY,
      resolveIdentityOf: options.resolveIdentityOf,
      ...options.recall === undefined ? {} : { recall: options.recall },
      journal: {
        info: (kind: string, summary: string, data: Record<string, unknown>) => {
          if (kind === 'tool-call') journal.push({ summary, data })
        },
      } as never,
    }) as BuiltTool
    return {
      tool,
      journal,
      close: () => writer.close(),
    }
  }

  it('', async () => {
    const path = makeMemoryDb()
    const resolved: string[] = []
    const built = buildScopedTool(path, {
      resolveIdentityOf: spec => {
        resolved.push(spec)
        return OTHER_IDENTITY
      },
    })
    cleanups.push(built.close)

    const result = await built.tool.execute(
      { action: 'write', category: 'ARCHITECTURE', content: 'belongs to the other repo', project: 'E:/code/project2' },
      fakeExec('D:/work/project1'),
    ) as Record<string, unknown>
    expect(String(result.outcome)).toContain('Saved as memory')
    expect(resolved).toEqual(['E:/code/project2'])
    // The row carries the explicit project, and the session project stays empty.
    expect(count(path, `SELECT COUNT(*) AS c FROM memories WHERE project_path = '${OTHER_IDENTITY}'`)).toBe(1)
    expect(count(path, `SELECT COUNT(*) AS c FROM memories WHERE project_path = '${IDENTITY}'`)).toBe(0)
    // The journal names the explicit project.
    expect(built.journal[0]?.data.explicitProject).toBe('E:/code/project2')
    expect(built.journal[0]?.data.identity).toBe(OTHER_IDENTITY)
  })

  it('', async () => {
    const path = makeMemoryDb()
    const built = buildScopedTool(path, {
      resolveIdentityOf: () => undefined,
    })
    cleanups.push(built.close)

    const result = await built.tool.execute(
      { action: 'write', category: 'NAMING', content: 'should not land', project: 'E:/code/ghost' },
      fakeExec('D:/work/project1'),
    ) as Record<string, unknown>
    expect(String(result.outcome)).toContain('could not be resolved')
    expect(count(path, 'SELECT COUNT(*) AS c FROM memories')).toBe(0)
    // The refusal still journals, flagged not-ok.
    expect(built.journal[0]?.data.ok).toBe(false)
  })

  it('', async () => {
    const path = makeMemoryDb()
    let calls = 0
    const built = buildScopedTool(path, {
      resolveIdentityOf: () => {
        calls += 1
        return undefined
      },
    })
    cleanups.push(built.close)

    const result = await built.tool.execute(
      { action: 'write', category: 'NAMING', content: 'scoped by identity string', project: OTHER_IDENTITY },
      fakeExec('D:/work/project1'),
    ) as Record<string, unknown>
    expect(String(result.outcome)).toContain('Saved as memory')
    expect(calls).toBe(0)
    expect(count(path, `SELECT COUNT(*) AS c FROM memories WHERE project_path = '${OTHER_IDENTITY}'`)).toBe(1)
  })

  it('', async () => {
    const path = makeMemoryDb()
    const built = buildScopedTool(path, {
      resolveIdentityOf: spec => (spec === 'E:/code/project2' ? OTHER_IDENTITY : undefined),
      recall: request => {
        if (request.identity === OTHER_IDENTITY) {
          return { lines: [`- [ARCHITECTURE] from ${String(request.identity)}`], digest: 'digest-other' }
        }
        return { lines: ['- [ARCHITECTURE] from the session project'], digest: 'digest-own' }
      },
    })
    cleanups.push(built.close)

    const result = await built.tool.execute(
      { action: 'list', project: 'E:/code/project2' },
      fakeExec('D:/work/project1'),
    ) as { lines?: string[] }
    expect(result.lines).toEqual([`- [ARCHITECTURE] from ${OTHER_IDENTITY}`])
  })

  it('', async () => {
    const path = makeMemoryDb()
    let calls = 0
    const built = buildScopedTool(path, {
      resolveIdentityOf: () => {
        calls += 1
        return undefined
      },
      recall: () => ({ lines: ['- [NAMING] session scope'], digest: 'digest-own' }),
    })
    cleanups.push(built.close)

    const result = await built.tool.execute({ action: 'list' }, fakeExec('D:/work/project1')) as { lines?: string[] }
    expect(result.lines).toEqual(['- [NAMING] session scope'])
    expect(calls).toBe(0)
    expect(built.journal[0]?.data.explicitProject).toBeUndefined()
  })
})
