/**
 * WP5 — the collection lane inside a REAL historian run.
 *
 * `tests/profile-collection.spec.ts` proves the writer and the parser in
 * isolation. This file proves the seam: `runHistorian` calls the sink with the
 * range of the compartment it just stored, and — the case that actually
 * matters — a sink that THROWS still leaves the compartment durable, the run
 * terminal, and an error row in the journal.
 *
 * Why the throwing case is the important one: staging is the only step in this
 * lane that writes, and it runs after the expensive part is already safe. If a
 * candidate write could fail the run, a contract hiccup would cost the digest.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import { runHistorian, type HistorianLlm } from '../src/dsh/historian.ts'
import type { SurfaceNode } from '../src/dsh/seams.ts'
import type { Journal, JournalKind, JournalLevel } from '../src/core/journal.ts'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { answerLlm } from './helpers/llm-fake'

const SESSION = 'mc-profile-collect-run'

interface Call {
  readonly level: JournalLevel
  readonly kind: JournalKind
  readonly summary: string
  readonly data?: Record<string, unknown>
  readonly sessionId?: string
}

function recordingJournal(calls: Call[]): Journal {
  const push = (level: JournalLevel) => (
    kind: JournalKind,
    summary: string,
    data?: Record<string, unknown>,
    sessionId?: string,
  ): void => { calls.push({ level, kind, summary, data, sessionId }) }
  return {
    enabled: true,
    record: (level, kind, summary, data, sessionId) => { calls.push({ level, kind, summary, data, sessionId }) },
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    tail: () => [],
    byKind: () => [],
  } as unknown as Journal
}

const NODES = [
  { seq: 1, type: 'user/message', role: 'user', text: 'hello there', hasText: true, isPlaceholder: false, hasToolCalls: false },
  { seq: 2, type: 'assistant/message', role: 'assistant', text: 'working on it', hasText: true, isPlaceholder: false, hasToolCalls: false },
] as unknown as SurfaceNode[]

const SESSION_STUB = {
  snapshotEvents: () => [
    { seq: 1, type: 'user/message', data: { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'hello there' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } } },
  ],
} as unknown as Parameters<typeof runHistorian>[1]['session']

function digestWith(observations: readonly string[]): string {
  return JSON.stringify({
    summary: { p1: 'P1 detail', p2: 'P2', p3: 'P3', p4: 'P4' },
    importance: 70,
    facts: [],
    events: [],
    userObservations: observations,
  })
}

function withStores<T>(fn: (stores: ReturnType<typeof openStores>) => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mc-profile-run-'))
  const stores = openStores(dataDir)
  return fn(stores).finally(() => {
    stores.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  })
}

const historianCalls = (calls: readonly Call[]): Call[] => calls.filter(call => call.kind === 'historian')

describe('runHistorian → the user-observation sink', () => {
  it('hands the sink the digest observations and the range of the stored compartment', async () => {
    await withStores(async (stores) => {
      const calls: Call[] = []
      const seen: Array<{ sessionId: string; observations: readonly string[]; start: number | null; end: number | null }> = []
      const compartment = await runHistorian(
        {
          stores,
          policy: DEFAULT_POLICY,
          llm: answerLlm(digestWith(['answer in Chinese', 'never push without asking'])).llm as HistorianLlm,
          logger: { info: () => {}, warn: () => {} },
          journal: recordingJournal(calls),
          route: { provider: 'mock-historian', model: 'mock' },
          profileCollect: (input) => {
            seen.push({
              sessionId: input.sessionId,
              observations: input.observations,
              start: input.compartmentStart,
              end: input.compartmentEnd,
            })
            return { inserted: input.observations.length, skipped: 0 }
          },
        },
        { sessionId: SESSION, session: SESSION_STUB, nodes: NODES, forcedRange: NODES },
      )

      expect(compartment).toBeDefined()
      expect(seen).toHaveLength(1)
      expect(seen[0]!.sessionId).toBe(SESSION)
      expect(seen[0]!.observations).toEqual(['answer in Chinese', 'never push without asking'])
      // The range is the compartment's own covered span, so a review pass can
      // say WHERE an observation came from.
      expect(seen[0]!.start).toBe(1)
      expect(seen[0]!.end).toBe(2)

      const staged = historianCalls(calls).find(call => call.data?.phase === 'profile-collect')
      expect(staged?.level).toBe('info')
      expect(staged?.data?.observations).toBe(2)
      expect(staged?.data?.inserted).toBe(2)
      expect(staged?.data?.skipped).toBe(0)
    })
  })

  it('survives a sink that throws: the compartment is still durable and the run still terminal', async () => {
    await withStores(async (stores) => {
      const calls: Call[] = []
      const compartment = await runHistorian(
        {
          stores,
          policy: DEFAULT_POLICY,
          llm: answerLlm(digestWith(['answer in Chinese'])).llm as HistorianLlm,
          logger: { info: () => {}, warn: () => {} },
          journal: recordingJournal(calls),
          route: { provider: 'mock-historian', model: 'mock' },
          profileCollect: () => {
            throw new Error('candidate table is locked')
          },
        },
        { sessionId: SESSION, session: SESSION_STUB, nodes: NODES, forcedRange: NODES },
      )

      // Fail-open is the whole point: the digest and its compartment outlive a
      // collection problem.
      expect(compartment).toBeDefined()
      expect(stores.listCompartments(SESSION)).toHaveLength(1)

      const phases = historianCalls(calls).map(call => String(call.data?.phase ?? '?'))
      expect(phases).toContain('stored')
      expect(phases).toContain('done')

      // The failure is NOT swallowed: the observations exist only in the draft,
      // so an error row is the only trace they ever existed.
      const failure = calls.find(call => call.data?.scope === 'profile-collect')
      expect(failure?.level).toBe('error')
      expect(failure?.summary).toContain('candidate table is locked')
    })
  })

  it('does not call the sink when the digest carries no observations', async () => {
    await withStores(async (stores) => {
      const calls: Call[] = []
      let called = 0
      await runHistorian(
        {
          stores,
          policy: DEFAULT_POLICY,
          llm: answerLlm(digestWith([])).llm as HistorianLlm,
          logger: { info: () => {}, warn: () => {} },
          journal: recordingJournal(calls),
          route: { provider: 'mock-historian', model: 'mock' },
          profileCollect: () => {
            called += 1
            return { inserted: 0, skipped: 0 }
          },
        },
        { sessionId: SESSION, session: SESSION_STUB, nodes: NODES, forcedRange: NODES },
      )
      expect(called).toBe(0)
      expect(historianCalls(calls).some(call => call.data?.phase === 'profile-collect')).toBe(false)
    })
  })
})
