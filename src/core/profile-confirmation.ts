/**
 * The confirmation gate for directive-shaped profile candidates (WP6).
 *
 * Magic Context promoted profile entries automatically, with no validation of
 * its own "at least N semantically similar variants" prompt requirement. That
 * is survivable for a note about someone's communication style; it is not
 * survivable for an instruction, because the profile is injected into every
 * session on the machine. So a candidate that reads like an instruction does
 * not enter the profile until a human answers a question about it.
 *
 * The invariant this module exists to keep (I8 in the design):
 *   **an unconfirmed directive-shaped candidate is never visible** — not in the
 *   injected profile, not in search. It lives only in the queue.
 *
 * The queue itself is adapter-owned state (schema v8 `profile_confirmations`),
 * so holding a candidate back costs nothing in the frozen contract.
 */
import type { AdapterStores, ProfileConfirmationRow } from './stores.ts'
import { buildConfirmationQuestion, classifyProfileShape, type ProfileShapeVerdict } from './directive-detect.ts'

export type ConfirmationDecision = 'approved' | 'rejected'

export interface CandidateGateResult {
  readonly shape: 'descriptive' | 'directive'
  readonly verdict: ProfileShapeVerdict
  /** Present only when the candidate must be confirmed first. */
  readonly confirmation?: ProfileConfirmationRow
}

/**
 * Decide what happens to one candidate.
 *
 * Descriptive -> the caller may promote it through the normal path.
 * Directive   -> queued, and the caller must NOT promote it.
 *
 * Enqueueing is idempotent per pending candidate, so a retried historian pass
 * cannot produce a second question for the same observation.
 */
export function gateProfileCandidate(
  store: AdapterStores,
  input: { contractCandidateId: number; content: string },
  now: number,
): CandidateGateResult {
  const verdict = classifyProfileShape(input.content)
  if (verdict.shape !== 'directive') return { shape: 'descriptive', verdict }
  const confirmation = store.enqueueProfileConfirmation(
    {
      contractCandidateId: input.contractCandidateId,
      question: buildConfirmationQuestion(input.content, verdict),
      content: input.content,
    },
    now,
  )
  return { shape: 'directive', verdict, confirmation }
}

export function listPendingConfirmations(store: AdapterStores): ProfileConfirmationRow[] {
  return store.listProfileConfirmations('pending')
}

/**
 * Answer a pending question. Returns the decided row, or `undefined` when the
 * id is unknown or was already decided — deciding twice must not resurrect a
 * candidate the human already rejected.
 */
export function decideConfirmation(
  store: AdapterStores,
  id: number,
  decision: ConfirmationDecision,
  now: number,
): ProfileConfirmationRow | undefined {
  const pending = store.listProfileConfirmations('pending').find(row => row.id === id)
  if (pending === undefined) return undefined
  store.decideProfileConfirmation(id, decision, now)
  return { ...pending, state: decision, decidedAt: now }
}

/**
 * The one-line summary a session notice carries. Deliberately includes the
 * command surface, because a question with no way to answer it is just noise.
 */
export function formatConfirmationNotice(rows: readonly ProfileConfirmationRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const head = rows.length === 1
    ? '有 1 条画像候选需要你确认（它会在所有会话生效）'
    : `有 ${rows.length} 条画像候选需要你确认（它们会在所有会话生效）`
  const lines = [head]
  for (const row of rows.slice(0, 3)) {
    lines.push(`  #${String(row.id)} ${row.content.replace(/\s+/g, ' ').trim().slice(0, 72)}`)
  }
  if (rows.length > 3) lines.push(`  …还有 ${String(rows.length - 3)} 条`)
  lines.push('  用 /ctx-profile list 查看全文，confirm <id> 确认，reject <id> 丢弃。')
  return lines.join('\n')
}
