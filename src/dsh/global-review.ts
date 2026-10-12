/**
 * L1① second leg — human approval for global-domain candidates (2026-10-12).
 *
 * The staging leg (`global-autostage.ts`) may fill the machine domain's
 * pending pool on its own, and `promote` feeds org candidates by hand; this
 * module is the PUBLISHING leg's UI: one `ctx.userQuestions.ask()` card per
 * pending candidate, answered in the operator's own session. Publishing stays
 * a human act — the card IS the human act, and every decision is journalled
 * with the answer verbatim. Both global domains flow through the same loop:
 * the queue is domain-agnostic, the card names the domain.
 *
 * Why agent-mediated: the shipped Web answerer routes only requests that
 * carry a live root Agent, and `ask()` authenticates that identity — a
 * maintenance tick runs outside any turn and would resolve NO_PROVIDER. The
 * trigger is therefore `ctx_memory action=review_global` inside a turn, so
 * the questions and answers land in the session log like every model-visible
 * exchange.
 *
 * Fail-closed everywhere: no asker wired (headless, service absent) refuses
 * before touching state; a gate refusal is reported without showing a card
 * and leaves the candidate pending; an aborted, malformed or unrecognised
 * answer leaves it pending too. The approval gate runs BEFORE the card so the
 * user is never asked to approve something no gate would ever publish.
 */
import { approvalGate, publishGlobalCandidate, type DomainWritePort } from '../core/global-domains.ts'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'

/** One question card in the shape `ctx.userQuestions.ask()` accepts. */
export interface GlobalReviewQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
}

/** The wired asker: sends cards for one session and resolves to the raw answer. */
export type GlobalReviewAsker = (input: {
  readonly questions: readonly GlobalReviewQuestion[]
  /** The asking session's id — the asker resolves the live root Agent for Web routing. */
  readonly sessionId?: string
}) => Promise<unknown>

const OPTION_APPROVE = '批准发布'
const OPTION_SKIP = '跳过'
const OPTION_REJECT = '拒绝'
/** Reclassification options: the card names the OTHER global domain explicitly. */
const OPTION_REROUTE_MACHINE = '发布到机器域'
const OPTION_REROUTE_ORG = '发布到组织域'

export interface GlobalReviewOutcome {
  readonly approved: number
  readonly rejected: number
  /** The user overruled the staging domain: published into the other one. */
  readonly reclassified: number
  readonly skipped: number
  /** Gate refusals, publish failures and unanswerable cards — state untouched. */
  readonly failed: number
  readonly lines: readonly string[]
  /** Candidates still pending after this pass. */
  readonly remaining: number
}

function domainLabel(domainId: string): string {
  if (domainId === 'dir:global:machine') return '机器域'
  if (domainId === 'dir:global:org') return '组织域'
  return domainId
}

/** Extract the first answer's verdict from the raw `ask()` reply, or undefined when the shape is unrecognised. */
function firstAnswer(answer: unknown, id: string): { readonly label: string; readonly custom?: string } | undefined {
  if (answer === null || typeof answer !== 'object') return undefined
  const answers = (answer as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return undefined
  for (const item of answers) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { id?: unknown; selected?: unknown; custom?: unknown }
    if (record.id !== id) continue
    const selected = Array.isArray(record.selected)
      ? record.selected.filter((entry): entry is string => typeof entry === 'string')
      : []
    const custom = typeof record.custom === 'string' && record.custom.trim() !== '' ? record.custom.trim() : undefined
    return { label: selected[0] ?? custom ?? '', ...(custom === undefined ? {} : { custom }) }
  }
  return undefined
}

export async function reviewGlobalCandidates(input: {
  readonly store: AdapterStores
  /** Absent = human interaction is not wired: refuse without touching state. */
  readonly ask?: GlobalReviewAsker
  /** Absent = the shared store is not writable; approvals would publish nothing. */
  readonly publisher?: DomainWritePort
  readonly journal?: Journal
  /** Cards one call may raise (default 5) so a full queue cannot hold a turn hostage. */
  readonly batchLimit?: number
  readonly sessionId?: string
  readonly now: () => number
  /**
   * Review ONLY this candidate (the `ctx_memory action=promote` path): the
   * promotion just enqueued it and the card must come up at once, ahead of
   * whatever else sits in the pool. Absent = the batch review of the whole
   * pending queue, unchanged.
   */
  readonly onlyCandidateId?: number
}): Promise<GlobalReviewOutcome> {
  const pendingAll = input.store.listGlobalCandidates({ state: 'pending' })
  const pending = input.onlyCandidateId === undefined
    ? pendingAll
    : pendingAll.filter(candidate => candidate.id === input.onlyCandidateId)
  if (input.ask === undefined) {
    return {
      approved: 0,
      rejected: 0,
      reclassified: 0,
      skipped: 0,
      failed: 0,
      lines: ['人工审批未接线（headless 或宿主缺 userQuestions 服务），待审队列原样保留。'],
      remaining: pending.length,
    }
  }
  if (pending.length === 0) {
    if (input.onlyCandidateId !== undefined) {
      return {
        approved: 0,
        rejected: 0,
        reclassified: 0,
        skipped: 0,
        failed: 1,
        lines: [`候选 #${String(input.onlyCandidateId)} 已不在待审池（可能刚被处理过），本次未弹卡。`],
        remaining: pendingAll.length,
      }
    }
    return { approved: 0, rejected: 0, reclassified: 0, skipped: 0, failed: 0, lines: ['全局域待审队列为空。'], remaining: 0 }
  }
  const batch = pending.slice(0, Math.max(1, input.batchLimit ?? 5))
  const lines: string[] = []
  let approved = 0
  let rejected = 0
  let reclassified = 0
  let skipped = 0
  let failed = 0

  for (const candidate of batch) {
    // Gate BEFORE the card: the user must never be asked to approve something
    // no gate would publish. A refusal here is a report line, state untouched.
    const gate = approvalGate(input.store, candidate)
    if (!gate.ok) {
      failed += 1
      lines.push(`#${String(candidate.id)} ✗ ${gate.error}`)
      input.journal?.info('global-review', `candidate #${String(candidate.id)} gate-refused`, {
        phase: 'global-review',
        candidateId: candidate.id,
        domainId: candidate.domainId,
        decision: 'gate-refused',
        reason: gate.error,
      }, input.sessionId)
      continue
    }
    if (input.publisher === undefined) {
      failed += 1
      lines.push(`#${String(candidate.id)} ✗ 共享库当前不可写（无发布器），候选保留待审`)
      continue
    }
    // Card copy differs by LANE, and ALL metadata lives in the `question`: the
    // host renders `detail` flush-left while header/question are indented, so
    // any field line in `detail` reads as a stray island (user feedback
    // 2026-10-12). `detail` therefore carries ONLY the memory body. An instant
    // promotion (onlyCandidateId) is the operator's OWN just-requested act —
    // the question says so and drops the pool statistics and the "skip"
    // non-option; a batch card stays neutral with all four choices.
    const instant = input.onlyCandidateId !== undefined
    const domainName = domainLabel(candidate.domainId)
    const question = instant
      ? `把你刚提升的 memory #${String(candidate.sourceMemoryId ?? candidate.id)} 发布到${domainName}？`
      : `发布这条自动暂存的 [${candidate.category ?? '未分类'}] 记忆到${domainName}？` +
        `（${String(candidate.distinctIdentities)} 个项目独立观察 / ${String(candidate.observationCount)} 次）`
    const llmNote = instant || candidate.suggestedDomain === undefined
      ? ''
      : `\n\nLLM 建议域：${domainLabel(candidate.suggestedDomain === 'machine' ? 'dir:global:machine' : 'dir:global:org')}` +
        (candidate.suggestionReason === undefined ? '' : `（${candidate.suggestionReason}）`)
    // Reclassification precheck: the OTHER enabled global domain, and only if
    // this candidate's category is on its allowlist — the card must never
    // offer a reroute the gate would refuse (same principle as gating before
    // the card).
    const otherDomain = input.store.listDomains()
      .find(domain => domain.enabled && domain.domainId !== candidate.domainId
        && (domain.kind === 'machine' || domain.kind === 'org'))
    const rerouteAllowed = otherDomain !== undefined && candidate.category !== undefined
      && otherDomain.shareCategories.includes(candidate.category)
    const rerouteOption = otherDomain === undefined ? undefined
      : otherDomain.kind === 'org' ? OPTION_REROUTE_ORG : OPTION_REROUTE_MACHINE
    const options = [
      {
        label: OPTION_APPROVE,
        description: instant
          ? `写入${domainName}，该域所有成员项目可见`
          : '写入共享域，所有成员项目可见（source_type=user）',
      },
      ...(rerouteAllowed && rerouteOption !== undefined
        ? [{
            label: rerouteOption,
            description: `改判到${domainLabel(otherDomain.domainId)}并发布（原候选退役，journal 记 reclassified）`,
          }]
        : []),
      ...instant ? [] : [{ label: OPTION_SKIP, description: '留在待审池，下次再决定' }],
      { label: OPTION_REJECT, description: instant ? '终局拒绝，不再进入待审' : '标记 rejected，不再进入待审' },
    ]
    const id = `global-candidate-${String(candidate.id)}`
    let answer: unknown
    try {
      answer = await input.ask({
        sessionId: input.sessionId,
        questions: [{
          id,
          question,
          detail: `${candidate.content}${llmNote}`,
          header: `记忆发布审批 · ${domainName}`,
          options,
        }],
      })
    } catch (error) {
      failed += 1
      lines.push(`#${String(candidate.id)} ✗ 审批卡未能送达：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const verdict = firstAnswer(answer, id)
    if (verdict === undefined) {
      failed += 1
      lines.push(`#${String(candidate.id)} ✗ 无法解析审批答案，候选保留待审`)
      continue
    }
    const note = verdict.custom
    const journalDecision = (decision: string, extra?: Record<string, unknown>): void => {
      input.journal?.info('global-review', `candidate #${String(candidate.id)} ${decision}`, {
        phase: 'global-review',
        candidateId: candidate.id,
        domainId: candidate.domainId,
        decision,
        answer: verdict.label,
        ...(note === undefined ? {} : { note }),
        ...extra,
      }, input.sessionId)
    }
    if ((rerouteOption !== undefined && verdict.label === rerouteOption)
      || ((verdict.label === OPTION_REROUTE_ORG || verdict.label === OPTION_REROUTE_MACHINE)
        && rerouteOption !== undefined)) {
      // Human overrule of the staging domain. The target row is upserted in
      // the other domain (idempotent per domain+hash), gated, published; the
      // ORIGINAL candidate retires as rejected — journal carries the verdict.
      const targetDomainId = otherDomain?.domainId
      if (targetDomainId === undefined || input.publisher === undefined) {
        failed += 1
        lines.push(`#${String(candidate.id)} ✗ 改判目标域不可用，候选保留待审`)
        continue
      }
      const rerouted = input.store.upsertGlobalCandidate({
        domainId: targetDomainId,
        content: candidate.content,
        normalizedHash: candidate.normalizedHash,
        firstIdentity: candidate.firstIdentity,
        ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
        ...(candidate.compartmentStart === undefined ? {} : { compartmentStart: candidate.compartmentStart }),
        ...(candidate.compartmentEnd === undefined ? {} : { compartmentEnd: candidate.compartmentEnd }),
        category: candidate.category,
        sourceMemoryId: candidate.sourceMemoryId,
        suggestedDomain: candidate.suggestedDomain,
        ...(candidate.suggestionReason === undefined ? {} : { suggestionReason: candidate.suggestionReason }),
      }, input.now())
      if (rerouted.state === 'approved') {
        // The content already lives in the target domain — retire the original
        // as a duplicate instead of publishing twice.
        input.store.setGlobalCandidateState(candidate.id, 'rejected', input.now())
        reclassified += 1
        lines.push(`#${String(candidate.id)} ⤴ 目标域已有同内容行（memory 已发布），原候选退役`)
        journalDecision('reclassified-duplicate', { toDomain: targetDomainId, reroutedCandidateId: rerouted.id })
        continue
      }
      const rerouteGate = approvalGate(input.store, rerouted)
      if (!rerouteGate.ok) {
        failed += 1
        lines.push(`#${String(candidate.id)} ✗ 改判被目标域 gate 拒绝：${rerouteGate.error}`)
        journalDecision('reroute-refused', { toDomain: targetDomainId, reason: rerouteGate.error })
        continue
      }
      const published = publishGlobalCandidate(input.store, {
        candidateId: rerouted.id,
        writer: input.publisher,
        now: input.now(),
      })
      if (!published.ok) {
        failed += 1
        lines.push(`#${String(candidate.id)} ✗ 改判发布失败：${published.error}`)
        journalDecision('reroute-publish-failed', { toDomain: targetDomainId, reason: published.error })
        continue
      }
      input.store.setGlobalCandidateState(candidate.id, 'rejected', input.now())
      reclassified += 1
      lines.push(`#${String(candidate.id)} ⤴ 改判发布到 ${domainLabel(targetDomainId)}`
        + `（memory #${String(published.memoryId)}），原候选退役`)
      journalDecision('reclassified', {
        toDomain: targetDomainId,
        reroutedCandidateId: rerouted.id,
        memoryId: published.memoryId,
      })
      continue
    }
    if (verdict.label === OPTION_APPROVE || verdict.label.startsWith('批准')) {
      const published = publishGlobalCandidate(input.store, {
        candidateId: candidate.id,
        writer: input.publisher,
        now: input.now(),
      })
      if (!published.ok) {
        failed += 1
        lines.push(`#${String(candidate.id)} ✗ 发布失败：${published.error}`)
        journalDecision('publish-failed', { reason: published.error })
        continue
      }
      approved += 1
      lines.push(`#${String(candidate.id)} ✓ 已发布为 ${published.identity} [${published.category}]`
        + `（memory #${String(published.memoryId)}${published.created ? '' : '，已存在'}）`)
      journalDecision('approved', { memoryId: published.memoryId })
      continue
    }
    if (verdict.label === OPTION_REJECT || verdict.label.startsWith('拒绝')) {
      input.store.setGlobalCandidateState(candidate.id, 'rejected', input.now())
      rejected += 1
      lines.push(`#${String(candidate.id)} ✗ 已拒绝${note === undefined ? '' : `（${note}）`}`)
      journalDecision('rejected')
      continue
    }
    skipped += 1
    lines.push(`#${String(candidate.id)} → 跳过，留在待审池`)
    journalDecision('skipped')
  }

  const remaining = input.store.listGlobalCandidates({ state: 'pending' }).length
  if (pending.length > batch.length) {
    lines.push(`（本批 ${String(batch.length)}/${String(pending.length)} 条，剩余 ${String(remaining)} 条待审，再次调用继续）`)
  }
  return { approved, rejected, reclassified, skipped, failed, lines, remaining }
}
