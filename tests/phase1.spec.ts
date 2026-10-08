/**
 * Magic Context — DSH adapter Phase 1 integration tests: the management loop.
 *
 * Covers the execute/defer discipline end-to-end against the real agent loop:
 *  - a queued ctx_reduce mark does NOT land on the pass that queued it
 *    (queue discipline: the mark waits for the reclaim band);
 *  - the next execute-band pass lands it as a durable placeholder before
 *    request derivation (the drop rides the band's one priced bust);
 *  - ctx_expand restores the original content from the cited source event;
 *  - emergency reclaim drops beyond the protected window and advances
 *    surface.replaceGeneration (the retry proof);
 *  - parseTagRanges handles MC's range grammar.
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
import mcDshPlugin, {
  DEFAULT_POLICY,
  openStores,
  reclaimForEmergency,
} from '<path>'
import { parseTagRanges, pressureWindowTokens } from '<path>'
import { enumerateSurfaceToolResults } from '<path>'

type AnyMessage = { role: string; content: Array<{ type: string; text?: string }> }

function textOf(message: AnyMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

function toolTexts(request: { messages: AnyMessage[] } | undefined): string[] {
  return (request?.messages ?? [])
    .filter(message => message.role === 'tool')
    .map(message => textOf(message))
}

/** MockAdapter whose resolved model declares a tiny context window, so the
 * real usage figures cross the adapter's execute band. */
class WindowedAdapter extends MockAdapter {
  constructor(
    script: ConstructorParameters<typeof MockAdapter>[0],
    private readonly contextWindow: number,
  ) {
    super(script)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      ...(await super.resolveModel(provider, model)),
      context: { contextWindow: this.contextWindow },
    }
  }
}

/** The band the specs below drive: execute early, nobody protected. */
const TEST_POLICY = { executeThreshold: 50, forceThreshold: 90, protectedToolResults: 0 }

async function boot(
  adapter: MockAdapter,
  dataDir: string,
  policy: Record<string, number> = TEST_POLICY,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(mcDshPlugin, { dataDir, policy })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
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

describe('magic-context dsh adapter (phase 1: management loop)', () => {
  it('queues ctx_reduce marks, lands them only in the execute band, and restores via ctx_expand', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-dsh-p1-'))
    const adapter = new WindowedAdapter([
      toolCallResponse('call-1', 'echo', { text: 'tool one' }),
      toolCallResponse('call-2', 'ctx_reduce', { drop: '1' }),
      textResponse('queued'),
      textResponse('done more'),
      toolCallResponse('call-3', 'ctx_expand', { tags: '1' }),
      textResponse('all done'),
    ], 12)
    const ctx = await boot(adapter, dataDir)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('mc-p1-1'), { provider: 'mock', model: 'mock' })
    const sessionId = agent.session.id

    try {
      // Turn 1: model calls echo, then ctx_reduce('1'). Usage from the first
      // response (10 tokens of a 12-token window) puts every later pass in
      // the execute band, so the queued mark lands on the very next pre-step.
      send(agent, 'hello world')
      await waitForIdle(ctx, agent)

      // The pass that queued the mark still carried the full content
      // (queue discipline: no landing outside the band).
      expect(toolTexts(adapter.requests[1])).toContain('§1§ echo:tool one')
      // The next pre-step landed the queued mark before deriving its request.
      expect(toolTexts(adapter.requests[2])).toContain('[dropped §1§]')
      expect(toolTexts(adapter.requests[2])).not.toContain('echo:tool one')
      // The drop is durable surface content with the original cited.
      const events = agent.session.snapshotEvents()
      const placeholder = events.findLast(event => event.type === 'tool/result'
        && (event.data.message.content[0] as { text?: string } | undefined)?.text === '[dropped §1§]')
      expect(placeholder?.sourceEventSeqs?.length).toBe(1)

      const reader = openStores(dataDir)
      try {
        expect(reader.listPendingDrops(sessionId)).toEqual([])
        expect(reader.latestUsage(sessionId)?.inputTokens).toBe(10)
      } finally {
        reader.close()
      }

      // Turn 2 rides the band with nothing queued: no-op execute pass.
      send(agent, 'more')
      await waitForIdle(ctx, agent)
      expect(toolTexts(adapter.requests.at(-1))).toContain('[dropped §1§]')

      // Turn 3: ctx_expand restores the original content from the cited event.
      send(agent, 'expand please')
      await waitForIdle(ctx, agent)
      // The restored original is the tagged one (tool-result tags are durable).
      expect(toolTexts(adapter.requests.at(-1))).toContain('§1§ echo:tool one')
      expect(toolTexts(adapter.requests.at(-1))).not.toContain('[dropped §1§]')
    } finally {
      try {
        await ctx.fiber.dispose()
      } catch {
        /* best effort */
      }
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })

  it('emergency reclaim drops beyond the protected window and advances the surface generation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-dsh-p1-e-'))
    const adapter = new WindowedAdapter([
      toolCallResponse('call-1', 'echo', { text: 'first output' }),
      toolCallResponse('call-2', 'echo', { text: 'second output' }),
      toolCallResponse('call-3', 'echo', { text: 'third output' }),
      textResponse('done'),
    ], 12)
    const ctx = await boot(adapter, dataDir)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('mc-p1-2'), { provider: 'mock', model: 'mock' })

    try {
      send(agent, 'generate three outputs')
      await waitForIdle(ctx, agent)
      const policy = { ...DEFAULT_POLICY, protectedToolResults: 1 }
      const reader = openStores(dataDir)
      const nodes = enumerateSurfaceToolResults(agent.session, callId =>
        reader.getTag(agent.session.id, { kind: 'tool-result', callId }))
      const tagged = nodes.filter(node => node.tagNumber !== undefined && !node.isPlaceholder)
      expect(tagged.length).toBe(3)

      const before = agent.session.surface.replaceGeneration
      const reclaim = reclaimForEmergency(agent.session, nodes, policy)
      reader.close()
      expect(reclaim.dropped.length).toBe(2)
      expect(reclaim.protectedCount).toBe(1)
      expect(agent.session.surface.replaceGeneration).toBeGreaterThan(before)
      const derivedTools = agent.session.deriveMessages().filter(m => m.role === 'tool') as AnyMessage[]
      const texts = derivedTools.map(message => textOf(message))
      // The protected newest node keeps its full content — tag prefix included.
      expect(texts).toEqual(['[dropped §1§]', '[dropped §2§]', '§3§ echo:third output'])
    } finally {
      try {
        await ctx.fiber.dispose()
      } catch {
        /* best effort */
      }
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })

  it('resolves the pressure denominator from the route, or the assumed window when it discloses none', () => {
    const policy = { ...DEFAULT_POLICY, assumedContextWindow: 256_000 }
    // The route's own reading always wins, however small or large.
    expect(pressureWindowTokens(1_048_576, policy)).toBe(1_048_576)
    expect(pressureWindowTokens(12, policy)).toBe(12)
    // Absent, placeholder-zero and non-finite readings share one fallback: a
    // denominator has to exist, or every pass defers 'no-window' forever.
    expect(pressureWindowTokens(undefined, policy)).toBe(256_000)
    expect(pressureWindowTokens(0, policy)).toBe(256_000)
    expect(pressureWindowTokens(Number.NaN, policy)).toBe(256_000)
    expect(DEFAULT_POLICY.assumedContextWindow).toBe(256_000)
  })

  it('opens the execute band for a route whose model discloses no context window', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-dsh-p1-a-'))
    // The base MockAdapter declares no model context at all, so the route's own
    // reading is absent and only the assumed window can carry the decision
    // (10 tokens of an assumed 12 = 83%, over the 50% band).
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'echo', { text: 'tool one' }),
      toolCallResponse('call-2', 'ctx_reduce', { drop: '1' }),
      textResponse('queued'),
      textResponse('done'),
    ])
    const ctx = await boot(adapter, dataDir, { ...TEST_POLICY, assumedContextWindow: 12 })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('mc-p1-3'), { provider: 'mock', model: 'mock' })

    try {
      send(agent, 'hello world')
      await waitForIdle(ctx, agent)

      // The route WAS logged, just without a window — so the pass below cannot
      // have used a disclosed one.
      const route = agent.session.requestContext()
      expect(route?.model).toBe('mock')
      expect(route?.contextWindow).toBeUndefined()

      // The queued mark landed on the very next pre-step. Under the old
      // 'no-window' defer this never happened: decidePass returned before the
      // threshold test, so the mark would still be queued and this request
      // would carry the full tool output.
      expect(toolTexts(adapter.requests[2])).toContain('[dropped §1§]')
      expect(toolTexts(adapter.requests[2])).not.toContain('echo:tool one')
      const reader = openStores(dataDir)
      try {
        expect(reader.listPendingDrops(agent.session.id)).toEqual([])
      } finally {
        reader.close()
      }
    } finally {
      try {
        await ctx.fiber.dispose()
      } catch {
        /* best effort */
      }
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* OS temp sweep covers residue */
      }
    }
  })

  it('parses Magic Context drop-range grammar', () => {
    expect(parseTagRanges('3-5, 1, 9')).toEqual([1, 3, 4, 5, 9])
    expect(parseTagRanges('')).toEqual([])
    expect(parseTagRanges('7')).toEqual([7])
    expect(parseTagRanges('10-12,7')).toEqual([7, 10, 11, 12])
    expect(parseTagRanges('x,y,4-')).toEqual([])
  })
})

