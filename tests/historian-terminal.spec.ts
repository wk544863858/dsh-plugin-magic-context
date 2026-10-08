/**
 * Historian terminal-event discipline — the regression suite for the
 * "127 × `phase: 'start'`, 0 × terminal" production failure.
 *
 * The defect: `callHistorian` journaled `start` and then took the LLM's
 * answer with a bare `await`. Any throw from the seam (`llm.stream()`) or from
 * the chunk walk escaped the function WITHOUT a journal row, the caller
 * (`management-pass`) swallowed it into a `logger.warn` the Desktop does not
 * persist, and `finally` released the session's `inFlight` slot — so the next
 * pass silently started again. The journal could only ever show `start`.
 *
 * These tests pin the invariant that replaces it: after a `start`, EXACTLY ONE
 * terminal event (`done` | `failed`) is written, on every path — success,
 * timeout (a seam that never settles), provider rejection, and two rejected
 * digests — and a timed-out run releases `inFlight` for the next pass.
 *
 * The last block drives the real agent loop with a provider adapter that
 * always throws, which is the production shape: the runtime converts an
 * adapter failure into a terminal `finish` error chunk, `collectText` throws,
 * and the journal must still close the run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin, { openStores } from '<path>'
import {
  callHistorian,
  runHistorian,
  selectHistorianRange,
  HistorianTimeoutError,
  HistorianTruncatedError,
  DEFAULT_HISTORIAN_TIMEOUT_MS,
  HISTORIAN_MIN_OUTPUT_TOKENS,
  type HistorianLlm,
} from '<path>'
import { spanRequestMessages, type SurfaceNode } from '<path>'
import type { Journal, JournalKind, JournalLevel } from '<path>'
import { DEFAULT_POLICY } from '<path>'
import { answerLlm, hangingLlm, scriptLlm } from './helpers/llm-fake'

const SESSION = 'mc-historian-terminal-session'

/** One recorded journal call, in order. */
interface Call {
  readonly level: JournalLevel
  readonly kind: JournalKind
  readonly summary: string
  readonly data?: Record<string, unknown>
  readonly sessionId?: string
}

/** A journal that records calls instead of persisting them. */
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

const historianCalls = (calls: readonly Call[]): Call[] => calls.filter(call => call.kind === 'historian')
const phases = (calls: readonly Call[]): string[] =>
  historianCalls(calls).map(call => String(call.data?.phase ?? '?'))
const starts = (calls: readonly Call[]): Call[] => historianCalls(calls).filter(call => call.data?.phase === 'start')
const terminals = (calls: readonly Call[]): Call[] =>
  historianCalls(calls).filter(call => call.data?.phase === 'done' || call.data?.phase === 'failed')

/** Two surface nodes: enough for a span; the content is irrelevant to the seam. */
const NODES = [
  { seq: 1, type: 'user/message', role: 'user', text: 'hello there', hasText: true, isPlaceholder: false, hasToolCalls: false },
  { seq: 2, type: 'assistant/message', role: 'assistant', text: 'working on it', hasText: true, isPlaceholder: false, hasToolCalls: false },
] as unknown as SurfaceNode[]

/** A session stub in the REAL event shapes (`deriveEventMessage`,
 * packages/core/session/src/surface.ts:132-145): `user/message` carries the
 * message itself as the event data; assistant/system/developer/tool wrap it in
 * `data.message`. The earlier stub wrapped the user message too, which is a
 * shape no live session ever produces — that is exactly how `spanRequestMessages`
 * kept dropping every user turn unnoticed. */
const SESSION_STUB = {
  snapshotEvents: () => [
    { seq: 1, type: 'user/message', data: { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'hello there' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } } },
  ],
} as unknown as Parameters<typeof spanRequestMessages>[0]

/** A digest that satisfies the FULL contract, facts included. */
function digest(options: { facts?: unknown; importance?: number } = {}): string {
  return JSON.stringify({
    summary: { p1: 'P1 detail', p2: 'P2', p3: 'P3', p4: 'P4' },
    importance: options.importance ?? 77,
    facts: options.facts ?? [{ category: 'CONSTRAINTS', content: 'never delete the memory database' }],
    events: ['tried X, failed because Y'],
  })
}



/** Streams a partial answer and then reports the output cap was hit. */
function truncatedFrame(): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '{"summary":{"p1":"cut off here' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })()
}


interface UnitDeps {
  policy: typeof DEFAULT_POLICY
  llm: HistorianLlm
  logger: { info: (message: string) => void; warn: (message: string) => void }
  route: { provider: string; model: string } | undefined
  journal: Journal
  timeoutMs?: number
  now?: () => number
}

function baseDeps(llm: HistorianLlm, journal: Journal, extra: Partial<UnitDeps> = {}): UnitDeps {
  return {
    policy: { ...DEFAULT_POLICY, historianTimeoutMs: 60_000 },
    llm,
    logger: { info: () => {}, warn: () => {} },
    route: { provider: 'mock-historian', model: 'mock' },
    journal,
    ...extra,
  }
}

describe('historian terminal events (unit)', () => {
  it('replays the span in provider order, user turns included (real event shapes)', () => {
    // Regression: reading only `data.message` returned nothing for user/message
    // (its payload IS the message), so the replayed prefix was assistant-only —
    // no longer a prefix of the routed request, and the digest lost the turns.
    const replayed = spanRequestMessages(SESSION_STUB, [1, 2]) as Array<{ role?: string }>
    expect(replayed.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('success: writes exactly one start + one done, with the facts contract intact', async () => {
    const calls: Call[] = []
    const fake = answerLlm(digest())
    const options = (): GenerateOptions | undefined => fake.calls[0]?.request as GenerateOptions | undefined
    const draft = await callHistorian(baseDeps(fake.llm as HistorianLlm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    })

    // The `{category, content}` contract survives parsing, not just the count.
    expect(draft.facts).toEqual([{ category: 'CONSTRAINTS', content: 'never delete the memory database' }])
    expect(draft.importance).toBe(77)
    expect(draft.tiers.p1).toBe('P1 detail')

    expect(starts(calls).length).toBe(1)
    expect(phases(calls)).toEqual(['start', 'done'])
    const done = terminals(calls)[0]!
    expect(done.level).toBe('info')
    expect(done.data?.facts).toBe(1)
    expect(done.data?.events).toBe(1)
    expect(done.data?.attempts).toBe(1)
    expect(done.data?.trigger).toBe('automatic')
    expect(typeof done.data?.durationMs).toBe('number')
    expect(done.data?.timeoutMs).toBe(60_000)

    // The seam really received the route, the purpose and the instruction.
    expect(options()?.provider).toBe('mock-historian')
    expect(options()?.purpose).toBe('compaction')
    expect(JSON.stringify(options()?.messages)).toContain('HISTORIAN')
  })

  it('timeout: a seam that never settles still lands one failed row and aborts the seam', async () => {
    const calls: Call[] = []
    const fake = hangingLlm()
    const started = Date.now()
    const error = await callHistorian(
      baseDeps(fake.llm as HistorianLlm, recordingJournal(calls), { timeoutMs: 40 }),
      { sessionId: SESSION, session: SESSION_STUB, nodes: NODES },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(HistorianTimeoutError)
    expect((error as HistorianTimeoutError).timeoutMs).toBeGreaterThan(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    // The seam was told to stop (a compliant provider releases its socket).
    expect(fake.signals.length).toBe(1)
    expect(fake.signals[0]!.aborted).toBe(true)

    expect(phases(calls)).toEqual(['start', 'failed'])
    const failed = terminals(calls)[0]!
    expect(failed.level).toBe('error')
    expect(failed.data?.kind).toBe('timeout')
    expect(failed.data?.errorName).toBe('HistorianTimeoutError')
    expect(String(failed.data?.reason)).toContain('timed out')
    expect(failed.data?.attempts).toBe(1)
    expect(typeof failed.data?.durationMs).toBe('number')
  })

  it('provider rejection: a synchronous seam throw lands one failed row naming the error', async () => {
    const calls: Call[] = []
    const llm: HistorianLlm = {
      stream: () => { throw new Error('no adapter registered for provider "provider-a"') },
    }
    const error = await callHistorian(baseDeps(llm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(phases(calls)).toEqual(['start', 'failed'])
    const failed = terminals(calls)[0]!
    expect(failed.level).toBe('error')
    expect(failed.data?.kind).toBe('stream-error')
    expect(failed.data?.errorName).toBe('Error')
    expect(String(failed.data?.reason)).toContain('no adapter registered')
    // A transport failure is not retried; only a rejected digest is.
    expect(failed.data?.attempts).toBe(1)
  })

  it('mid-stream failure: an iterator that throws lands one failed row, not two', async () => {
    const calls: Call[] = []
    const llm: HistorianLlm = {
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: '{"summary"' }
        throw new Error('historian call failed: provider closed the connection')
      })(),
    }
    await callHistorian(baseDeps(llm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    }).catch(() => undefined)

    expect(phases(calls)).toEqual(['start', 'failed'])
    expect(String(terminals(calls)[0]!.data?.reason)).toContain('provider closed the connection')
  })

  it('invalid digest twice: retries once, then lands a single failed row with attempts=2', async () => {
    const calls: Call[] = []
    const llm = answerLlm('not json at all').llm as HistorianLlm
    const error = await callHistorian(baseDeps(llm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(phases(calls)).toEqual(['start', 'failed'])
    const failed = terminals(calls)[0]!
    expect(failed.data?.kind).toBe('invalid-output')
    expect(failed.data?.attempts).toBe(2)
  })

  it('a below-floor configured cap is raised and the raise is journaled', async () => {
    const calls: Call[] = []
    const seen = scriptLlm([digest()])
    const deps = baseDeps(
      seen.llm as HistorianLlm,
      recordingJournal(calls),
    )
    // 2048 is the production value that truncated every run.
    const draft = await callHistorian(
      { ...deps, policy: { ...deps.policy, historianMaxTokens: 2_048 } },
      { sessionId: SESSION, session: SESSION_STUB, nodes: NODES },
    )
    expect(draft.tiers.p1).toBe('P1 detail')
    expect(seen.maxTokens).toEqual([HISTORIAN_MIN_OUTPUT_TOKENS])
    expect(starts(calls)[0]!.data?.maxTokens).toBe(HISTORIAN_MIN_OUTPUT_TOKENS)
    expect(starts(calls)[0]!.data?.configuredMaxTokens).toBe(2_048)
  })

  it('truncation is retried with an escalated cap and can still succeed', async () => {
    const calls: Call[] = []
    // The fake records the cap each request carried.
    const fake = scriptLlm([truncatedFrame, digest()])
    const draft = await callHistorian(baseDeps(fake.llm as HistorianLlm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    })

    expect(draft.importance).toBe(77)
    expect(phases(calls)).toEqual(['start', 'done'])
    const done = terminals(calls)[0]!
    expect(done.data?.attempts).toBe(2)
    expect(done.data?.maxTokens).toBe(HISTORIAN_MIN_OUTPUT_TOKENS * 2)
    // The floor cap on attempt 1, the escalated cap on attempt 2.
    expect(fake.maxTokens).toEqual([HISTORIAN_MIN_OUTPUT_TOKENS, HISTORIAN_MIN_OUTPUT_TOKENS * 2])
  })

  it('an optional policy ceiling caps the escalated retry', async () => {
    const calls: Call[] = []
    const fake = scriptLlm([truncatedFrame, digest()])
    const deps = baseDeps(fake.llm as HistorianLlm, recordingJournal(calls))
    const policy = { ...deps.policy, historianMaxTokens: 2_048, historianMaxTokensCeiling: 12_000 }
    await callHistorian({ ...deps, policy: policy as typeof deps.policy }, {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    })
    // Floor cap first, then the doubled cap clamped to the configured ceiling.
    expect(fake.maxTokens).toEqual([HISTORIAN_MIN_OUTPUT_TOKENS, 12_000])
  })

  it('truncation twice: one failed row, kind max-tokens, with the measured partial size', async () => {
    const calls: Call[] = []
    const llm: HistorianLlm = { stream: () => truncatedFrame() }
    const error = await callHistorian(baseDeps(llm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(HistorianTruncatedError)
    expect(phases(calls)).toEqual(['start', 'failed'])
    const failed = terminals(calls)[0]!
    expect(failed.data?.kind).toBe('max-tokens')
    expect(failed.data?.attempts).toBe(2)
    // The first cap was the floor, the retry escalated; the failure reports the
    // LAST cap plus how much of the answer escaped before the cut.
    expect(failed.data?.maxTokens).toBe(HISTORIAN_MIN_OUTPUT_TOKENS * 2)
    expect(failed.data?.partialChars).toBe('{"summary":{"p1":"cut off here'.length)
    expect(String(failed.data?.reason)).toContain('truncated')
  })

  it('a session store that throws before the call leaves no start row at all', async () => {
    const calls: Call[] = []
    const llm = answerLlm(digest()).llm as HistorianLlm
    const brokenSession = {
      snapshotEvents: () => { throw new Error('session store is unavailable') },
    } as unknown as typeof SESSION_STUB
    const error = await callHistorian(baseDeps(llm, recordingJournal(calls)), {
      sessionId: SESSION,
      session: brokenSession,
      nodes: NODES,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    // Either no row, or `start` + exactly one terminal — never a bare `start`.
    expect(calls).toEqual([])
  })

  it('start with no route fails before the start event, leaving nothing dangling', async () => {
    const calls: Call[] = []
    const error = await callHistorian(
      { ...baseDeps(answerLlm('x').llm as HistorianLlm, recordingJournal(calls)), route: undefined },
      { sessionId: SESSION, session: SESSION_STUB, nodes: NODES },
    ).catch((cause: unknown) => cause)
    expect(String((error as Error).message)).toContain('no routed provider/model')
    expect(historianCalls(calls).length).toBe(0)
  })

  it('default budget is two minutes and is overridable through the policy', async () => {
    expect(DEFAULT_HISTORIAN_TIMEOUT_MS).toBe(120_000)
    expect(DEFAULT_POLICY.historianTimeoutMs).toBe(120_000)

    const calls: Call[] = []
    const deps = baseDeps(hangingLlm().llm as HistorianLlm, recordingJournal(calls))
    await callHistorian({ ...deps, policy: { ...deps.policy, historianTimeoutMs: 30 } }, {
      sessionId: SESSION,
      session: SESSION_STUB,
      nodes: NODES,
    }).catch(() => undefined)
    expect(terminals(calls)[0]!.data?.timeoutMs).toBe(30)
    expect(terminals(calls)[0]!.data?.kind).toBe('timeout')
  })
})

describe('historian span edges are tool-pairing safe', () => {
  let seq = 0
  const node = (role: SurfaceNode['role'], extra: Partial<SurfaceNode> = {}): SurfaceNode => {
    seq += 1
    return {
      seq,
      type: `${role}/message`,
      role,
      text: `${role} ${String(seq)}`,
      hasText: true,
      isPlaceholder: false,
      hasToolCalls: false,
      ...extra,
    } as SurfaceNode
  }

  it('never opens the span on an orphan tool result', () => {
    // The producer assistant carries no text, so it is skipped as content-free;
    // the span must not begin on the result it left behind.
    seq = 0
    const nodes = [
      node('system'),
      node('assistant', { text: '', hasText: false, hasToolCalls: true }),
      node('tool'),
      node('assistant'),
      node('user'),
    ]
    const range = selectHistorianRange({ nodes, covered: new Set(), protectedNodes: 0, minNodes: 1 })
    expect(range).toBeDefined()
    expect(range!.nodes[0]!.role).not.toBe('tool')
    expect(range!.nodes[0]!.seq).toBe(nodes[3]!.seq)
  })

  it('never closes the span on a producer whose tool results are outside it', () => {
    // The live step between an assistant message and its tool results: the
    // surface ends on a tool-requesting assistant. A span that ends there
    // carries a dangling `tool_use`, which providers reject outright.
    seq = 0
    const nodes = [
      node('user'),
      node('assistant', { hasToolCalls: true }),
      node('tool'),
      node('user'),
      node('assistant', { hasToolCalls: true }),
    ]
    const range = selectHistorianRange({ nodes, covered: new Set(), protectedNodes: 0, minNodes: 1 })
    expect(range).toBeDefined()
    const last = range!.nodes[range!.nodes.length - 1]!
    expect(last.hasToolCalls).toBe(false)
    // The complete pair from earlier stays available for the digest.
    expect(range!.nodes.some(candidate => candidate.hasToolCalls)).toBe(true)
  })

  it('never strands a tool result whose producer the span would digest away', () => {
    seq = 0
    const nodes = [
      node('user'),
      node('assistant', { hasToolCalls: true }),
      node('tool'),
      node('user'),
      node('assistant', { hasToolCalls: true }),
      node('tool'),
    ]
    // A blind cut at protectedNodes=1 would equal [0..5): the span would keep
    // the second producer but leave its result out. The boundary walks back to
    // the pair instead.
    const range = selectHistorianRange({ nodes, covered: new Set(), protectedNodes: 1, minNodes: 1 })
    expect(range).toBeDefined()
    expect(range!.nodes.map(candidate => candidate.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(range!.nodes.at(-1)!.hasToolCalls).toBe(false)
    expect(range!.nodes.at(-1)!.role).not.toBe('tool')
  })

  it('returns nothing when every eligible node is an unpaired tool result', () => {
    seq = 0
    const nodes = [
      node('tool', { hasText: false }),
      node('tool'),
    ]
    expect(selectHistorianRange({ nodes, covered: new Set(), protectedNodes: 0, minNodes: 1 })).toBeUndefined()
  })
})

describe('historian terminal events (runHistorian, real stores)', () => {
  it('a timed-out run releases the in-flight slot for the next pass', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-historian-inflight-'))
    const stores = openStores(dataDir)
    try {
      const calls: Call[] = []
      const journal = recordingJournal(calls)
      const policy = { ...DEFAULT_POLICY, historianTimeoutMs: 30 }

      const timedOut = await runHistorian(
        { stores, policy, llm: hangingLlm().llm as HistorianLlm, logger: { info: () => {}, warn: () => {} }, journal, route: { provider: 'mock-historian', model: 'mock' } },
        { sessionId: SESSION, session: SESSION_STUB, nodes: NODES, forcedRange: NODES },
      ).catch((cause: unknown) => cause)
      expect(timedOut).toBeInstanceOf(HistorianTimeoutError)
      expect(phases(calls)).toEqual(['start', 'failed'])

      // Same session, same module: a leaked `inFlight` entry would return
      // undefined here and never store a compartment.
      const compartment = await runHistorian(
        { stores, policy, llm: answerLlm(digest({ importance: 91 })).llm as HistorianLlm, logger: { info: () => {}, warn: () => {} }, journal, route: { provider: 'mock-historian', model: 'mock' } },
        { sessionId: SESSION, session: SESSION_STUB, nodes: NODES, forcedRange: NODES },
      )
      expect(compartment).toBeDefined()
      expect(compartment?.importance).toBe(91)
      // The facts contract reaches durable storage, which is what promotion reads.
      expect(compartment?.facts).toEqual([{ category: 'CONSTRAINTS', content: 'never delete the memory database' }])
      expect(stores.listCompartments(SESSION).length).toBe(1)
      expect(stores.listUnlandedCompartments(SESSION).length).toBe(1)

      // Every start closed exactly once, across both runs; the successful run
      // adds ONE extra `stored` row (the durable compartment), which is not a
      // second terminal event but the proof the digest reached the store.
      expect(starts(calls).length).toBe(2)
      expect(terminals(calls).length).toBe(2)
      expect(phases(calls)).toEqual(['start', 'failed', 'start', 'done', 'stored'])
      const stored = historianCalls(calls).find(call => call.data?.phase === 'stored')
      expect(typeof stored?.data?.compartmentId).toBe('number')
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })
})

describe('historian terminal events (real agent loop)', () => {
  class WindowedAdapter extends MockAdapter {
    constructor(script: ConstructorParameters<typeof MockAdapter>[0], private readonly contextWindow: number) {
      super(script)
    }

    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { ...(await super.resolveModel(provider, model)), context: { contextWindow: this.contextWindow } }
    }
  }

  /** Every historian call is rejected the way a real provider route rejects. */
  class RejectingAdapter extends MockAdapter {
    override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      throw new Error('provider rejected the historian request (HTTP 400): boom')
    }
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

  async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('condition not reached before the timeout')
  }

  it('a rejected historian call leaves a failed row, never a bare start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-historian-loop-'))
    const ctx = new Context()
    const adapter = new WindowedAdapter([
      toolCallResponse('call-1', 'echo', { text: 'first output' }),
      toolCallResponse('call-2', 'echo', { text: 'second output' }),
      textResponse('done'),
      textResponse('more done'),
      textResponse('again'),
    ], 12)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(mcDshPlugin, {
      dataDir,
      historian: { provider: 'rejecting', model: 'rejecting' },
      policy: {
        executeThreshold: 50,
        forceThreshold: 90,
        protectedToolResults: 0,
        historianProtectedNodes: 0,
        historianMinNodes: 2,
        historianMinBudgetTokens: 1,
        historianTimeoutMs: 60_000,
      },
    })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.llm.registerAdapter(['rejecting'], new RejectingAdapter([]))
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId(`mc-historian-loop-${String(Date.now())}`), { provider: 'mock', model: 'mock' })
    const reader = openStores(dataDir)
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await idle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }))
      await idle(ctx, agent)

      const historianRows = (): Array<{ level: string; data?: Record<string, unknown> }> =>
        reader.listJournal({ kinds: ['historian'], sessionId: agent.session.id, limit: 100 })
          .map(row => ({ level: row.level, data: row.data }))
      await until(() => historianRows().some(row => row.data?.phase === 'failed'))

      const rows = historianRows()
      const startRows = rows.filter(row => row.data?.phase === 'start')
      const terminalRows = rows.filter(row => row.data?.phase === 'done' || row.data?.phase === 'failed')
      expect(startRows.length).toBeGreaterThan(0)
      // The whole defect in one assertion: no start without a terminal sibling.
      expect(terminalRows.length).toBe(startRows.length)

      const failed = terminalRows.find(row => row.data?.phase === 'failed')!
      expect(failed.level).toBe('error')
      expect(failed.data?.kind).toBe('stream-error')
      expect(String(failed.data?.reason)).toContain('boom')
      expect(typeof failed.data?.durationMs).toBe('number')
      expect(failed.data?.attempts).toBeGreaterThanOrEqual(1)
      expect(String(failed.data?.route)).toContain('rejecting/')

      // The mirror file carries the same story for a reviewer tailing it.
      const passRows = reader.listJournal({ kinds: ['pass'], sessionId: agent.session.id, limit: 20 })
        .filter(row => row.data?.decision === 'execute')
      expect(passRows.length).toBeGreaterThan(0)
      expect(passRows.some(row => row.data?.historianStarted === true)).toBe(true)
    } finally {
      reader.close()
      try {
        await ctx.fiber.dispose()
      } catch {
        /* best effort */
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })
})
