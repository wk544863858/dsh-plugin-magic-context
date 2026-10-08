/**
 * `/ctx-recomp` — re-digesting an already-compacted span. The selection parsers
 * are pinned directly; the store round trip is pinned through the real adapter
 * database, because "the row is the thing the model reads" is the whole claim.
 */
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Compartment, CompartmentDraft } from '<path>'
import type { Journal } from '<path>'
import { DEFAULT_POLICY } from '<path>'
import { openStores } from '<path>'
import {
  parseRecompSelection,
  recompactCompartments,
  registerCtxRecompCommand,
  selectRecompTargets,
  snapRangeToCompartments,
} from '<path>'
import { scriptLlm } from './helpers/llm-fake'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
})

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  tempDirs.push(dir)
  return dir
}

/** The digest the historian is scripted to return on a recomp. */
const DIGEST = JSON.stringify({
  summary: { p1: 'RECOMP-P1', p2: 'recomp p2', p3: 'recomp p3', p4: 'recomp p4' },
  importance: 42,
  facts: [],
  events: ['recomp'],
})

/** The three messages a compartment covered before its placeholder shadowed them. */
const EVENTS = [
  { seq: 1, type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first user turn' }] } },
  {
    seq: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
  },
  { seq: 3, type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second user turn' }] } },
]

/** Only `snapshotEvents` is consulted: the covered events left the surface. */
const stubSession = (id: string): never =>
  ({ id, snapshotEvents: () => EVENTS, surface: { nodes: [] } }) as never

function oldDraft(): CompartmentDraft {
  return {
    tiers: { p1: 'OLD-P1', p2: 'old p2', p3: 'old p3', p4: 'old p4' },
    importance: 10,
    facts: [],
    events: ['old'],
  }
}

function capturedJournal(kinds: string[]): Journal {
  return {
    info: (kind: string) => kinds.push(kind),
    warn: (kind: string) => kinds.push(kind),
    error: (kind: string) => kinds.push(kind),
  } as unknown as Journal
}

const noopLogger = { info: () => {}, warn: () => {} }

describe('parseRecompSelection', () => {
  it('accepts empty, all, last:<n>, and a seq range', () => {
    expect(parseRecompSelection(undefined)).toEqual({ kind: 'all' })
    expect(parseRecompSelection('   ')).toEqual({ kind: 'all' })
    expect(parseRecompSelection('all')).toEqual({ kind: 'all' })
    expect(parseRecompSelection('last:2')).toEqual({ kind: 'last', count: 2 })
    expect(parseRecompSelection('100-200')).toEqual({ kind: 'range', start: 100, end: 200 })
    expect(parseRecompSelection('100 - 200')).toEqual({ kind: 'range', start: 100, end: 200 })
  })

  it('returns the usage line for anything else', () => {
    expect(parseRecompSelection('nonsense')).toContain('Usage')
    expect(parseRecompSelection('200-100')).toContain('Usage')
    expect(parseRecompSelection('last:0')).toContain('Usage')
  })
})

describe('snapRangeToCompartments', () => {
  const compartment = (id: number, start: number, end: number): Compartment =>
    ({ compartmentId: id, coveredStartSeq: start, coveredEndSeq: end }) as Compartment

  it('takes whole compartments and never splits one', () => {
    const all = [compartment(1, 1, 10), compartment(2, 11, 30), compartment(3, 31, 50)]
    // 25..32 touches the tail of C2 and the head of C3: both come whole.
    expect(snapRangeToCompartments(all, 25, 32).map(item => item.compartmentId)).toEqual([2, 3])
    expect(snapRangeToCompartments(all, 5, 5).map(item => item.compartmentId)).toEqual([1])
    expect(snapRangeToCompartments(all, 60, 70)).toEqual([])
  })
})

describe('recompactCompartments', () => {
  it('replaces the stored digest in place and journals the run', async () => {
    const dataDir = tempDir('mc-recomp-')
    const stores = openStores(dataDir)
    const sessionId = 'session-recomp'
    try {
      const created = stores.allocateCompartment(
        sessionId,
        oldDraft(),
        { startSeq: 1, endSeq: 3, seqs: [1, 2, 3], tokens: 30 },
        1,
        Date.now(),
      )
      stores.markCompartmentLanded(sessionId, created.compartmentId, 99)
      const targets = selectRecompTargets(stores, sessionId, { kind: 'all' })
      expect(targets.map(item => item.compartmentId)).toEqual([created.compartmentId])

      const kinds: string[] = []
      const fake = scriptLlm([DIGEST])
      const outcome = await recompactCompartments(
        {
          stores,
          policy: DEFAULT_POLICY,
          logger: noopLogger,
          journal: capturedJournal(kinds),
          llm: fake.llm,
          route: { provider: 'test', model: 'test' },
        },
        { sessionId, session: stubSession(sessionId), contextWindow: 100_000, targets },
      )

      expect(outcome.recompacted).toEqual([created.compartmentId])
      expect(outcome.failed).toEqual([])
      const after = stores.listCompartments(sessionId)[0]
      expect(after?.tiers.p1).toBe('RECOMP-P1')
      expect(after?.importance).toBe(42)
      // Identity, coverage and the landed placeholder are untouched: only the
      // text the model reads changed.
      expect(after?.landedEventSeq).toBe(99)
      expect(after?.coveredSeqs).toEqual([1, 2, 3])
      expect(kinds).toContain('compartment-recomp')
      // The historian call carries the scored calibration anchors: this is the one
      // place where a recomp request's prompt content is observable end to end.
      expect(JSON.stringify(fake.calls)).toContain('CALIBRATION ANCHORS')
    } finally {
      stores.close()
    }
  })

  it('keeps the old digest when the historian call fails and reports it', async () => {
    const dataDir = tempDir('mc-recomp-fail-')
    const stores = openStores(dataDir)
    const sessionId = 'session-recomp-fail'
    try {
      const created = stores.allocateCompartment(
        sessionId,
        oldDraft(),
        { startSeq: 1, endSeq: 3, seqs: [1, 2, 3], tokens: 30 },
        1,
        Date.now(),
      )
      stores.markCompartmentLanded(sessionId, created.compartmentId, 99)
      const kinds: string[] = []
      const fake = scriptLlm([new Error('provider exploded')])
      const outcome = await recompactCompartments(
        {
          stores,
          policy: DEFAULT_POLICY,
          logger: noopLogger,
          journal: capturedJournal(kinds),
          llm: fake.llm,
          route: { provider: 'test', model: 'test' },
        },
        {
          sessionId,
          session: stubSession(sessionId),
          contextWindow: 100_000,
          targets: selectRecompTargets(stores, sessionId, { kind: 'all' }),
        },
      )

      expect(outcome.recompacted).toEqual([])
      expect(outcome.failed).toHaveLength(1)
      expect(outcome.failed[0]?.compartmentId).toBe(created.compartmentId)
      expect(stores.listCompartments(sessionId)[0]?.tiers.p1).toBe('OLD-P1')
      expect(kinds).toContain('compartment-recomp')
    } finally {
      stores.close()
    }
  })

  it('skips a compartment whose covered events are no longer in the log', async () => {
    const dataDir = tempDir('mc-recomp-skip-')
    const stores = openStores(dataDir)
    const sessionId = 'session-recomp-skip'
    try {
      const created = stores.allocateCompartment(
        sessionId,
        oldDraft(),
        { startSeq: 900, endSeq: 901, seqs: [900, 901], tokens: 30 },
        1,
        Date.now(),
      )
      stores.markCompartmentLanded(sessionId, created.compartmentId, 99)
      const fake = scriptLlm([DIGEST])
      const outcome = await recompactCompartments(
        {
          stores,
          policy: DEFAULT_POLICY,
          logger: noopLogger,
          llm: fake.llm,
          route: { provider: 'test', model: 'test' },
        },
        {
          sessionId,
          session: stubSession(sessionId),
          contextWindow: 100_000,
          targets: selectRecompTargets(stores, sessionId, { kind: 'all' }),
        },
      )

      expect(outcome.recompacted).toEqual([])
      expect(outcome.skipped).toHaveLength(1)
      expect(fake.calls).toHaveLength(0)
      expect(stores.listCompartments(sessionId)[0]?.tiers.p1).toBe('OLD-P1')
    } finally {
      stores.close()
    }
  })

  it('selects the newest landed compartments for last:<n>', () => {
    const dataDir = tempDir('mc-recomp-last-')
    const stores = openStores(dataDir)
    const sessionId = 'session-recomp-last'
    try {
      for (const [start, landed] of [[1, 11], [5, 12], [9, undefined]] as const) {
        const created = stores.allocateCompartment(
          sessionId,
          oldDraft(),
          { startSeq: start, endSeq: start + 3, seqs: [start, start + 1], tokens: 10 },
          1,
          Date.now(),
        )
        if (landed !== undefined) stores.markCompartmentLanded(sessionId, created.compartmentId, landed)
      }
      expect(selectRecompTargets(stores, sessionId, { kind: 'last', count: 1 }).map(item => item.compartmentId)).toEqual([2])
      expect(selectRecompTargets(stores, sessionId, { kind: 'all' }).map(item => item.compartmentId)).toEqual([1, 2])
      expect(selectRecompTargets(stores, sessionId, { kind: 'range', start: 6, end: 6 }).map(item => item.compartmentId)).toEqual([2])
    } finally {
      stores.close()
    }
  })
})

describe('registerCtxRecompCommand', () => {
  it('is accepted by the real command service and visible to an agent', async () => {
    // The host validates every definition (name pattern, non-empty description,
    // function handler, string input hint) and drops a rejected one silently behind
    // a log line — so the only proof that the command exists is the real service.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const dataDir = tempDir('mc-recomp-mount-')
    const stores = openStores(dataDir)
    try {
      registerCtxRecompCommand(ctx as never, {
        stores,
        policy: DEFAULT_POLICY,
        logger: noopLogger,
        llm: {} as never,
        route: { provider: 'test', model: 'test' },
      })
      const session = ctx.sessions.create(SessionId('recomp-mount'))
      const agent = { id: session.id, session }
      expect(ctx.commands.find(agent, 'ctx-recomp')?.description).toContain('re-digest')
      expect(ctx.commands.list(agent).map(entry => entry.name)).toContain('ctx-recomp')
    } finally {
      stores.close()
    }
  })
})
