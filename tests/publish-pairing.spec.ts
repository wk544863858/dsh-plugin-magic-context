/**
 * Publish-range tool-pairing closure — regression for the live 2026-10-09 400.
 *
 * The drop lane re-sequences a `[dropped §N§]` result to the surface tail while
 * its tool_use stays at the covered position. A publish range computed from
 * covered seqs alone then ended on the assistant node and stranded its results,
 * and the next provider request failed with `invalid_request_error: unexpected
 * tool_use_id ... found in tool_result blocks` (every turn 400ed until the
 * model route changed). These specs pin the invariant the fix protects:
 *
 *   after a pass, no live `tool/result` node may lack a live assistant
 *   carrying its tool-call id — the wire-pairing invariant.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import type { Compartment } from '../src/core/compartments.ts'
import type { Journal } from '../src/core/journal.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import { runManagementPass, type ManagementPassResult } from '../src/dsh/management-pass.ts'
import {
  dropPlaceholderContent,
  enumerateSurfaceNodes,
  replaceToolResultContent,
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

function compartment(partial: Partial<Compartment> & { coveredSeqs: readonly number[] }): Compartment {
  return {
    sessionId: 'mc-publish-pairing',
    compartmentId: 1,
    createdAt: 1_700_000_000_000,
    coveredStartSeq: partial.coveredSeqs[0] ?? 0,
    coveredEndSeq: partial.coveredSeqs[partial.coveredSeqs.length - 1] ?? 0,
    coveredTokens: 400,
    baselineEpoch: 1,
    tiers: { p1: 'd', p2: 'd', p3: 'd', p4: 'd' },
    importance: 50,
    facts: [],
    events: [],
    ...partial,
  } as Compartment
}

function storesFor(compartments: readonly Compartment[], landed: SessionSeq[]): AdapterStores {
  return {
    listPendingDrops: () => [],
    getTag: () => undefined,
    baselineState: () => undefined,
    listUnlandedCompartments: () => [...compartments],
    listCompartments: () => [...compartments],
    markCompartmentLanded: (_sessionId: string, _id: number, seq: number) => { landed.push(SessionSeq(seq)) },
    saveBaselineState: () => {},
  } as unknown as AdapterStores
}

function runPass(session: Session, stores: AdapterStores, entries: Recorded[]): ManagementPassResult {
  return runManagementPass({
    session,
    sessionId: 'mc-publish-pairing',
    stores,
    policy: DEFAULT_POLICY,
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 90,
    journal: recordingJournal(entries),
  })
}

/** The wire-pairing invariant: every live result pairs with a live assistant call. */
function strandedResults(session: Session): ReadonlyArray<{ seq: number; callId: string }> {
  const nodes = enumerateSurfaceNodes(session)
  const liveCallIds = new Set<string>()
  for (const node of nodes) {
    for (const id of node.toolCallIds ?? []) liveCallIds.add(id)
  }
  return nodes
    .filter(node => node.role === 'tool' && node.toolCallId !== undefined && !liveCallIds.has(node.toolCallId))
    .map(node => ({ seq: node.seq, callId: node.toolCallId as string }))
}

describe('publish ranges close over tool pairs', () => {
  it('the drop-then-publish incident: results re-sequenced to the tail are consumed, not stranded', () => {
    const session = Session.create(SessionId('mc-publish-pairing'))
    appendUser(session, 'turn one')                                              // seq 0
    const assistant = appendAssistant(session, 1, 2, ['call_a', 'call_b'])       // seq 1
    const resultA = appendResult(session, 1, 2, 'call_a', 'output a')            // seq 2
    const resultB = appendResult(session, 1, 2, 'call_b', 'output b')            // seq 3
    appendUser(session, 'turn two continues the conversation')                   // seq 4
    // The drop lane rewrites both results in place; the placeholders land at the
    // surface tail (seqs 5 and 6) and shadow the originals.
    replaceToolResultContent(session, resultA, dropPlaceholderContent(1))
    replaceToolResultContent(session, resultB, dropPlaceholderContent(2))

    const landed: SessionSeq[] = []
    const entries: Recorded[] = []
    const result = runPass(session, storesFor([compartment({
      coveredSeqs: [0, assistant, resultA, resultB],
    })], landed), entries)

    expect(result.published).toEqual([1])
    expect(landed).toHaveLength(1)
    expect(landed[0]).toBeGreaterThan(0)
    // The wire-pairing invariant holds: the re-sequenced placeholders were
    // folded into the replacement instead of outliving their tool_use.
    expect(strandedResults(session)).toEqual([])
    const liveRoles = enumerateSurfaceNodes(session).map(node => node.role)
    expect(liveRoles).not.toContain('tool')
    // Diagnosable: the publish row records that the closure widened the span.
    const publishedRow = entries.find(entry => entry.kind === 'compartment-published')
    expect(publishedRow).toBeDefined()
    const data = publishedRow?.data as { pairingClosure?: { rawFirst: number; rawLast: number; first: number; last: number } }
    expect(data.pairingClosure).toBeDefined()
    expect(data.pairingClosure?.last).toBeGreaterThan(data.pairingClosure?.rawLast ?? 0)
  })

  it('a compartment drafted before the chunking fix (ending on a tool-requesting assistant) still lands safely', () => {
    const session = Session.create(SessionId('mc-publish-pairing'))
    appendUser(session, 'early turn')                                             // seq 0
    const assistant = appendAssistant(session, 1, 1, ['call_x'])                  // seq 1
    appendResult(session, 1, 1, 'call_x', 'output x')                             // seq 2 (uncovered)
    appendUser(session, 'later turn')                                             // seq 3

    const landed: SessionSeq[] = []
    const result = runPass(session, storesFor([compartment({
      coveredSeqs: [0, assistant],
    })], landed), [])

    expect(result.published).toEqual([1])
    expect(strandedResults(session)).toEqual([])
  })

  it('a result stranded by an earlier broken publish is swept by the next compartment', () => {
    const session = Session.create(SessionId('mc-publish-pairing'))
    appendUser(session, 'kept head')                                              // seq 0
    appendUser(session, 'covered body')                                           // seq 1
    const assistant = appendAssistant(session, 2, 1, ['call_y'])                  // seq 2
    appendResult(session, 2, 1, 'call_y', 'output y')                             // seq 3
    // An old publish shadowed the assistant alone, stranding its result.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compacted §C0§]' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: assistant, endSeq: assistant }, sourceEventSeqs: [assistant] })

    const entries: Recorded[] = []
    const result = runPass(session, storesFor([compartment({
      coveredSeqs: [0, 1],
    })], []), entries)

    expect(result.published).toEqual([1])
    expect(strandedResults(session)).toEqual([])
  })

  it('a closure that would swallow the m[0] baseline node still defers', () => {
    const session = Session.create(SessionId('mc-publish-pairing'))
    appendUser(session, 'turn one')                                               // seq 0
    const assistant = appendAssistant(session, 1, 2, ['call_a'])                  // seq 1
    const resultA = appendResult(session, 1, 2, 'call_a', 'output a')             // seq 2
    appendUser(session, 'baseline carrier')                                       // seq 3
    replaceToolResultContent(session, resultA, dropPlaceholderContent(7))         // seq 4, tail

    const stores = {
      listPendingDrops: () => [],
      getTag: () => undefined,
      // A baseline node inside the closed window: the frozen m[0] must never be
      // folded into a compartment placeholder.
      baselineState: () => ({ provider: 'mock', model: 'mock', frozenAt: 0, nodeSeq: 4 }),
      listUnlandedCompartments: () => [compartment({ coveredSeqs: [0, assistant, resultA] })],
      listCompartments: () => [compartment({ coveredSeqs: [0, assistant, resultA] })],
      markCompartmentLanded: () => {},
      saveBaselineState: () => {},
    } as unknown as AdapterStores
    const entries: Recorded[] = []
    const result = runPass(session, stores, entries)

    expect(result.published).toEqual([])
    const warns = entries.filter(entry => entry.level === 'warn' && entry.kind === 'compartment-published')
    expect(warns.length).toBe(1)
    expect((warns[0]?.data as { reason?: string }).reason).toBe('baseline-in-range')
    expect(strandedResults(session)).toEqual([])
  })
})
