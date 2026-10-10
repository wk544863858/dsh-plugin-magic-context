/**
 * Auto-search hint: the pure rendering, the per-turn claim, and the append path —
 * the only side effect — against a stub session.
 */
import { describe, expect, it } from 'vitest'
import type { Journal } from '../src/core/journal.ts'
import type { MemorySearchHit } from '../src/core/memory-search.ts'
import {
  buildSearchHint,
  HINT_MAX_CHARS,
  planSearchHint,
  SearchHintTracker,
} from '../src/dsh/search-hint.ts'

const hit = (id: number, category: string, preview: string, score = 0.9): MemorySearchHit =>
  ({ id, category, score, matchType: 'fts', preview })

/** Records what the adapter appends, so the claim can be checked without a session. */
function stubSession(): { appended: Array<{ type: string; text: string }>; session: { append: unknown } } {
  const appended: Array<{ type: string; text: string }> = []
  return {
    appended,
    session: {
      append: (type: string, data: { content: Array<{ text: string }> }) => {
        appended.push({ type, text: data.content[0]?.text ?? '' })
        return appended.length
      },
    },
  }
}

function capturedJournal(kinds: string[]): Journal {
  return {
    info: (kind: string) => kinds.push(kind),
    warn: (kind: string) => kinds.push(kind),
    error: (kind: string) => kinds.push(kind),
  } as unknown as Journal
}

const PROMPT = 'why did the tenant boundary start trusting the org slug header again'

describe('buildSearchHint', () => {
  it('returns null without hits', () => {
    expect(buildSearchHint([])).toBeNull()
  })

  it('renders the frozen wrapper with one line per fragment', () => {
    const hint = buildSearchHint([hit(1, 'PROJECT_RULES', 'tenant checks fail closed'), hit(2, 'ARCHITECTURE', 'session claims')])
    expect(hint).toContain('<ctx-search-hint>')
    expect(hint).toContain('Your memory may contain 2 related fragments:')
    expect(hint).toContain('- [PROJECT_RULES] tenant checks fail closed')
    expect(hint).toContain('run ctx_memory')
    expect(hint?.endsWith('</ctx-search-hint>')).toBe(true)
  })

  it('bounds the fragment count, each fragment, and the whole block', () => {
    const many = Array.from({ length: 6 }, (_unused, index) => hit(index + 1, 'CONSTRAINTS', 'x'.repeat(300)))
    const hint = buildSearchHint(many) ?? ''
    expect(hint.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3)
    for (const line of hint.split('\n').filter(entry => entry.startsWith('- '))) {
      expect(line.length).toBeLessThanOrEqual(90)
      expect(line).toContain('…')
    }
    expect(hint.length).toBeLessThanOrEqual(HINT_MAX_CHARS)
  })
})

describe('SearchHintTracker', () => {
  it('claims one hint per turn and per session', () => {
    const tracker = new SearchHintTracker()
    expect(tracker.claim('s1', 'turn-1')).toBe(true)
    expect(tracker.claim('s1', 'turn-1')).toBe(false)
    expect(tracker.claim('s1', 'turn-2')).toBe(true)
    expect(tracker.claim('s2', 'turn-1')).toBe(true)
    tracker.forget('s1')
    expect(tracker.claim('s1', 'turn-1')).toBe(true)
  })
})

describe('planSearchHint', () => {
  const run = async (
    options: {
      text?: string
      hits?: readonly MemorySearchHit[]
      search?: unknown
      tracker?: SearchHintTracker
      timeoutMs?: number
      kinds?: string[]
    } = {},
  ) => {
    const stub = stubSession()
    const kinds = options.kinds ?? []
    // `search: undefined` means "the lane is off", so presence must be explicit:
    // `??` would silently substitute the working search and hide that case.
    const search = 'search' in options ? options.search : (async () => options.hits ?? [])
    const outcome = await planSearchHint(
      {
        search: search as never,
        journal: capturedJournal(kinds),
        tracker: options.tracker ?? new SearchHintTracker(),
        ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      },
      {
        sessionId: 's1',
        session: stub.session,
        text: options.text ?? PROMPT,
        turnKey: 'turn-1',
      },
    )
    return { outcome, stub, kinds }
  }

  it('returns the hint as an admitted-batch message, never touching the session', async () => {
    const { outcome, stub, kinds } = await run({ hits: [hit(1, 'PROJECT_RULES', 'fail closed on tenant')] })
    expect(outcome.action).toBe('hinted')
    // The carrier is the returned message, not a session append — the stub has
    // no append consumer here, and it must stay empty.
    expect(stub.appended).toHaveLength(0)
    const message = outcome.action === 'hinted' ? outcome.message : undefined
    expect(message?.role).toBe('user')
    expect(message?.id).toEqual(expect.any(String))
    expect(message?.source).toMatchObject({ kind: 'magic-context', form: 'notice' })
    expect((message?.content as Array<{ text: string }>)[0]?.text).toContain('<ctx-search-hint>')
    expect(kinds).toContain('search-hint')
  })

  it('hints once per turn even though preStep runs per model step', async () => {
    const tracker = new SearchHintTracker()
    const first = await run({ hits: [hit(1, 'CONSTRAINTS', 'once')], tracker })
    const second = await run({ hits: [hit(1, 'CONSTRAINTS', 'once')], tracker })
    expect(first.outcome.action).toBe('hinted')
    expect(second.outcome).toMatchObject({ action: 'quiet', reason: 'already-hinted' })
    expect(second.stub.appended).toHaveLength(0)
  })

  it('stays quiet for short input, command input, and an empty result set', async () => {
    expect((await run({ text: 'hi' })).outcome).toMatchObject({ action: 'quiet', reason: 'too-short' })
    expect((await run({ text: '/ctx-status now please' })).outcome).toMatchObject({ action: 'quiet', reason: 'not-a-prompt' })
    expect((await run({ hits: [] })).outcome).toMatchObject({ action: 'quiet', reason: 'no-hits' })
    expect((await run({ search: undefined })).outcome).toMatchObject({ action: 'quiet', reason: 'lane-off' })
  })

  it('never lets a slow or failing search reach the turn', async () => {
    const hanging = new Promise<readonly MemorySearchHit[]>(() => {})
    expect((await run({ search: () => hanging, timeoutMs: 20 })).outcome).toMatchObject({ action: 'failed', reason: 'timeout' })
    const boom = async (): Promise<readonly MemorySearchHit[]> => { throw new Error('fts exploded') }
    expect((await run({ search: boom })).outcome).toMatchObject({ action: 'failed', reason: 'search-failed' })
  })
})
