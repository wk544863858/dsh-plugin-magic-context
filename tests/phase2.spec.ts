/**
 * Phase 2 integration: the historian, the m[0]/m[1] baseline, project-memory
 * recall, and the custom CompactionEngine — all against the real agent loop,
 * the real session surface, and the real tools registry.
 *
 * The session model is a separate MockAdapter route from the historian's, so
 * the scripted conversation and the scripted digest never compete for script
 * entries (and the test proves the historian's call really happened).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin, { openStores, runManagementPass, DEFAULT_POLICY } from '<path>'
import { BASELINE_OPEN, compactedPlaceholder } from '<path>'

type AnyMessage = { role: string; content: Array<{ type: string; text?: string }> }

function textOf(message: AnyMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function allText(request: { messages: AnyMessage[] } | undefined): string {
  return (request?.messages ?? []).map(textOf).join('\n')
}

class WindowedAdapter extends MockAdapter {
  constructor(script: ConstructorParameters<typeof MockAdapter>[0], private readonly contextWindow: number) {
    super(script)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...(await super.resolveModel(provider, model)), context: { contextWindow: this.contextWindow } }
  }
}

function digest(marker: string, importance = 90): string {
  return JSON.stringify({
    summary: {
      p1: `${marker}-P1 detailed`,
      p2: `${marker}-P2`,
      p3: `${marker}-P3`,
      p4: `${marker}-P4`,
    },
    importance,
    facts: [`${marker}-fact`],
    events: [`${marker}-event`],
  })
}

const cleanups: Array<() => Promise<void> | void> = []

async function boot(options: {
  dataDir: string
  memoryDbPath?: string
  project?: string
}): Promise<{ ctx: Context; adapter: WindowedAdapter; historian: MockAdapter; agent: Agent }> {
  const adapter = new WindowedAdapter([
    toolCallResponse('call-1', 'echo', { text: 'first output' }),
    toolCallResponse('call-2', 'echo', { text: 'second output' }),
    textResponse('done'),
    textResponse('more done'),
    textResponse('again done'),
  ], 12)
  const historian = new MockAdapter([textResponse(digest('HISTORIAN-A')), textResponse(digest('HISTORIAN-B')), textResponse(digest('HISTORIAN-C'))])
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
    // The seam is opt-in (Config defaults it to false, like the bundle patch):
    // these tests exist to exercise the engine, so they ask for it explicitly.
    registerCompactionEngine: true,
    compactionBase: CompactionEngine,
    ...options.memoryDbPath === undefined
      ? {}
      : { memory: { dbPath: options.memoryDbPath, project: options.project ?? 'git:demo' } },
    policy: {
      executeThreshold: 50,
      forceThreshold: 90,
      protectedToolResults: 0,
      // Nothing protected, a one-token floor: the eligible span exists from the
      // second step on (a real budget would wait for 5k tokens).
      historianProtectedNodes: 0,
      historianMinNodes: 2,
      historianMinBudgetTokens: 1,
    },
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.llm.registerAdapter(['mock-historian'], historian)
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo fixture',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo:${args.text}` }]
    },
  }))
  const agent = await ctx.agentLoop.create(SessionId(`mc-p2-${String(Date.now())}`), { provider: 'mock', model: 'mock' })
  cleanups.push(async () => {
    try {
      await ctx.fiber.dispose()
    } catch {
      /* best effort */
    }
  })
  return { ctx, adapter, historian, agent }
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Poll a condition (out-of-band work — the historian — lands asynchronously). */
async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not reached before the timeout')
}

function makeMemoryDb(rows: Array<{ project: string; category: string; content: string; shareable?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-p2-mem-'))
  const path = join(dir, 'context.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER);
    CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, category TEXT, content TEXT NOT NULL,
      importance INTEGER, scope TEXT DEFAULT 'project', shareable INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active', expires_at INTEGER, updated_at INTEGER NOT NULL, last_seen_at INTEGER, verified_at INTEGER
    );
  `)
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(94, 0)').run()
  for (const row of rows) {
    db.prepare(
      'INSERT INTO memories(project_path, category, content, importance, shareable, status, updated_at, last_seen_at) VALUES(?, ?, ?, 80, ?, ?, ?, ?)',
    ).run(row.project, row.category, row.content, row.shareable ?? 0, 'active', 1000, 1000)
  }
  db.close()
  return path
}

describe('magic-context dsh adapter (phase 2: historian, baseline, memories, engine)', () => {
  it('digests a span out of band, publishes it in the execute band, and injects the baseline', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-p2-a-'))
    const memoryDbPath = makeMemoryDb([
      { project: 'git:demo', category: 'CONSTRAINTS', content: 'never commit secrets' },
    ])
    const { ctx, adapter, historian, agent } = await boot({ dataDir, memoryDbPath, project: 'git:demo' })
    const sessionId = agent.session.id
    try {
      // Engine seam: our class owns ctx.compaction, not compaction-basic.
      expect(ctx.compaction?.constructor.name).toBe('MagicContextCompactionEngine')

      send(agent, 'go')
      await idle(ctx, agent)

      // The historian really called its own route, out of band, and stored a digest.
      const reader = openStores(dataDir)
      try {
        await until(() => reader.listCompartments(sessionId).length >= 1)
        const compartment = reader.listCompartments(sessionId)[0]!
        expect(compartment.tiers.p1).toContain('HISTORIAN-A-P1')
        expect(compartment.importance).toBe(90)
        expect(compartment.coveredSeqs.length).toBeGreaterThanOrEqual(2)
        expect(compartment.coveredTokens).toBeGreaterThan(0)
        // Nothing was mutated on the wire by the historian itself.
        expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      } finally {
        reader.close()
      }
      expect(historian.requests.length).toBeGreaterThanOrEqual(1)
      // The historian's call replayed the conversation prefix and asked for JSON.
      expect(allText(historian.requests[0])).toContain('HISTORIAN for this coding assistant')

      // Turn 2 rides the execute band: the compartment is published as a range
      // replacement and the baseline node carries the digest + memories.
      send(agent, 'more')
      await idle(ctx, agent)
      const request = adapter.requests.at(-1)
      const text = allText(request)
      expect(text).toContain(compactedPlaceholder(1))
      expect(text).toContain(BASELINE_OPEN)
      expect(text).toContain('HISTORIAN-A-P1')
      expect(text).toContain('<compartment-delta>')
      expect(text).toContain('<project-memories>')
      expect(text).toContain('never commit secrets')

      // Channel A of the live session stream: the action-bearing pass appended
      // ONE notice entry — a user-role `user/message` from producer
      // `magic-context`, form `notice`, whose one-line summary the transcript
      // shows collapsed. The real session admitted the plugin source, and the
      // notice is model-visible (it rides in the request text below).
      const notice = agent.session.snapshotEvents().find(event =>
        event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'magic-context')
      expect(notice).toBeDefined()
      const noticeSource = (notice!.data as { source?: Record<string, unknown> }).source ?? {}
      expect(noticeSource.form).toBe('notice')
      expect(String(noticeSource.summary)).toContain('compacted 1 compartment')
      expect(String(noticeSource.summary)).toContain('§C1§')
      expect(text).toContain('Magic Context · compacted 1 compartment')

      const afterPublish = openStores(dataDir)
      try {
        expect(afterPublish.listUnlandedCompartments(sessionId)).toEqual([])
        const state = afterPublish.baselineState(sessionId)
        expect(state?.epoch).toBeGreaterThanOrEqual(1)
        expect(state?.nodeSeq).toBeDefined()
        expect(state?.memoriesDigest).toBeDefined()
        // The validation-period journal must carry the whole story of this run.
        const kinds = new Set(afterPublish.listJournal({ limit: 300 }).map(entry => entry.kind))
        for (const kind of ['boot', 'session-first-seen', 'pass', 'historian', 'compartment-published', 'baseline', 'memory-recall']) {
          expect(kinds.has(kind as never), `journal is missing ${kind}`).toBe(true)
        }
        const historianDone = afterPublish.listJournal({ kinds: ['historian'] })
          .find(entry => entry.data?.phase === 'done')
        expect(historianDone?.data?.importance).toBe(90)
      } finally {
        afterPublish.close()
      }
    } finally {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })

  it('writes a real checkpoint protocol on manual compaction and nothing on pressure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-p2-b-'))
    const { ctx, agent } = await boot({ dataDir })
    try {
      send(agent, 'go')
      await idle(ctx, agent)
      // Pressure alone never writes a checkpoint (Magic Context's promise).
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)

      const generation = agent.session.surface.replaceGeneration
      const result = await ctx.compaction!.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      expect(result!.shadowedSeqs.length).toBeGreaterThanOrEqual(2)
      expect(agent.session.surface.replaceGeneration).toBeGreaterThan(generation)
      const events = agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'compaction/start')).toBe(true)
      expect(events.some(event => event.type === 'compaction/summary')).toBe(true)
      expect(events.some(event => event.type === 'compaction/end')).toBe(true)
      // The checkpoint node carries the digest inline.
      const checkpoint = agent.session.deriveMessages().find(message =>
        (message.content as Array<{ type: string; text?: string }>).some(block =>
          block.type === 'text' && (block.text ?? '').includes('§checkpoint§')))
      expect(checkpoint).toBeDefined()
      expect(JSON.stringify(checkpoint)).toMatch(/HISTORIAN-[ABC]-P1/)

      // compactIfNeeded is the pressure path: it reclaims and returns null.
      expect(await ctx.compaction!.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
    } finally {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })

  it('mutates nothing on a pass with nothing to do (no priced bust from a no-op)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-p2-c-'))
    const { ctx, agent } = await boot({ dataDir })
    try {
      send(agent, 'go')
      await idle(ctx, agent)
      const reader = openStores(dataDir)
      try {
        const settle = (): void => {
          runManagementPass({
            session: agent.session,
            sessionId: agent.session.id,
            stores: reader,
            policy: { ...DEFAULT_POLICY, historianProtectedNodes: 0, historianMinNodes: 2, historianMinBudgetTokens: 1 },
            logger: { info: () => {}, warn: () => {} },
            pass: { kind: 'execute', reason: 'execute-threshold' },
            pressure: 70,
          })
        }
        settle() // first pass may land/publish whatever the live loop left behind
        const generation = agent.session.surface.replaceGeneration
        const events = agent.session.snapshotEvents().length
        settle() // second pass: nothing pending, baseline identical
        expect(agent.session.surface.replaceGeneration).toBe(generation)
        expect(agent.session.snapshotEvents().length).toBe(events)
      } finally {
        reader.close()
      }
    } finally {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })
})
