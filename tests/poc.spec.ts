/**
 * Magic Context — DSH adapter Phase 0 PoC integration test.
 *
 * Drives the real agent loop (mock adapter) through a tool-call turn with
 * the magic-context adapter plugin loaded, and verifies the four Phase-0
 * claims from docs/dsh-port-feasibility-2026-10-06.md:
 *
 *  1. §N§ tags land on user messages at admission (durable, zero extra bust);
 *  2. §N§ tags land on tool results at landing (tools/post-execute);
 *  3. usage is recorded from durable assistant/message events into
 *     the adapter's node:sqlite store;
 *  4. a durable drop (surface replace citing the original event) changes
 *     the derived request wire while the original stays recoverable.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import mcDshPlugin, {
  openStores,
  replaceToolResultWithPlaceholder,
} from '<path>'

type AnyMessage = { role: string; content: Array<{ type: string; text?: string }> }

function textOf(message: AnyMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

async function boot(adapter: MockAdapter, dataDir: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(mcDshPlugin, { dataDir })
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

describe('magic-context dsh adapter (phase 0 PoC)', () => {
  it('tags admission-time user messages and landing-time tool results durably, records usage, and drops via surface replace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-dsh-poc-'))
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'echo', { text: 'hello tool' }),
      textResponse('final answer'),
      textResponse('after drop'),
    ])
    const ctx = await boot(adapter, dataDir)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo fixture',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo:${args.text}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('mc-poc-1'), { provider: 'mock', model: 'mock' })
    const sessionId = agent.session.id

    try {
      send(agent, 'hello world')
      await waitForIdle(ctx, agent)

      // 1. Tags rode the natural derivations: no extra requests were issued.
      expect(adapter.requests.length).toBe(2)
      const firstUser = adapter.requests[0]?.messages.find(m => m.role === 'user') as AnyMessage
      expect(textOf(firstUser)).toBe('§1§ hello world')
      const toolMessage = adapter.requests[1]?.messages.find(m => m.role === 'tool') as AnyMessage
      expect(textOf(toolMessage)).toBe('§2§ echo:hello tool')

      // 2. The tags are durable surface content, not wire-only rewrites.
      const events = agent.session.snapshotEvents()
      const userEvent = events.find(event => event.type === 'user/message')
      expect(userEvent?.type === 'user/message' ? textOf({ role: 'user', content: [...userEvent.data.content] }) : '').toBe('§1§ hello world')
      const toolResultEvent = events.find(event => event.type === 'tool/result')
      expect(toolResultEvent?.type === 'tool/result' ? textOf({ role: 'tool', content: [...toolResultEvent.data.message.content] }) : '').toBe('§2§ echo:hello tool')

      // 3. Usage rows anchored to durable assistant/message seqs.
      const reader = openStores(dataDir)
      try {
        const usage = reader.listUsage(sessionId)
        expect(usage.length).toBe(2)
        expect(usage.map(row => row.inputTokens)).toEqual([10, 10])
        expect(usage.every(row => row.provider === 'mock' && row.model === 'mock')).toBe(true)
        const tags = reader.listTags(sessionId)
        expect(tags.map(tag => tag.tagNumber)).toEqual([1, 2])
        expect(tags[0]?.target).toEqual({ kind: 'user-message', messageId: expect.any(String) })
        expect(tags[1]?.target).toEqual({ kind: 'tool-result', callId: expect.stringContaining('call-1') as string })
      } finally {
        reader.close()
      }

      // 4. Durable drop: replace the tagged tool result with a placeholder.
      expect(toolResultEvent !== undefined).toBe(true)
      if (toolResultEvent?.type !== 'tool/result') return
      const replacementSeq = replaceToolResultWithPlaceholder(agent.session, toolResultEvent.seq, '[dropped §2§]')
      const derivedTool = agent.session.deriveMessages().find(m => m.role === 'tool') as AnyMessage
      expect(textOf(derivedTool)).toBe('[dropped §2§]')
      const replacement = agent.session.snapshotEvents().find(event => event.seq === replacementSeq)
      expect(replacement?.surfaceOp).toEqual({ op: 'replace', startSeq: toolResultEvent.seq, endSeq: toolResultEvent.seq })
      expect(replacement?.sourceEventSeqs).toEqual([toolResultEvent.seq])
      // The original full-fidelity result survives in the log (ctx_expand semantics).
      expect(agent.session.snapshotEvents().some(event => event.seq === toolResultEvent.seq)).toBe(true)

      // 5. The next derived request carries the placeholder, not the original.
      send(agent, 'after drop')
      await waitForIdle(ctx, agent)
      const lastRequest = adapter.requests.at(-1)
      const lastTool = lastRequest?.messages.find(m => m.role === 'tool') as AnyMessage
      expect(textOf(lastTool)).toBe('[dropped §2§]')
    } finally {
      // Dispose the Cordis tree so the plugin's SQLite connection closes
      // before the temp directory is removed (Windows file locks).
      try {
        await ctx.fiber.dispose()
      } catch {
        // Best effort only; the OS temp sweep handles any residue.
      }
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // The adapter may still hold WAL handles; the OS temp sweep covers it.
      }
    }
  })
})

