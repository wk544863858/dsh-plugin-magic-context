/**
 * The confirmation gate (WP6).
 *
 * The property that matters is negative and easy to lose: while a question is
 * open, the candidate must not be usable anywhere. This suite therefore tests
 * the gate and the decision path as a state machine, including the two ways a
 * gate like this usually leaks — a retried enqueue producing duplicates, and a
 * second decision resurrecting a rejected candidate.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import {
  decideConfirmation,
  formatConfirmationNotice,
  gateProfileCandidate,
  listPendingConfirmations,
} from '../src/core/profile-confirmation.ts'

const NOW = 1_700_000_000_000
const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-confirm-'))
  dirs.push(dir)
  const created = openStores(dir)
  opened.push(created)
  return created
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // never mask the assertion that failed
    }
  }
})

const DIRECTIVE = '未确认前必须先在 plan 模式内讨论，拿到确认后才能写文件。'
const DESCRIPTIVE = '用户全程使用简体中文沟通，倾向用一句短语驱动 agent 执行。'

describe('the confirmation gate', () => {
  it('queues a directive-shaped candidate instead of letting it through', () => {
    const s = store()
    const result = gateProfileCandidate(s, { contractCandidateId: 11, content: DIRECTIVE }, NOW)
    expect(result.shape).toBe('directive')
    expect(result.confirmation?.state).toBe('pending')
    expect(result.confirmation?.contractCandidateId).toBe(11)
    expect(result.confirmation?.question).toContain('所有会话')
    // The queue is the ONLY place it exists: nothing else in the adapter store
    // was written for it (the profile lives in the frozen contract, which this
    // step must not touch).
    expect(listPendingConfirmations(s)).toHaveLength(1)
  })

  it('lets a descriptive candidate through untouched', () => {
    const s = store()
    const result = gateProfileCandidate(s, { contractCandidateId: 12, content: DESCRIPTIVE }, NOW)
    expect(result.shape).toBe('descriptive')
    expect(result.confirmation).toBeUndefined()
    expect(listPendingConfirmations(s)).toEqual([])
  })

  it('is idempotent per pending candidate', () => {
    const s = store()
    const first = gateProfileCandidate(s, { contractCandidateId: 13, content: DIRECTIVE }, NOW)
    const second = gateProfileCandidate(s, { contractCandidateId: 13, content: DIRECTIVE }, NOW + 1)
    expect(second.confirmation?.id).toBe(first.confirmation?.id)
    expect(listPendingConfirmations(s)).toHaveLength(1)
  })

  it('distinguishes "not pending" from "rejected", and does not resurrect a decision', () => {
    const s = store()
    const queued = gateProfileCandidate(s, { contractCandidateId: 14, content: DIRECTIVE }, NOW).confirmation!
    const rejected = decideConfirmation(s, queued.id, 'rejected', NOW + 1)
    expect(rejected?.state).toBe('rejected')
    expect(listPendingConfirmations(s)).toEqual([])
    // Deciding again is a no-op, not a revival.
    expect(decideConfirmation(s, queued.id, 'approved', NOW + 2)).toBeUndefined()
    expect(s.listProfileConfirmations('approved')).toEqual([])
    // A NEW observation of the same contract candidate may ask again.
    const again = gateProfileCandidate(s, { contractCandidateId: 14, content: DIRECTIVE }, NOW + 3)
    expect(again.confirmation?.id).not.toBe(queued.id)
    expect(again.confirmation?.state).toBe('pending')
  })

  it('approval records the decision and time', () => {
    const s = store()
    const queued = gateProfileCandidate(s, { contractCandidateId: 15, content: DIRECTIVE }, NOW).confirmation!
    const approved = decideConfirmation(s, queued.id, 'approved', NOW + 5)
    expect(approved?.state).toBe('approved')
    expect(approved?.decidedAt).toBe(NOW + 5)
    expect(s.listProfileConfirmations('approved')).toHaveLength(1)
    expect(listPendingConfirmations(s)).toEqual([])
  })
})

describe('the notice', () => {
  it('says nothing when there is nothing to answer', () => {
    expect(formatConfirmationNotice([])).toBeUndefined()
  })

  it('carries the candidate, the count and the command', () => {
    const text = formatConfirmationNotice([
      { id: 7, contractCandidateId: 1, question: 'q', content: DIRECTIVE, state: 'pending', createdAt: NOW },
    ])!
    expect(text).toContain('1 条')
    expect(text).toContain('所有会话')
    expect(text).toContain('#7')
    expect(text).toContain('/ctx-profile')
    expect(text).toContain('confirm')
  })

  it('summarizes a backlog instead of pasting it all', () => {
    const rows = Array.from({ length: 5 }, (_unused, index) => ({
      id: index + 1,
      contractCandidateId: index + 1,
      question: 'q',
      content: DESCRIPTIVE,
      state: 'pending' as const,
      createdAt: NOW,
    }))
    const text = formatConfirmationNotice(rows)!
    expect(text).toContain('5 条')
    expect(text).toContain('还有 2 条')
  })
})
