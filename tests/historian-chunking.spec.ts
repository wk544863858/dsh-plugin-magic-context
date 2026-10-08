/**
 * D1/D3 — historian chunking: an oversized span digests in contiguous
 * ~budget-token chunks and a final merge call folds the partial digests into
 * the one CompartmentDraft; the terminal invariant (start + exactly one
 * done/failed) holds across the extra calls, and the run budget scales with
 * the chunk count. A small span (or no chunk budget) keeps the single-call
 * behavior pinned by historian-terminal.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  callHistorian,
  DEFAULT_HISTORIAN_TIMEOUT_MS,
  planChunkSpans,
  type HistorianLlm,
  type SurfaceNode,
} from '<path>'
import type { Journal, JournalKind, JournalLevel } from '<path>'
import { spanRequestMessages } from '<path>'
import { DEFAULT_POLICY } from '<path>'
import { scriptLlm } from './helpers/llm-fake'

const SESSION = 'mc-historian-chunking-session'

interface Call {
  readonly level: JournalLevel
  readonly kind: JournalKind
  readonly summary: string
  readonly data?: Record<string, unknown>
}

function recordingJournal(calls: Call[]): Journal {
  const push = (level: JournalLevel) => (
    kind: JournalKind,
    summary: string,
    data?: Record<string, unknown>,
  ): void => { calls.push({ level, kind, summary, data }) }
  return {
    enabled: true,
    record: (level, kind, summary, data) => { calls.push({ level, kind, summary, data }) },
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    tail: () => [],
    byKind: () => [],
  } as unknown as Journal
}

const historianCalls = (calls: readonly Call[]): Call[] => calls.filter(call => call.kind === 'historian')
const phases = (calls: readonly Call[]): string[] =>
  historianCalls(calls).map(call => String(call.data?.phase ?? '?'))

function node(seq: number, text: string, overrides: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    seq,
    type: 'user/message',
    role: 'user',
    text,
    hasText: true,
    isPlaceholder: false,
    hasToolCalls: false,
    ...overrides,
  } as unknown as SurfaceNode
}

/** Real event shapes (`deriveEventMessage`, packages/core/session/src/surface.ts):
 * a `user/message` event carries the message ITSELF as its data. This stub used
 * to return an empty snapshot, so the replay path was never exercised — and a
 * bug that dropped every user turn from the replayed prefix stayed invisible. */
const SESSION_STUB = {
  snapshotEvents: () => Array.from({ length: 16 }, (_unused, index) => {
    const seq = index + 1
    return {
      seq,
      type: 'user/message',
      data: { id: `msg-${String(seq)}`, role: 'user', content: [{ type: 'text', text: `span text ${String(seq)}` }] },
    }
  }),
} as unknown as Parameters<typeof callHistorian>[1]['session']

function digest(marker: string): string {
  return JSON.stringify({
    summary: { p1: `P1 ${marker}`, p2: 'P2', p3: 'P3', p4: 'P4' },
    importance: 60,
    facts: [{ category: 'ARCHITECTURE', content: `fact from ${marker}` }],
    events: [`event ${marker}`],
  })
}


function frame(text: string): () => AsyncIterable<unknown> {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of text) yield { type: 'text-delta', index: 0, text: char }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function invalidFrame(): () => AsyncIterable<unknown> {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'not json at all' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const deps = (llm: HistorianLlm, calls: Call[]): unknown => ({
  policy: { ...DEFAULT_POLICY, historianTimeoutMs: 60_000 },
  llm,
  logger: { info: () => {}, warn: () => {} },
  route: { provider: 'mock-historian', model: 'mock' },
  journal: recordingJournal(calls),
  timeoutMs: 60_000,
})

describe('planChunkSpans', () => {
  it('keeps a single span without a budget or when the span fits', () => {
    const nodes = [node(1, 'a'), node(2, 'b')]
    expect(planChunkSpans(nodes, 100, undefined)).toHaveLength(1)
    expect(planChunkSpans(nodes, 100, 5_000)).toHaveLength(1)
  })

  it('splits an oversized span into contiguous node groups, at most 4', () => {
    const nodes = Array.from({ length: 12 }, (_unused, index) => node(index + 1, 'x'.repeat(4_000)))
    const groups = planChunkSpans(nodes, 12_000, 4_000)
    expect(groups.length).toBeGreaterThanOrEqual(2)
    expect(groups.length).toBeLessThanOrEqual(4)
    // contiguous, order-preserving, covering every node exactly once
    const seqs = groups.flat().map(node => node.seq)
    expect(seqs).toEqual(nodes.map(node => node.seq))
  })

  it('never opens a chunk on a tool result or closes one on a tool-requesting assistant', () => {
    // One turn's shape: user, assistant(tool-call), tool result, assistant. The
    // token target (2 000) is reached exactly on the tool-requesting assistant,
    // so a naive split opens the second chunk on its result — the shape the live
    // chunked run answered with 400. The cut must wait for the next safe node.
    const nodes = [
      node(1, 'a'.repeat(4_000)),
      node(2, 'b'.repeat(4_000), { role: 'assistant', hasToolCalls: true }),
      node(3, 'c'.repeat(4_000), { role: 'tool' }),
      node(4, 'd'.repeat(4_000), { role: 'assistant' }),
      node(5, 'e'.repeat(4_000)),
      node(6, 'f'.repeat(4_000)),
      node(7, 'g'.repeat(4_000)),
      node(8, 'h'.repeat(4_000)),
    ]
    const groups = planChunkSpans(nodes, 4_000, 2_000)
    expect(groups.length).toBeGreaterThanOrEqual(2)
    // Contiguous and order-preserving, and the first cut landed AFTER the result.
    expect(groups.flat().map(item => item.seq)).toEqual(nodes.map(item => item.seq))
    expect(groups[0]?.map(item => item.seq)).toEqual([1, 2, 3])
    for (const group of groups) {
      expect(group[0]?.role).not.toBe('tool')
      expect(group[group.length - 1]?.hasToolCalls).toBe(false)
    }
  })
})

describe('spanRequestMessages', () => {
  it('omits a tool result whose assistant tool-call is not in the same request', () => {
    const events = [
      { seq: 1, type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { seq: 2, type: 'tool/result', data: { message: { id: 'orphan', role: 'tool', toolCallId: 'call-gone', content: [{ type: 'text', text: 'orphan' }] } } },
      { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'echo' }] } } },
      { seq: 4, type: 'tool/result', data: { message: { id: 'r1', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'paired' }] } } },
    ]
    const session = { snapshotEvents: () => events } as unknown as Parameters<typeof spanRequestMessages>[0]
    const messages = spanRequestMessages(session, [1, 2, 3, 4] as never) as Array<{ id?: string }>
    expect(messages.map(message => message.id)).toEqual(['u1', 'a1', 'r1'])
  })
})

describe('the chunked run (D1/D3)', () => {
  it('digests chunks then merges: start + chunk events + one done, merged draft', async () => {
    const calls: Call[] = []
    const fake = scriptLlm([
      frame(digest('chunk-1')),
      frame(digest('chunk-2')),
      frame(digest('merged')),
    ])
    const nodes = Array.from({ length: 8 }, (_unused, index) => node(index + 1, 'x'.repeat(4_000)))
    const draft = await callHistorian(deps(fake.llm as HistorianLlm, calls) as never, {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes,
      chunkTokens: 4_000,
    })
    // The final draft is the MERGE output, not the last chunk's.
    expect(draft.tiers.p1).toBe('P1 merged')
    // start → chunk → chunk → merge → done; exactly one terminal. The merge
    // has its own beat (it was invisible until it timed out, live 17:50).
    expect(phases(calls)).toEqual(['start', 'chunk', 'chunk', 'merge', 'done'])
    const start = historianFirst(calls, 'start')
    expect(start?.data?.chunks).toBe(2)
    const merge = historianFirst(calls, 'merge')
    expect(merge?.data?.partials).toBe(2)
    const done = historianFirst(calls, 'done')!
    expect(done.data?.attempts).toBe(3)
    // the merge call carried the partial digests as JSON
    const prompts = fake.texts.map(text => text.slice(0, 60))
    expect(prompts.some(prompt => prompt.includes('Partial digest 1') || prompt.startsWith('You are the HISTORIAN merging'))).toBe(true)
    expect(prompts.some(prompt => prompt.includes('HISTORIAN merging'))).toBe(true)
  })

  it('fails closed when a chunk cannot produce a valid digest', async () => {
    const calls: Call[] = []
    const fake = scriptLlm([invalidFrame(), invalidFrame()])
    const nodes = Array.from({ length: 8 }, (_unused, index) => node(index + 1, 'x'.repeat(4_000)))
    const error = await callHistorian(deps(fake.llm as HistorianLlm, calls) as never, {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes,
      chunkTokens: 4_000,
    }).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('no JSON object')
    // one terminal failed; the chunked run never leaves a dangling start
    expect(phases(calls)).toEqual(['start', 'failed'])
    expect(historianFirst(calls, 'failed')?.data?.kind).toBe('invalid-output')
  })

  it('scales the run budget with the chunk count and caps at 600s', () => {
    const timeoutMs = 120_000
    const plannedCalls = 4
    expect(Math.min(600_000, timeoutMs * plannedCalls)).toBe(480_000)
    expect(Math.min(600_000, 200_000 * plannedCalls)).toBe(600_000)
    expect(DEFAULT_HISTORIAN_TIMEOUT_MS).toBe(120_000)
  })
})

function historianFirst(calls: readonly Call[], phase: string): Call | undefined {
  return historianCalls(calls).find(call => call.data?.phase === phase)
}
