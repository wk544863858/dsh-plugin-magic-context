/**
 * L1① second leg — `ctx_memory action=review_global`: one user-questions card
 * per pending global-domain candidate; only a user-approved candidate is
 * published, and every decision (with the answer verbatim) is journalled.
 * Fail-closed: no asker, gate refusal, publisher absent, unparseable answer —
 * all leave the candidate pending.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/index.ts'
import { reviewGlobalCandidates, type GlobalReviewAsker, type GlobalReviewQuestion } from '../src/dsh/global-review.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import type { DomainWritePort } from '../src/core/global-domains.ts'
import type { Journal } from '../src/core/journal.ts'

const NOW = 1_760_000_000_000
const dirs: string[] = []
const open: AdapterStores[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function storeWithDomains(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-review-'))
  dirs.push(dir)
  const s = openStores(dir)
  open.push(s)
  s.upsertDomain(
    {
      domainId: 'dir:global:machine',
      kind: 'machine',
      enabled: true,
      budgetTokens: 512,
      cap: defaultDomainCap('machine'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  s.upsertDomain(
    {
      domainId: 'dir:global:org',
      kind: 'org',
      enabled: true,
      budgetTokens: 512,
      cap: defaultDomainCap('org'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  return s
}

let stageSeq = 0

function stage(
  store: AdapterStores,
  overrides: {
    readonly domainId?: string
    readonly category?: string
    readonly sourceMemoryId?: number
    readonly content?: string
  } = {},
): number {
  stageSeq += 1
  const row = store.upsertGlobalCandidate(
    {
      domainId: overrides.domainId ?? 'dir:global:machine',
      content: overrides.content ?? '共享事实：测试构建走 npm run gate',
      normalizedHash: `hash-${String(stageSeq)}`,
      firstIdentity: 'git:abc12345xyz',
      ...(overrides.category === undefined ? {} : { category: overrides.category }),
      ...(overrides.sourceMemoryId === undefined ? {} : { sourceMemoryId: overrides.sourceMemoryId }),
    },
    NOW,
  )
  return row.id
}

function fakeAsker(
  answerFor: (id: string) => unknown,
  calls: GlobalReviewQuestion[][] = [],
): GlobalReviewAsker {
  return async input => {
    calls.push([...input.questions])
    const question = input.questions[0]
    if (question === undefined) throw new Error('no question raised')
    return answerFor(question.id)
  }
}

function fakePublisher(): { readonly port: DomainWritePort; readonly calls: Array<{ identity: string; content: string }> } {
  const calls: Array<{ identity: string; content: string }> = []
  return {
    calls,
    port: {
      publishDomainMemory: input => {
        calls.push({ identity: input.identity, content: input.content })
        return { ok: true, id: 100 + calls.length, created: true }
      },
    },
  }
}

function fakeJournal(): { readonly journal: Journal; readonly rows: Array<{ kind: string; payload: Record<string, unknown> }> } {
  const rows: Array<{ kind: string; payload: Record<string, unknown> }> = []
  return {
    rows,
    journal: {
      info: (kind: string, _message: string, payload: Record<string, unknown>) => {
        rows.push({ kind, payload })
      },
      warn: () => undefined,
      error: () => undefined,
    } as unknown as Journal,
  }
}

describe('reviewGlobalCandidates', () => {
  it('publishes only what the user approves, under the domain identity, and journals the answer', async () => {
    const store = storeWithDomains()
    const id = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 7 })
    const { port, calls } = fakePublisher()
    const { journal, rows } = fakeJournal()
    const raisedCards: GlobalReviewQuestion[][] = []
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => (askId === `global-candidate-${String(id)}` ? { answers: [{ id: askId, selected: ['批准发布'] }] } : {}), raisedCards),
      publisher: port,
      journal,
      sessionId: 'session-1',
      now: () => NOW,
    })
    // Batch-lane card copy: neutral, statistics live in the question, the
    // detail carries only the body.
    const batchCard = raisedCards[0]![0]!
    expect(batchCard.question).toBe('发布这条自动暂存的 [CONSTRAINTS] 记忆到机器域？（0 个项目独立观察 / 0 次）')
    expect(batchCard.detail).toBe('共享事实：测试构建走 npm run gate')
    expect(batchCard.detail).not.toContain('git:abc')
    expect(batchCard.options?.some(option => option.label === '跳过')).toBe(true)
    expect(outcome.approved).toBe(1)
    expect(outcome.failed).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ identity: 'dir:global:machine' })
    expect(store.getGlobalCandidate(id)?.state).toBe('approved')
    const row = rows.find(entry => entry.kind === 'global-review')
    expect(row?.payload).toMatchObject({ candidateId: id, decision: 'approved', answer: '批准发布' })
  })

  it('rejects without publishing and skips without touching state', async () => {
    const store = storeWithDomains()
    const rejectId = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 7, content: 'A' })
    const skipId = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 8, content: 'B' })
    const { port, calls } = fakePublisher()
    const answers: Record<string, string[]> = {}
    answers[`global-candidate-${String(rejectId)}`] = ['拒绝']
    answers[`global-candidate-${String(skipId)}`] = ['跳过']
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: answers[askId] ?? [] }] })),
      publisher: port,
      now: () => NOW,
    })
    expect(outcome.rejected).toBe(1)
    expect(outcome.skipped).toBe(1)
    expect(outcome.approved).toBe(0)
    expect(calls).toHaveLength(0)
    expect(store.getGlobalCandidate(rejectId)?.state).toBe('rejected')
    expect(store.getGlobalCandidate(skipId)?.state).toBe('pending')
  })

  it('refuses a gate-failing candidate without raising a card', async () => {
    const store = storeWithDomains()
    // No category and no source memory: the gate refuses (recurrence + category).
    const id = stage(store, {})
    const calls: GlobalReviewQuestion[][] = []
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(() => ({}), calls),
      publisher: fakePublisher().port,
      now: () => NOW,
    })
    expect(outcome.failed).toBe(1)
    expect(calls).toHaveLength(0)
    expect(store.getGlobalCandidate(id)?.state).toBe('pending')
    expect(outcome.lines.some(line => line.includes(`#${String(id)} ✗`))).toBe(true)
  })

  it('fails closed with no asker wired and zero state change', async () => {
    const store = storeWithDomains()
    const id = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 7 })
    const outcome = await reviewGlobalCandidates({ store, now: () => NOW })
    expect(outcome.approved).toBe(0)
    expect(outcome.lines[0]).toContain('人工审批未接线')
    expect(store.getGlobalCandidate(id)?.state).toBe('pending')
  })

  it('respects the batch limit and reports the remainder', async () => {
    const store = storeWithDomains()
    const first = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 1 })
    stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 2 })
    stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 3 })
    const calls: GlobalReviewQuestion[][] = []
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['跳过'] }] }), calls),
      publisher: fakePublisher().port,
      batchLimit: 2,
      now: () => NOW,
    })
    expect(calls).toHaveLength(2)
    expect(outcome.skipped).toBe(2)
    // Skipped candidates stay pending BY DESIGN — remaining counts them.
    expect(outcome.remaining).toBe(3)
    expect(outcome.lines.some(line => line.includes('本批 2/3'))).toBe(true)
    expect(store.getGlobalCandidate(first)?.state).toBe('pending')
  })

  it('reviews ONLY the named candidate when onlyCandidateId is set (the instant promote path)', async () => {
    const store = storeWithDomains()
    stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 1, content: 'earlier pending' })
    const target = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 2, content: 'just promoted' })
    stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 3, content: 'later pending' })
    const { port, calls } = fakePublisher()
    const raised: GlobalReviewQuestion[][] = []
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['批准发布'] }] }), raised),
      publisher: port,
      now: () => NOW,
      onlyCandidateId: target,
    })
    // One card, the promoted one, published; the rest of the pool untouched.
    expect(raised).toHaveLength(1)
    expect(raised[0][0]?.id).toBe(`global-candidate-${String(target)}`)
    // Instant-lane card copy: the operator's own act in the question, the bare
    // body in the detail (no field-line islands), no "skip" non-option.
    const card = raised[0]![0]!
    expect(card.question).toBe('把你刚提升的 memory #2 发布到机器域？')
    expect(card.header).toBe('记忆发布审批 · 机器域')
    expect(card.detail).toBe('just promoted')
    expect(card.detail).not.toContain('来源')
    expect(card.detail).not.toContain('独立观察')
    const labels = card.options?.map(option => option.label) ?? []
    expect(labels).toContain('批准发布')
    expect(labels).not.toContain('跳过')
    expect(labels).toContain('拒绝')
    expect(card.options?.find(option => option.label === '批准发布')?.description).toBe('写入机器域，该域所有成员项目可见')
    expect(outcome.approved).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ identity: 'dir:global:machine' })
    expect(store.getGlobalCandidate(target)?.state).toBe('approved')
    expect(outcome.remaining).toBe(2)
  })

  it('reports a vanished onlyCandidateId without touching the pool', async () => {
    const store = storeWithDomains()
    const pending = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 5 })
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(() => ({})),
      publisher: fakePublisher().port,
      now: () => NOW,
      onlyCandidateId: 9999,
    })
    expect(outcome.failed).toBe(1)
    expect(outcome.lines[0]).toContain('#9999 已不在待审池')
    expect(store.getGlobalCandidate(pending)?.state).toBe('pending')
    expect(outcome.remaining).toBe(1)
  })

  it('treats an unparseable answer as a failure and leaves the candidate pending', async () => {
    const store = storeWithDomains()
    const id = stage(store, { category: 'CONSTRAINTS', sourceMemoryId: 9 })
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(() => ({ unexpected: true })),
      publisher: fakePublisher().port,
      now: () => NOW,
    })
    expect(outcome.failed).toBe(1)
    expect(store.getGlobalCandidate(id)?.state).toBe('pending')
  })

  it('answers an empty queue without touching anything', async () => {
    const store = storeWithDomains()
    const outcome = await reviewGlobalCandidates({ store, ask: fakeAsker(() => ({})), now: () => NOW })
    expect(outcome.lines[0]).toContain('待审队列为空')
    expect(outcome.remaining).toBe(0)
  })

  it('reviews org-domain candidates through the same loop', async () => {
    const store = storeWithDomains()
    const id = stage(store, { domainId: 'dir:global:org', category: 'CONSTRAINTS', sourceMemoryId: 11 })
    const { port, calls } = fakePublisher()
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['批准发布'] }] })),
      publisher: port,
      now: () => NOW,
    })
    expect(outcome.approved).toBe(1)
    expect(calls[0]).toMatchObject({ identity: 'dir:global:org' })
    expect(store.getGlobalCandidate(id)?.state).toBe('approved')
  })

  it('reclassifies to the other domain on the user\u2019s overrule', async () => {
    const store = storeWithDomains()
    const machineId = stage(store, {
      domainId: 'dir:global:machine', category: 'CONSTRAINTS', sourceMemoryId: 21, content: '组织规则：跨仓库串行。',
    })
    const { port, calls } = fakePublisher()
    const { journal, rows } = fakeJournal()
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['发布到组织域'] }] })),
      publisher: port,
      journal,
      now: () => NOW,
    })
    expect(outcome.reclassified).toBe(1)
    expect(outcome.approved).toBe(0)
    // The ORIGINAL candidate retires; the target domain carries the published row.
    expect(store.getGlobalCandidate(machineId)?.state).toBe('rejected')
    const orgCandidate = store.listGlobalCandidates({ state: 'approved', domainId: 'dir:global:org' })
      .find(entry => entry.sourceMemoryId === 21)
    expect(orgCandidate).toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ identity: 'dir:global:org' })
    const row = rows.find(entry => entry.kind === 'global-review')
    expect(row?.payload).toMatchObject({ decision: 'reclassified', toDomain: 'dir:global:org', answer: '发布到组织域' })
  })

  it('retires the original as a duplicate when the target domain already holds the content', async () => {
    const store = storeWithDomains()
    const orgId = stage(store, {
      domainId: 'dir:global:org', category: 'CONSTRAINTS', sourceMemoryId: 22, content: '已在组织域的规则。',
    })
    store.setGlobalCandidateState(orgId, 'approved', NOW)
    const orgRow = store.getGlobalCandidate(orgId)!
    // Same content/hash staged into machine by mistake — the review sees it.
    const machineId = store.upsertGlobalCandidate({
      domainId: 'dir:global:machine',
      content: orgRow.content,
      normalizedHash: orgRow.normalizedHash,
      firstIdentity: orgRow.firstIdentity,
      category: 'CONSTRAINTS',
      sourceMemoryId: 22,
    }, NOW).id
    const { port, calls } = fakePublisher()
    const { journal, rows } = fakeJournal()
    const outcome = await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['发布到组织域'] }] })),
      publisher: port,
      journal,
      now: () => NOW,
    })
    expect(outcome.reclassified).toBe(1)
    expect(outcome.approved).toBe(0)
    expect(calls).toHaveLength(0)
    expect(store.getGlobalCandidate(machineId)?.state).toBe('rejected')
    expect(store.getGlobalCandidate(orgId)?.state).toBe('approved')
    const row = rows.find(entry => entry.kind === 'global-review')
    expect(row?.payload).toMatchObject({ decision: 'reclassified-duplicate' })
  })

  it('offers the reroute option only when the other enabled domain can take the category', async () => {
    const store = storeWithDomains()
    const first = stage(store, { domainId: 'dir:global:machine', category: 'CONSTRAINTS', sourceMemoryId: 23 })
    const calls: GlobalReviewQuestion[][] = []
    await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['跳过'] }] }), calls),
      publisher: fakePublisher().port,
      now: () => NOW,
    })
    expect(calls[0]![0]!.options?.some(option => option.label === '发布到组织域')).toBe(true)
    // Flip org off: the reroute option disappears from the card.
    store.upsertDomain({
      domainId: 'dir:global:org', kind: 'org', enabled: false, budgetTokens: 512,
      cap: defaultDomainCap('org'), shareCategories: ['CONSTRAINTS'],
    }, NOW)
    store.setGlobalCandidateState(first, 'rejected', NOW)
    const second = store.upsertGlobalCandidate({
      domainId: 'dir:global:machine', content: '另一条约束。', normalizedHash: 'hash-reroute-2',
      firstIdentity: 'git:abc12345xyz', category: 'CONSTRAINTS', sourceMemoryId: 24,
    }, NOW).id
    const calls2: GlobalReviewQuestion[][] = []
    await reviewGlobalCandidates({
      store,
      ask: fakeAsker(askId => ({ answers: [{ id: askId, selected: ['跳过'] }] }), calls2),
      publisher: fakePublisher().port,
      now: () => NOW,
    })
    expect(calls2[0]![0]!.options?.some(option => option.label === '发布到组织域')).toBe(false)
    expect(store.getGlobalCandidate(second)?.state).toBe('pending')
  })
})
