/**
 * The iron rule: an adapter fault must never take the main conversation down.
 * A stranded `tool_result` (its tool_use left the wire) 400s every
 * strict-provider request — the live 2026-10-09 outage. Two defenses, each
 * pinned here with its counter-example (must-not) and example (must):
 *
 *  - decision: `decidePass` forces the execute band on any live wire defect,
 *    before pressure (or the lack of a usage bill) can defer it;
 *  - repair: the pass sweeps stranded results off the wire unconditionally,
 *    and never touches a result whose tool_use is still live.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_POLICY, decidePass } from '../src/core/policy.ts'
import type { Compartment } from '../src/core/compartments.ts'
import type { Journal } from '../src/core/journal.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import { runManagementPass, type ManagementPassResult } from '../src/dsh/management-pass.ts'
import {
  enumerateSurfaceNodes,
  wireStrandedResults,
} from '../src/dsh/seams.ts'

interface Recorded {
  level: string
  kind: string
  summary: string
  data: unknown
}

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: unknown) => {
    entries.push({ level, kind, summary, data })
  }
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Journal
}

const silentLogger = { info: () => {}, warn: () => {} }

function appendUser(session: Session, text: string): SessionSeq {
  const event = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return event.seq
}

function appendAssistant(session: Session, turn: number, step: number, callIds: readonly string[]): SessionSeq {
  const event = session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'using tools' },
        ...callIds.map(id => ({ type: 'tool-call', id: ToolCallId(id), name: `tool-${id}`, arguments: '{}' })),
      ],
      provider: 'mock',
      model: 'mock',
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  return event.seq
}

function appendResult(session: Session, turn: number, step: number, callId: string, text: string): SessionSeq {
  const event = session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  return event.seq
}

function shadowOnly(session: Session, seq: SessionSeq, note: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: note }],
    source: { kind: 'user' },
  }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
}

const EMPTY_STORES = {
  listPendingDrops: () => [],
  getTag: () => undefined,
  baselineState: () => undefined,
  listUnlandedCompartments: () => [],
  listCompartments: () => [],
  markCompartmentLanded: () => {},
  saveBaselineState: () => {},
} as unknown as AdapterStores

function runPass(session: Session, stores: AdapterStores, entries: Recorded[]): ManagementPassResult {
  return runManagementPass({
    session,
    sessionId: 'mc-wire-repair',
    stores,
    policy: DEFAULT_POLICY,
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 10,
    journal: recordingJournal(entries),
  })
}

describe('the decision forces the execute band on a live wire defect', () => {
  it('反例: a stranded result with NO usage bill still executes (pressure cannot defer it)', () => {
    const pass = decidePass({ latest: undefined, pressure: undefined, now: 0, policy: DEFAULT_POLICY, wireDefects: 1 })
    expect(pass).toEqual({ kind: 'execute', reason: 'wire-repair' })
  })

  it('反例: a stranded result below the threshold executes instead of deferring', () => {
    const pass = decidePass({
      latest: { recordedAt: 0 } as NonNullable<Parameters<typeof decidePass>[0]['latest']>,
      pressure: 2,
      now: 1_000,
      policy: DEFAULT_POLICY,
      wireDefects: 3,
    })
    expect(pass).toEqual({ kind: 'execute', reason: 'wire-repair' })
  })

  it('正例: a healthy quiet session still defers — the override never fires without defects', () => {
    const pass = decidePass({ latest: undefined, pressure: undefined, now: 0, policy: DEFAULT_POLICY, wireDefects: 0 })
    expect(pass).toEqual({ kind: 'defer', reason: 'no-usage' })
  })

  it('the scanner: a live pair counts zero, shadowing the use strands the result', () => {
    const session = Session.create(SessionId('mc-wire-repair'))
    appendUser(session, 'turn')                                                 // seq 0
    const assistant = appendAssistant(session, 1, 1, ['call_a'])                // seq 1
    appendResult(session, 1, 1, 'call_a', 'output')                             // seq 2
    expect(wireStrandedResults(session)).toEqual([])

    shadowOnly(session, assistant, '[compacted §C0§]')                          // seq 3
    const stranded = wireStrandedResults(session)
    expect(stranded.length).toBe(1)
    expect(stranded[0]?.callId).toBe('call_a')
  })
})

describe('the repair lane sweeps stranded results and never touches live pairs', () => {
  it('正例: an orphan left by an old broken publish is swept, and the wire heals', () => {
    const session = Session.create(SessionId('mc-wire-repair'))
    appendUser(session, 'kept head')                                             // seq 0
    const assistant = appendAssistant(session, 1, 1, ['call_a'])                 // seq 1
    appendResult(session, 1, 1, 'call_a', 'output a')                            // seq 2
    shadowOnly(session, assistant, '[compacted §C0§]')                           // seq 3

    const entries: Recorded[] = []
    const result = runPass(session, EMPTY_STORES, entries)

    expect(result.wireRepaired).toBe(1)
    expect(wireStrandedResults(session)).toEqual([])
    expect(enumerateSurfaceNodes(session).map(node => node.role)).not.toContain('tool')
    const row = entries.find(entry => entry.kind === 'wire-repair')
    expect(row?.summary).toContain('swept 1 stranded tool result')
  })

  it('反例: a result whose tool_use is live must not be swept', () => {
    const session = Session.create(SessionId('mc-wire-repair'))
    appendUser(session, 'turn')                                                  // seq 0
    appendAssistant(session, 1, 1, ['call_a'])                                   // seq 1
    appendResult(session, 1, 1, 'call_a', 'precious output')                     // seq 2

    const entries: Recorded[] = []
    const result = runPass(session, EMPTY_STORES, entries)

    expect(result.wireRepaired).toBe(0)
    const toolNode = enumerateSurfaceNodes(session).find(node => node.role === 'tool')
    expect(toolNode).toBeDefined()
    expect(toolNode?.text).toBe('precious output')
    expect(entries.filter(entry => entry.kind === 'wire-repair')).toEqual([])
  })

  it('正例: a pathological surface is capped per pass, and the remainder is reported', () => {
    const session = Session.create(SessionId('mc-wire-repair'))
    appendUser(session, 'head')                                                  // seq 0
    for (let index = 0; index < 20; index += 1) {
      const assistant = appendAssistant(session, 1, index + 1, [`call_${String(index)}`]) // odd seq
      appendResult(session, 1, index + 1, `call_${String(index)}`, 'output')     // even seq
      shadowOnly(session, assistant, `[compacted §C0§ #${String(index)}]`)
    }

    const entries: Recorded[] = []
    const result = runPass(session, EMPTY_STORES, entries)

    expect(result.wireRepaired).toBe(16)
    const row = entries.find(entry => entry.kind === 'wire-repair')
    expect((row?.data as { remaining?: number }).remaining).toBe(4)
    expect(wireStrandedResults(session).length).toBe(4)
  })

  it('正例: repair and publish coexist in one pass — the compartment range closes AND the orphan goes', () => {
    const session = Session.create(SessionId('mc-wire-repair'))
    appendUser(session, 'covered body')                                          // seq 0
    const assistant = appendAssistant(session, 1, 1, ['call_a'])                 // seq 1
    appendResult(session, 1, 1, 'call_a', 'output a')                            // seq 2
    shadowOnly(session, assistant, '[compacted §C0§]')                           // seq 3
    appendUser(session, 'covered tail')                                          // seq 4

    const compartment: Compartment = {
      sessionId: 'mc-wire-repair',
      compartmentId: 1,
      createdAt: 1_700_000_000_000,
      coveredStartSeq: 0,
      coveredEndSeq: 4,
      coveredSeqs: [0, 4],
      coveredTokens: 100,
      baselineEpoch: 1,
      tiers: { p1: 'd', p2: 'd', p3: 'd', p4: 'd' },
      importance: 50,
      facts: [],
      events: [],
    }
    const stores = {
      ...EMPTY_STORES,
      listUnlandedCompartments: () => [compartment],
      listCompartments: () => [compartment],
      markCompartmentLanded: () => {},
    } as unknown as AdapterStores

    const entries: Recorded[] = []
    const result = runPass(session, stores, entries)

    expect(result.wireRepaired).toBe(1)
    expect(result.published).toEqual([1])
    expect(wireStrandedResults(session)).toEqual([])
  })
})
