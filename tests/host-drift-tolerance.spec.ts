/**
 * Host payload-shape drift tolerance — the payload reads that sit OUTSIDE the
 * fail-open bands must degrade instead of throwing into the host's waterfall
 * or event emission (drift audit 2026-10-09, fragility item 3):
 *  - `readUsageFields` runs in the `session/event` listener (emitted on every
 *    append, the user's own messages included);
 *  - the pre-step identity read runs before every band.
 */
import { describe, expect, it } from 'vitest'
import { ReduceNudgeTracker } from '../src/dsh/reduce-guidance.ts'
import { preStepListener, type PreStepDeps } from '../src/dsh/pre-step.ts'
import { readUsageFields } from '../src/dsh/seams.ts'

const noop = () => undefined

/** Records only `error` rows — the drift warning is the signal under test. */
function journalStub() {
  const calls: Array<{ level: string; summary: string }> = []
  return {
    calls,
    info: noop,
    warn: noop,
    error: (level: string, summary: string) => {
      calls.push({ level, summary })
    },
  }
}

const minimalDeps = (journal: ReturnType<typeof journalStub>): PreStepDeps => ({
  ctx: { logger: { info: noop, warn: noop, error: noop } },
  config: {},
  stores: {} as PreStepDeps['stores'],
  journal: journal as unknown as PreStepDeps['journal'],
  llm: undefined,
  reduceTracker: new ReduceNudgeTracker(),
  lane: { visibleMemoryIdsBySession: new Map() } as unknown as PreStepDeps['lane'],
  projects: { seenIdentities: new Set(), sessionIdentity: new Map() },
  seenSessions: new Set(),
  activePolicy: () => ({}),
} as unknown as PreStepDeps)

const enterDecision = { kind: 'enter', messages: [] } as const
const next = async () => enterDecision
const signal = new AbortController().signal
const driftedPayload = { messages: [], turn: 1, step: 1, signal }

describe('readUsageFields shape tolerance', () => {
  it('returns undefined — not a throw — when the assistant event shape drifted', () => {
    expect(readUsageFields({ type: 'assistant/message' } as never)).toBeUndefined()
    expect(readUsageFields({ type: 'assistant/message', data: {} } as never)).toBeUndefined()
    expect(readUsageFields({ type: 'assistant/message', data: { message: {} } } as never)).toBeUndefined()
    expect(readUsageFields({ type: 'user/message' } as never)).toBeUndefined()
  })

  it('still reads the well-formed shape', () => {
    const fields = readUsageFields({
      type: 'assistant/message',
      seq: 7,
      data: {
        turn: 2,
        step: 1,
        message: { source: { provider: 'p', model: 'm' } },
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 },
      },
    } as never)
    expect(fields).toMatchObject({
      seq: 7,
      turn: 2,
      step: 1,
      provider: 'p',
      model: 'm',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 4,
    })
  })
})

describe('preStepListener payload tolerance', () => {
  it('skips the step (fail-open) and warns ONCE when the payload has no agent', async () => {
    const journal = journalStub()
    const listener = preStepListener(minimalDeps(journal))
    const first = await listener(driftedPayload as never, next)
    const second = await listener(driftedPayload as never, next)
    // The host's own decision passes through untouched, and the drift is
    // journaled exactly once (per mount), not once per model step.
    expect(first).toBe(enterDecision)
    expect(second).toBe(enterDecision)
    expect(journal.calls).toHaveLength(1)
    expect(journal.calls[0]?.summary).toContain('agent.session.id')
  })

  it('does not emit the drift warning when the payload is well-formed', async () => {
    const journal = journalStub()
    const listener = preStepListener(minimalDeps(journal))
    const payload = { ...driftedPayload, agent: { session: { id: 'ses-drift-check' } } }
    const outcome = await listener(payload as never, next)
    // The bands run their course on stub stores (their own bands catch that);
    // what matters here is: no throw escaped and no drift warning fired.
    expect(outcome).toEqual({ kind: 'enter', messages: [] })
    expect(journal.calls.filter((call) => call.summary.includes('agent.session.id'))).toHaveLength(0)
  })
})
