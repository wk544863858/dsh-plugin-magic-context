/**
 * The hint carrier, end to end: `preStepListener` must deliver the hint inside
 * the admitted batch (`decision.messages`), never via a direct session append.
 *
 * The direct append from inside the `agent/pre-step` waterfall was the 2026-10-09
 * protected-head corruption: on a fresh session's first step the waterfall runs
 * before the host writes step/start + the first system/message, so the appended
 * hint became surface node 0 and the loader rejected the log on every replay.
 * The host persists `decision.messages` AFTER its own system-prompt commits
 * (agent-loop `step()`), so a batch-carried hint can never precede the head.
 */
import { describe, expect, it } from 'vitest'
import type { MemorySearchHit } from '../src/core/memory-search.ts'
import { ReduceNudgeTracker } from '../src/dsh/reduce-guidance.ts'
import { SearchHintTracker } from '../src/dsh/search-hint.ts'
import { preStepListener, type PreStepDeps } from '../src/dsh/pre-step.ts'

const noop = () => undefined

function journalStub() {
  const calls: Array<{ level: string; kind: string; summary: string }> = []
  return {
    calls,
    info: (kind: string, summary: string) => { calls.push({ level: 'info', kind, summary }) },
    warn: noop,
    error: noop,
  }
}

const hit = (id: number, category: string, preview: string): MemorySearchHit =>
  ({ id, category, score: 0.9, matchType: 'fts', preview })

const PROMPT = 'why did the tenant boundary start trusting the org slug header again'

function carrierDeps(journal: ReturnType<typeof journalStub>): PreStepDeps {
  return {
    ctx: { logger: { info: noop, warn: noop, error: noop } },
    config: {},
    stores: {} as PreStepDeps['stores'],
    journal: journal as unknown as PreStepDeps['journal'],
    llm: undefined,
    reduceTracker: new ReduceNudgeTracker(),
    lane: {
      visibleMemoryIdsBySession: new Map(),
      searchForSession: async () => [hit(1, 'PROJECT_RULES', 'tenant checks fail closed')],
    },
    projects: { seenIdentities: new Set(), sessionIdentity: new Map() },
    seenSessions: new Set(),
    activePolicy: () => ({}),
    searchHints: new SearchHintTracker(),
  } as unknown as PreStepDeps
}

describe('hint carrier inside the admitted batch', () => {
  it('appends the hint message to decision.messages and never touches the session', async () => {
    const journal = journalStub()
    const listener = preStepListener(carrierDeps(journal))
    const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: PROMPT }] }
    // The stub session deliberately has NO `append`: a direct-append carrier
    // would throw into the fail-open band and the appendix would go missing,
    // failing this assertion.
    const payload = {
      messages: [userMessage],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      agent: { session: { id: 'ses-carrier', header: { cwd: 'D:/work/repo' } } },
    }
    const outcome = await listener(payload as never, async () => ({ kind: 'enter', messages: [userMessage] }))
    expect(outcome.kind).toBe('enter')
    if (outcome.kind !== 'enter') return
    // The batch gains exactly one appendix, AFTER the real user message.
    expect(outcome.messages).toHaveLength(2)
    const appendix = outcome.messages[1]
    expect(appendix?.role).toBe('user')
    expect(appendix?.id).not.toBe(userMessage.id)
    expect(appendix?.source).toMatchObject({ kind: 'magic-context', form: 'notice' })
    expect((appendix?.content as Array<{ type: string; text: string }>)[0]?.text).toContain('<ctx-search-hint>')
    // The hint decision is journaled through the standard channel.
    expect(journal.calls.some((call) => call.kind === 'search-hint' && call.summary.includes('hinted'))).toBe(true)
  })

  it('adds no appendix when the turn was already hinted (per-turn claim)', async () => {
    const journal = journalStub()
    const deps = carrierDeps(journal)
    const listener = preStepListener(deps)
    const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: PROMPT }] }
    const payload = {
      messages: [userMessage],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      agent: { session: { id: 'ses-carrier', header: { cwd: 'D:/work/repo' } } },
    }
    const next = async () => ({ kind: 'enter', messages: [userMessage] }) as const
    const first = await listener(payload as never, next)
    const second = await listener(payload as never, next)
    expect(first.kind === 'enter' && first.messages).toHaveLength(2)
    expect(second.kind === 'enter' && second.messages).toHaveLength(1)
  })
})
