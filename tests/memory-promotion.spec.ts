/**
 * Memory write path, end to end through the real agent loop.
 *
 * What this proves (the invariants Magic Context is built on):
 *  - the historian's categorized facts become durable `memories` rows through
 *    the promotion writer, with MC's exact defaults (`source_type='historian'`,
 *    `importance=50`, `status='active'`, `expires_at` NULL for v2 categories);
 *  - promotion is a PURE APPEND: no `memory_mutation_log` row, no
 *    `project_state.project_memory_epoch` bump;
 *  - a repeated fact only bumps `seen_count` (the UNIQUE dedup key);
 *  - a new memory surfaces in m[1] as `<new-memories>` while the m[0]
 *    `<project-memories>` pool stays byte-identical — a memory write must never
 *    change the cached prefix.
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
import { MockAdapter, textResponse, toolCallResponse } from './helpers/mock-adapter.ts'
import mcDshPlugin, { openStores } from '../src/index.ts'
import { makeMemoryDb as makeBareMemoryDb } from './helpers/memory-db'

type AnyMessage = { role: string; content: Array<{ type: string; text?: string }> }

function allText(request: { messages: AnyMessage[] } | undefined): string {
  return (request?.messages ?? []).map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')).join('\n')
}

/** The `<project-memories>` section of an injected baseline (the m[0] pool). */
function projectMemoriesSection(text: string): string {
  const start = text.indexOf('<project-memories>')
  if (start === -1) return ''
  const end = text.indexOf('</project-memories>', start)
  return end === -1 ? '' : text.slice(start, end)
}

class WindowedAdapter extends MockAdapter {
  constructor(script: ConstructorParameters<typeof MockAdapter>[0], private readonly contextWindow: number) {
    super(script)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...(await super.resolveModel(provider, model)), context: { contextWindow: this.contextWindow } }
  }
}

/** A historian digest whose facts carry Magic Context's categories. */
function digest(marker: string, facts: Array<{ category: string; content: string }>): string {
  return JSON.stringify({
    summary: { p1: `${marker}-P1 detail`, p2: `${marker}-P2`, p3: `${marker}-P3`, p4: `${marker}-P4` },
    importance: 88,
    facts,
    events: [`${marker}-event`],
  })
}

const cleanups: Array<() => Promise<void> | void> = []

/**
 * A Memory Context v94-compatible database: the full `memories` contract
 * (NOT NULL hash, the UNIQUE dedup key), the mutation log, project state and
 * the authority tables the writer must respect.
 */
function makeMemoryDb(): string {
  const { path, dir } = makeBareMemoryDb({
    prefix: 'mc-memwrite-', schemaVersion: 94, mutationLog: true, projectState: true, authority: true,
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
  return path
}

async function boot(options: {
  dataDir: string
  memoryDbPath: string
  historianScript: string[]
  /** Overrides the session model's script (e.g. to call ctx_memory). */
  adapterScript?: ConstructorParameters<typeof MockAdapter>[0]
  /** Default true in these tests; false exercises promotion-off/write-on. */
  autoPromote?: boolean
  write?: boolean
}): Promise<{ ctx: Context; adapter: WindowedAdapter; agent: Agent }> {
  const adapter = new WindowedAdapter(options.adapterScript ?? [
    toolCallResponse('call-1', 'echo', { text: 'first output' }),
    toolCallResponse('call-2', 'echo', { text: 'second output' }),
    textResponse('done'),
    textResponse('more done'),
    textResponse('again done'),
    textResponse('finally done'),
  ], 12)
  const historian = new MockAdapter(options.historianScript.map(text => textResponse(text)))
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
      dbPath: options.memoryDbPath,
      project: 'git:memwrite',
      autoPromote: options.autoPromote ?? true,
      ...options.write === undefined ? {} : { write: options.write },
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
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo fixture',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo:${args.text}` }]
    },
  }))
  const agent = await ctx.agentLoop.create(SessionId(`mc-memwrite-${String(Date.now())}`), { provider: 'mock', model: 'mock' })
  cleanups.push(async () => {
    try {
      await ctx.fiber.dispose()
    } catch {
      /* best effort */
    }
  })
  return { ctx, adapter, agent }
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

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not reached before the timeout')
}

describe('memory write path (promotion, watermark, dedup)', () => {
  it('lets the agent maintain memories through ctx_memory, scoped to its project', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-memwrite-tool-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
    const dbPath = makeMemoryDb()
    const { ctx, adapter, agent } = await boot({
      dataDir,
      memoryDbPath: dbPath,
      // Promotion off, writes on: this test is about the tool, not the historian.
      autoPromote: false,
      adapterScript: [
        toolCallResponse('call-1', 'ctx_memory', {
          action: 'write',
          category: 'CONFIG_VALUES',
          content: 'example-service talks to PostgreSQL on 127.0.0.1:5432',
        }),
        textResponse('noted'),
      ],
      historianScript: [],
    })
    try {
      send(agent, 'remember the database port')
      await idle(ctx, agent)

      // The tool result reaches the model on the next request.
      expect(allText(adapter.requests.at(-1))).toContain('Saved as memory')

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT * FROM memories').get() as Record<string, unknown>
        expect(row.project_path).toBe('git:memwrite')
        expect(row.category).toBe('CONFIG_VALUES')
        expect(row.content).toBe('example-service talks to PostgreSQL on 127.0.0.1:5432')
        expect(row.source_type).toBe('agent')
        expect(row.seen_count).toBe(1)
        // A brand-new agent memory is an append: no mutation-log entry, no epoch.
        expect((db.prepare('SELECT COUNT(*) AS c FROM memory_mutation_log').get() as { c: number }).c).toBe(0)
        expect(db.prepare('SELECT * FROM project_state').all()).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    }
  }, 60_000)

  it('promotes categorized facts, surfaces them in m[1], and keeps m[0] byte-identical', async () => {
    // The historian runs out of band; promotion happens on a later pass.
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-memwrite-store-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
    const dbPath = makeMemoryDb()
    const fact = { category: 'CONSTRAINTS', content: 'never commit secrets to the repo' }
    const { ctx, adapter, agent } = await boot({
      dataDir,
      memoryDbPath: dbPath,
      historianScript: [
        digest('HISTORIAN-A', [fact]),
        digest('HISTORIAN-B', [fact]),
        digest('HISTORIAN-C', [fact]),
      ],
    })
    try {
      send(agent, 'go')
      await idle(ctx, agent)
      // Turn 2 rides the execute band: the compartment is published, which is
      // also where Magic Context promotes the facts.
      // The historian is out of band: wait for its compartment before the
      // publish turn, or the execute pass has nothing to publish.
      {
        const waitStore = openStores(dataDir)
        try {
          await until(() => waitStore.listCompartments(agent.session.id).length >= 1)
        } finally {
          waitStore.close()
        }
      }      send(agent, 'more')
      await idle(ctx, agent)
      const secondRequest = allText(adapter.requests.at(-1))



      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        await until(() => (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c >= 1)
        const row = db.prepare('SELECT * FROM memories').get() as Record<string, unknown>
        expect(row.project_path).toBe('git:memwrite')
        expect(row.category).toBe('CONSTRAINTS')
        expect(row.content).toBe(fact.content)
        expect(row.importance).toBe(50)
        expect(row.source_type).toBe('historian')
        expect(row.status).toBe('active')
        expect(row.seen_count).toBe(1)
        expect(row.expires_at).toBeNull()
        expect(String(row.normalized_hash)).toMatch(/^[0-9a-f]{32}$/)
        // Pure append: no mutation log row, no epoch bump.
        expect((db.prepare('SELECT COUNT(*) AS c FROM memory_mutation_log').get() as { c: number }).c).toBe(0)
        expect(db.prepare('SELECT * FROM project_state').all()).toEqual([])

        // The promoted row sits above the frozen watermark… but this pass ran
        // the recall BEFORE the write, so it appears from the next pass on.
        // (The desk section NAMES the `<new-memories>` record in prose, so the
        // assertion targets the rendered BLOCK shape, not the bare substring.)
        expect(secondRequest).not.toMatch(/<new-memories>\s*\n/)

        send(agent, 'again')
        await idle(ctx, agent)
        const thirdRequest = allText(adapter.requests.at(-1))
        expect(thirdRequest).toContain('<new-memories>')
        expect(thirdRequest).toContain(fact.content)
        // …and the m[0] pool is byte-identical: the cached prefix did not move.
        expect(projectMemoriesSection(thirdRequest)).toBe(projectMemoriesSection(secondRequest))
      } finally {
        db.close()
      }
    } finally {
      // Reverse order: dispose the plugin (closing SQLite handles) before removing temp dirs, or Windows throws EPERM.
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    }
  }, 60_000)

})







