/**
 * WP7 — the `user` domain's review pass.
 *
 * The rules under test are the ones that decide whether a standing rule about
 * the user gets published, so each has a failure direction that costs something:
 *
 *  - fail-closed parsing: a half-read verdict must promote nothing (acting on
 *    half a judgement publishes rules nobody approved);
 *  - union consumption: a candidate whose content is already in the profile must
 *    still be consumed, or the model's forgetfulness turns into an infinite
 *    re-judgement loop;
 *  - TTL independent of the review: with no LLM route at all the pool must still
 *    be bounded. Upstream runs its 30-day decay INSIDE the review task, so
 *    "review off" means "candidates accumulate forever" — that is the upstream
 *    defect this block pins.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROFILE_CANDIDATE_TTL_MS,
  PROFILE_MAX_CONTENT_CHARS,
  PROFILE_REVIEW_INTERVAL_MS,
  parseProfileReviewOutput,
  planProfileReview,
  runProfileReview,
} from '../src/core/profile-review.ts'
import { openProfileWriter, type ProfileCandidateRow, type ProfileWriter } from '../src/core/profile-write.ts'
import type { Journal, JournalKind, JournalLevel } from '../src/core/journal.ts'
import { answerLlm } from './helpers/llm-fake'
import { makeMemoryDb } from './helpers/memory-db'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const silentLogger = { info: () => {}, warn: () => {} }
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

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

function makeDb(): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-wp7-',
    schemaVersion: 94,
    mutationLog: true,
    projectState: true,
    profile: true,
  })
  tempDirs.push(dir)
  return path
}

/** Insert a candidate with an explicit age (the writer always stamps `now`). */
function seedCandidate(path: string, content: string, createdAt: number, sessionId = 'sess-a'): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare(
      `INSERT INTO user_memory_candidates(content, session_id, source_compartment_start,
        source_compartment_end, created_at) VALUES(?, ?, 1, 2, ?)`,
    ).run(content, sessionId, createdAt)
  } finally {
    db.close()
  }
}

function candidate(id: number, content: string, createdAt = T0, sessionId = 'sess-a'): ProfileCandidateRow {
  return { id, content, sessionId, compartmentStart: 1, compartmentEnd: 2, createdAt }
}

function profiles(path: string): Array<{ content: string; source_candidate_ids: string | null }> {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT content, source_candidate_ids FROM user_memories ORDER BY id')
      .all() as unknown as Array<{ content: string; source_candidate_ids: string | null }>
  } finally {
    db.close()
  }
}

function candidateContents(path: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('SELECT content FROM user_memory_candidates ORDER BY id').all() as Array<{ content: string }>)
      .map(row => row.content)
  } finally {
    db.close()
  }
}

function withWriter<T>(path: string, fn: (writer: ProfileWriter) => Promise<T> | T): Promise<T> | T {
  const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
  const done = (result: T): T => {
    writer.close()
    return result
  }
  try {
    const result = fn(writer)
    return result instanceof Promise ? result.then(done, (error: unknown) => { writer.close(); throw error }) : done(result)
  } catch (error) {
    writer.close()
    throw error
  }
}

describe('parseProfileReviewOutput', () => {
  it('reads a well-formed verdict', () => {
    const verdict = parseProfileReviewOutput(JSON.stringify({
      promote: [{ content: 'answers in Chinese', consume_candidate_ids: [1, 2] }],
      reject: [3],
    }))
    expect(verdict).toEqual({
      promote: [{ content: 'answers in Chinese', consumeCandidateIds: [1, 2] }],
      reject: [3],
    })
  })

  it('accepts prose around the object', () => {
    const verdict = parseProfileReviewOutput('Here you go:\n{"promote":[],"reject":[7]}\nHope that helps.')
    expect(verdict?.reject).toEqual([7])
  })

  it('fails closed on truncated JSON', () => {
    expect(parseProfileReviewOutput('{"promote":[{"content":"answers in Chin')).toBeUndefined()
  })

  it('fails closed on invalid JSON', () => {
    expect(parseProfileReviewOutput('{"promote":[{"content":"a" "consume_candidate_ids":[]}]}')).toBeUndefined()
  })

  it('fails closed when there is no object at all', () => {
    expect(parseProfileReviewOutput('I could not decide.')).toBeUndefined()
    expect(parseProfileReviewOutput('')).toBeUndefined()
  })

  it('fails closed on a malformed container, not just malformed JSON', () => {
    // A partially-read verdict is a partially-applied judgement.
    expect(parseProfileReviewOutput('{"promote":{"content":"x"}}')).toBeUndefined()
    expect(parseProfileReviewOutput('{"reject":"3"}')).toBeUndefined()
  })

  it('drops entries with no usable content but keeps the rest', () => {
    const verdict = parseProfileReviewOutput(JSON.stringify({
      promote: [{ content: '   ' }, { consume_candidate_ids: [1] }, { content: 'kept this one' }],
    }))
    expect(verdict?.promote).toEqual([{ content: 'kept this one', consumeCandidateIds: [] }])
  })

  it('keeps only integer ids', () => {
    const verdict = parseProfileReviewOutput(JSON.stringify({ promote: [], reject: [1, '2', null, 3.5, 4] }))
    expect(verdict?.reject).toEqual([1, 4])
  })

  it('bounds an over-long promotion', () => {
    const verdict = parseProfileReviewOutput(JSON.stringify({ promote: [{ content: 'x'.repeat(PROFILE_MAX_CONTENT_CHARS + 200) }] }))
    expect(verdict?.promote[0]!.content.length).toBe(PROFILE_MAX_CONTENT_CHARS)
  })

  it('treats absent arrays as empty rather than failing', () => {
    expect(parseProfileReviewOutput('{}')).toEqual({ promote: [], reject: [] })
  })
})

describe('planProfileReview — the union consumption rule', () => {
  const three = [candidate(1, 'answer in Chinese'), candidate(2, 'always answer in Chinese'), candidate(3, 'reply in Chinese')]

  it('merges three near-duplicates into one promotion and consumes all three', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: { promote: [{ content: 'answers in Chinese', consumeCandidateIds: [1, 2, 3] }], reject: [] },
    })
    expect(plan.promotions).toHaveLength(1)
    expect(plan.promotions[0]!.content).toBe('answers in Chinese')
    expect(plan.consumed).toEqual([1, 2, 3])
  })

  it('consumes by content match when the model forgets the ids', () => {
    // Rule 3: no `consume_candidate_ids` at all, yet the promoted text IS
    // candidate 1 — it must be consumed or it is judged again next tick.
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: { promote: [{ content: 'answer in Chinese', consumeCandidateIds: [] }], reject: [] },
    })
    expect(plan.promotions).toHaveLength(1)
    expect(plan.consumed).toEqual([1])
  })

  it('consumes a candidate whose content is already in the profile, without re-promoting it', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: ['Answer In Chinese'],
      verdict: { promote: [{ content: 'answer in Chinese', consumeCandidateIds: [] }], reject: [] },
    })
    // The promotion is skipped as a duplicate (case/space-insensitive) ...
    expect(plan.promotions).toHaveLength(0)
    // ... but the candidate is still consumed: otherwise this pair repeats forever.
    expect(plan.consumed).toEqual([1])
  })

  it('never consumes an id that was not sent', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: { promote: [], reject: [1, 99] },
    })
    expect(plan.consumed).toEqual([1])
  })

  it('consumes named ids even when the promoted text matches nothing', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: { promote: [{ content: 'a synthesis of all three', consumeCandidateIds: [1, 2, 3] }], reject: [] },
    })
    expect(plan.promotions).toHaveLength(1)
    expect(plan.consumed).toEqual([1, 2, 3])
  })

  it('unions rejections with promotions and sorts the result', () => {
    const plan = planProfileReview({
      candidates: [candidate(1, 'a'), candidate(2, 'b'), candidate(3, 'c'), candidate(4, 'd')],
      existing: [],
      verdict: { promote: [{ content: 'a', consumeCandidateIds: [] }], reject: [4, 3] },
    })
    expect(plan.consumed).toEqual([1, 3, 4])
  })

  it('inserts the same promotion once when the model repeats it', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: {
        promote: [
          { content: 'answers in Chinese', consumeCandidateIds: [1] },
          { content: 'ANSWERS IN CHINESE', consumeCandidateIds: [2] },
        ],
        reject: [],
      },
    })
    expect(plan.promotions).toHaveLength(1)
    expect(plan.consumed).toEqual([1, 2])
  })

  it('ignores empty promotions', () => {
    const plan = planProfileReview({
      candidates: three,
      existing: [],
      verdict: { promote: [{ content: '   ', consumeCandidateIds: [] }], reject: [] },
    })
    expect(plan.promotions).toEqual([])
    expect(plan.consumed).toEqual([])
  })
})

describe('runProfileReview', () => {
  it('promotes three similar candidates into one profile row and consumes them', async () => {
    const path = makeDb()
    seedCandidate(path, 'answer in Chinese', T0)
    seedCandidate(path, 'always answer in Chinese', T0)
    seedCandidate(path, 'reply in Chinese', T0)
    const calls: Call[] = []
    const fake = answerLlm(JSON.stringify({
      promote: [{ content: 'The user works in Chinese; always answer in Chinese.', consume_candidate_ids: [1, 2, 3] }],
      reject: [],
    }))

    await withWriter(path, writer => runProfileReview({
      writer,
      llm: fake.llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal(calls),
      now: () => T0,
    }))

    const rows = profiles(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain('always answer in Chinese')
    expect(JSON.parse(rows[0]!.source_candidate_ids ?? '[]')).toEqual([1, 2, 3])
    // Consumption is the proof the pool does not re-judge them.
    expect(candidateContents(path)).toEqual([])
    const summary = calls.find(call => call.summary.includes('profile review'))
    expect(summary?.data?.promoted).toBe(1)
    expect(summary?.data?.consumed).toBe(3)
  })

  it('does not run below the threshold', async () => {
    const path = makeDb()
    seedCandidate(path, 'one', T0)
    seedCandidate(path, 'two', T0)
    const calls: Call[] = []
    const fake = answerLlm('{"promote":[],"reject":[]}')
    const outcome = await withWriter(path, writer => runProfileReview({
      writer,
      llm: fake.llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal(calls),
      now: () => T0,
    }))
    expect(outcome.ran).toBe(false)
    expect(outcome.reason).toBe('too-few')
    expect(profiles(path)).toEqual([])
    expect(candidateContents(path)).toHaveLength(2)
    // The model was never called: a threshold that still costs a call is not a threshold.
    expect(fake.calls).toHaveLength(0)
  })

  it('throttles a second review inside the interval', async () => {
    const path = makeDb()
    for (const text of ['a', 'b', 'c']) seedCandidate(path, text, T0)
    const fake = answerLlm('{"promote":[],"reject":[1,2,3]}')
    const outcome = await withWriter(path, writer => runProfileReview({
      writer,
      llm: fake.llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal([]),
      now: () => T0,
      lastReviewAt: T0 - PROFILE_REVIEW_INTERVAL_MS + 60_000,
    }))
    expect(outcome.reason).toBe('throttled')
    expect(fake.calls).toHaveLength(0)
  })

  it('expires the candidate TTL even with no LLM route (upstream regression)', async () => {
    const path = makeDb()
    seedCandidate(path, 'ancient observation', T0 - PROFILE_CANDIDATE_TTL_MS - DAY)
    seedCandidate(path, 'recent observation', T0)
    const calls: Call[] = []
    const outcome = await withWriter(path, writer => runProfileReview({
      writer,
      sessionId: 'mc-maintenance',
      journal: recordingJournal(calls),
      now: () => T0,
    }))
    expect(outcome.reason).toBe('llm-off')
    expect(outcome.expired).toBe(1)
    // The whole point: "review off" must not mean "pool grows forever".
    expect(candidateContents(path)).toEqual(['recent observation'])
    const row = calls.find(call => call.summary.includes('profile review skipped'))
    expect(row?.data?.expired).toBe(1)
  })

  it('leaves the pool untouched when the call fails', async () => {
    const path = makeDb()
    for (const text of ['a', 'b', 'c']) seedCandidate(path, text, T0)
    const calls: Call[] = []
    const failing = { stream: () => { throw new Error('provider down') } }
    const outcome = await withWriter(path, writer => runProfileReview({
      writer,
      llm: failing as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal(calls),
      now: () => T0,
    }))
    expect(outcome.reason).toBe('llm-failed')
    expect(outcome.ran).toBe(false)
    expect(candidateContents(path)).toHaveLength(3)
    expect(profiles(path)).toEqual([])
    expect(calls.some(call => call.level === 'warn')).toBe(true)
  })

  it('promotes and consumes nothing when the verdict is unparsable', async () => {
    const path = makeDb()
    for (const text of ['a', 'b', 'c']) seedCandidate(path, text, T0)
    const calls: Call[] = []
    const fake = answerLlm('{"promote":[{"content":"cut off here')
    const outcome = await withWriter(path, writer => runProfileReview({
      writer,
      llm: fake.llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal(calls),
      now: () => T0,
    }))
    expect(outcome.reason).toBe('invalid-output')
    expect(outcome.promoted).toBe(0)
    expect(outcome.consumed).toBe(0)
    expect(profiles(path)).toEqual([])
    expect(candidateContents(path)).toHaveLength(3)
    // The diagnostic keeps the tail, the same way the historian does.
    const warned = calls.find(call => call.level === 'warn' && call.summary.includes('rejected'))
    expect(typeof warned?.data?.outputTail).toBe('string')
  })

  it('reports a closed pool when the writer is unavailable', async () => {
    const outcome = await runProfileReview({
      writer: undefined,
      sessionId: 'mc-maintenance',
      journal: recordingJournal([]),
      now: () => T0,
    })
    expect(outcome.reason).toBe('writer-unavailable')
    expect(outcome.ran).toBe(false)
  })

  it('is idempotent across ticks once the content is in the profile', async () => {
    // The loop this prevents: promote -> (model forgets the ids) -> judge the
    // same candidates again -> promote a duplicate row.
    const path = makeDb()
    for (const text of ['answer in Chinese', 'always answer in Chinese', 'reply in Chinese']) {
      seedCandidate(path, text, T0)
    }
    const verdict = JSON.stringify({ promote: [{ content: 'answer in Chinese', consume_candidate_ids: [] }], reject: [] })
    const first = await withWriter(path, writer => runProfileReview({
      writer,
      llm: answerLlm(verdict).llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal([]),
      now: () => T0,
    }))
    expect(first.promoted).toBe(1)
    expect(candidateContents(path)).toHaveLength(2)

    const second = await withWriter(path, writer => runProfileReview({
      writer,
      llm: answerLlm(verdict).llm as never,
      route: { provider: 'mock', model: 'mock' },
      sessionId: 'mc-maintenance',
      journal: recordingJournal([]),
      now: () => T0 + DAY,
    }))
    expect(second.promoted).toBe(0)
    expect(profiles(path)).toHaveLength(1)
  })
})
