/**
 * The activity journal — the validation period's audit trail.
 *
 * Unit: bounded redaction and the mirror line format.
 * Store: the v4 table and its query/prune/bounds surface.
 * Integration: a real agent-loop scenario must leave the signals a reviewer
 * needs (boot, first-seen, pass decisions, tool calls, landed drops) both in
 * the journal table and in the human-readable mirror file.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin, { openJournal, openStores, redactData, formatJournalLine, recoverOrphanHistorianRuns } from '<path>'

class WindowedAdapter extends MockAdapter {
  constructor(script: ConstructorParameters<typeof MockAdapter>[0], private readonly contextWindow: number) {
    super(script)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...(await super.resolveModel(provider, model)), context: { contextWindow: this.contextWindow } }
  }
}

describe('journal', () => {
  it('bounds structured payloads so a stray string cannot bloat the store', () => {
    const redacted = redactData({
      ok: 'short',
      long: 'x'.repeat(500),
      list: Array.from({ length: 30 }, (_unused, index) => index),
      nested: { a: { b: { c: { d: 'too deep' } } } },
    }) as Record<string, unknown>
    expect(redacted.ok).toBe('short')
    expect(String(redacted.long)).toContain('(500 chars)')
    expect(String(redacted.long).length).toBeLessThan(340)
    expect((redacted.list as unknown[]).length).toBe(21)
    expect(String((redacted.list as unknown[])[20])).toContain('30 items')
  })

  it('formats one mirror line per entry', () => {
    const line = formatJournalLine({
      at: 1_700_000_000_000,
      level: 'warn',
      kind: 'historian',
      sessionId: 'abcdefghijklmnop',
      summary: 'digest failed',
      data: { phase: 'failed' },
    })
    expect(line).toContain('WARN')
    expect(line).toContain('historian')
    expect(line).toContain('abcdefghijkl')
    expect(line).toContain('{"phase":"failed"}')
    expect(line.endsWith('\n')).toBe(true)
  })

  it('stores, queries, rolls up and prunes entries', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-journal-store-'))
    const stores = openStores(dataDir)
    try {
      const now = Date.now()
      for (let index = 0; index < 5; index += 1) {
        stores.appendJournal({
          at: now - index * 1000,
          level: index === 0 ? 'error' : 'info',
          kind: index === 0 ? 'error' : 'pass',
          sessionId: 's1',
          summary: `entry ${String(index)}`,
          data: { index },
        })
      }
      stores.appendJournal({ at: now - 10 * 24 * 60 * 60_000, level: 'info', kind: 'pass', summary: 'ancient' })
      expect(stores.journalBounds().rows).toBe(6)
      const tail = stores.listJournal({ limit: 2 })
      expect(tail.length).toBe(2)
      // Newest-first: the last appended entry comes back first.
      expect(tail[0]!.summary).toBe('ancient')
      expect(tail[1]!.data).toEqual({ index: 4 })
      expect(stores.listJournal({ kinds: ['error'] }).length).toBe(1)
      expect(stores.listJournal({ levels: ['error'] }).length).toBe(1)
      expect(stores.listJournal({ sessionId: 's1' }).length).toBe(5)
      const rollup = stores.journalByKind(now - 60_000)
      expect(rollup.find(row => row.kind === 'pass')?.count).toBe(4)
      expect(rollup.find(row => row.kind === 'error')?.level).toBe('error')
      expect(stores.pruneJournal(now - 5 * 24 * 60 * 60_000)).toBe(1)
      expect(stores.journalBounds().rows).toBe(5)
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })

  it('mirrors open-time failures without throwing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-journal-open-'))
    const stores = openStores(dataDir)
    try {
      const journal = openJournal({
        stores,
        mirrorPath: join(dataDir, 'nested', 'activity.log'),
        level: 'info',
        retentionDays: 1,
      })
      journal.info('boot', 'hello', { flag: true })
      const text = readFileSync(journal.mirrorPath!, 'utf8')
      expect(text).toContain('boot')
      expect(text).toContain('hello')
      expect(text).toContain('{"flag":true}')
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })

  it('recovers orphan historian starts left by a remount, idempotently', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-journal-recover-'))
    const stores = openStores(dataDir)
    try {
      const journal = openJournal({ stores, level: 'info' })
      // Two in-flight runs from a previous mount; two sessions already closed.
      journal.info('historian', 'run started', { phase: 'start' }, 'session-a')
      journal.info('historian', 'run started', { phase: 'start' }, 'session-b')
      journal.error('historian', 'run failed', { phase: 'failed', kind: 'provider' }, 'session-b')
      journal.info('historian', 'run started', { phase: 'start' }, 'session-c')
      journal.info('historian', 'run done', { phase: 'done' }, 'session-c')

      const recovered = recoverOrphanHistorianRuns(stores, journal)
      expect(recovered).toBe(1)
      // listJournal is newest-first; the chronological order is start → failed.
      const rowsA = stores.listJournal({ kinds: ['historian'], sessionId: 'session-a' })
      const phasesA = [...rowsA].reverse().map(entry => (entry.data as { phase?: string }).phase)
      // The start stays untouched; exactly one synthetic terminal follows it.
      expect(phasesA).toEqual(['start', 'failed'])
      const terminal = rowsA[0]
      expect(terminal?.data).toMatchObject({ phase: 'failed', kind: 'adapter-remount', recovered: true })
      // …and a second pass finds nothing left to recover.
      expect(recoverOrphanHistorianRuns(stores, journal)).toBe(0)
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })

  it('recovers a start superseded by a second start in the same session', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-journal-supersede-'))
    const stores = openStores(dataDir)
    try {
      const journal = openJournal({ stores, level: 'info' })
      // Run A never finishes; a second run B starts in the same session and
      // completes. The pairing map silently overwrites A — the recovery must
      // bank a terminal for A as well.
      journal.info('historian', 'run A started', { phase: 'start' }, 'session-d')
      journal.info('historian', 'run B started', { phase: 'start' }, 'session-d')
      journal.info('historian', 'run B done', { phase: 'done' }, 'session-d')

      const recovered = recoverOrphanHistorianRuns(stores, journal)
      expect(recovered).toBe(1)
      const phasesD = [...stores.listJournal({ kinds: ['historian'], sessionId: 'session-d' })]
        .reverse()
        .map(entry => (entry.data as { phase?: string }).phase)
      expect(phasesD).toEqual(['start', 'start', 'done', 'failed'])
      // The synthetic terminal belongs to run A, not to the healthy run B.
      const terminal = stores.listJournal({ kinds: ['historian'], sessionId: 'session-d' })[0]
      expect(terminal?.summary).toContain('adapter-remount')
      // The marker makes the supersede recovery idempotent across mounts.
      expect(recoverOrphanHistorianRuns(stores, journal)).toBe(0)
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })
})

describe('journal integration (real agent loop)', () => {
  it('records boot, session, pass, tool-call and landed-drop signals', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-journal-int-'))
    const adapter = new WindowedAdapter([
      toolCallResponse('call-1', 'echo', { text: 'tool one' }),
      toolCallResponse('call-2', 'ctx_reduce', { drop: '2' }),
      textResponse('queued'),
      textResponse('done'),
    ], 12)
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
      policy: { executeThreshold: 50, forceThreshold: 90, protectedToolResults: 0, historianProtectedNodes: 0 },
    })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent: Agent = await ctx.agentLoop.create(SessionId('mc-journal-1'), { provider: 'mock', model: 'mock' })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })

      const reader = openStores(dataDir)
      try {
        const kinds = new Set(reader.listJournal({ limit: 200 }).map(entry => entry.kind))
        expect(kinds.has('boot')).toBe(true)
        expect(kinds.has('session-first-seen')).toBe(true)
        expect(kinds.has('pass')).toBe(true)
        expect(kinds.has('tool-call')).toBe(true)
        expect(kinds.has('drop-landed')).toBe(true)

        const boot = reader.listJournal({ kinds: ['boot'] })[0]!
        expect(boot.data?.tools).toBeDefined()
        expect(boot.data?.policy).toBeDefined()
        const reduceCall = reader.listJournal({ kinds: ['tool-call'] })
          .find(entry => entry.data?.tool === 'ctx_reduce')
        expect(reduceCall?.data?.queued).toEqual([2])
        const landed = reader.listJournal({ kinds: ['drop-landed'] })[0]!
        expect(landed.data?.tags).toEqual([2])
        const executePass = reader.listJournal({ kinds: ['pass'] })
          .find(entry => entry.data?.decision === 'execute')
        expect(executePass).toBeDefined()
        expect(executePass?.data?.landed).toEqual([2])
        // Net-reclaim proof: the pass carries the surface estimate before/after.
        expect(typeof executePass?.data?.tokensBefore).toBe('number')
        expect(typeof executePass?.data?.tokensAfter).toBe('number')
        expect(executePass?.data?.tokensDelta).toBe(
          (executePass?.data?.tokensAfter as number) - (executePass?.data?.tokensBefore as number),
        )
      } finally {
        reader.close()
      }

      const mirror = join(dataDir, 'activity.log')
      expect(existsSync(mirror)).toBe(true)
      const mirrorText = readFileSync(mirror, 'utf8')
      expect(mirrorText).toContain('boot')
      expect(mirrorText).toContain('drop-landed')
    } finally {
      try {
        await ctx.fiber.dispose()
      } catch {
        /* best effort */
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })
})
