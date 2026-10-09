/**
 * The command surface (WP12).
 *
 * With the dashboard gone these two commands are the whole operating loop, so
 * the assertions are about the two ways a command surface goes wrong: it says it
 * did something it did not do, or it changes state without being asked. Every
 * destructive verb is checked twice — once without `--yes` (nothing moves) and
 * once with it (the change lands).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import { planGlobalCommand, planProfileCommand } from '../src/dsh/command-surface.ts'
import { gateProfileCandidate } from '../src/core/profile-confirmation.ts'
import { defaultDomainCap } from '../src/core/domains.ts'

const NOW = 1_700_000_000_000
const ORG = 'dir:global:org'
const DIRECTIVE = '未确认前必须先在 plan 模式内讨论，拿到确认后才能写文件。'

const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cmd-'))
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

function seedDomain(s: ReturnType<typeof openStores>, enabled = false) {
  s.upsertDomain(
    {
      domainId: ORG,
      kind: 'org',
      enabled,
      budgetTokens: 768,
      cap: defaultDomainCap('org'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  s.addDomainMember(ORG, 'git:company', NOW)
}

describe('/ctx-profile', () => {
  it('says so plainly when the queue is empty', () => {
    const s = store()
    const result = planProfileCommand(s, undefined, NOW)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('no profile candidate is waiting')
  })

  it('lists the pending candidate with its question', () => {
    const s = store()
    gateProfileCandidate(s, { contractCandidateId: 21, content: DIRECTIVE }, NOW)
    const result = planProfileCommand(s, 'list', NOW)
    expect(result.text).toContain('1 candidate(s) waiting')
    expect(result.text).toContain('所有会话')
    expect(result.text).toContain('#1')
  })

  it('confirms without --yes, because that is the action the notice asks for', () => {
    const s = store()
    const queued = gateProfileCandidate(s, { contractCandidateId: 22, content: DIRECTIVE }, NOW).confirmation!
    const result = planProfileCommand(s, `confirm ${String(queued.id)}`, NOW)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('confirmed')
    expect(s.listProfileConfirmations('approved')).toHaveLength(1)
    // Confirming twice is an error, not a second approval.
    expect(planProfileCommand(s, `confirm ${String(queued.id)}`, NOW).kind).toBe('error')
  })

  it('does not reject without --yes, and does with it', () => {
    const s = store()
    const queued = gateProfileCandidate(s, { contractCandidateId: 23, content: DIRECTIVE }, NOW).confirmation!
    const dry = planProfileCommand(s, `reject ${String(queued.id)}`, NOW)
    expect(dry.text).toContain('would reject')
    expect(s.listProfileConfirmations('pending')).toHaveLength(1)

    const applied = planProfileCommand(s, `reject ${String(queued.id)} --yes`, NOW)
    expect(applied.text).toContain('rejected')
    expect(s.listProfileConfirmations('pending')).toEqual([])
    expect(s.listProfileConfirmations('rejected')).toHaveLength(1)
  })

  it('retires profile rows only through a writer, and only with an id', () => {
    const s = store()
    // A read-only or fenced contract yields no writer: refuse, rather than
    // report a retirement that never happened. (The full path — preview, apply,
    // row kept as dismissed, second retirement refused — is walked end to end in
    // tests/strip-drill.spec.ts against a real profile store.)
    const fenced = planProfileCommand(s, 'retire 1 --yes', NOW)
    expect(fenced.kind).toBe('error')
    expect(fenced.text).toContain('not writable')

    expect(planProfileCommand(s, 'retire', NOW).kind).toBe('error')
    expect(planProfileCommand(s, 'frobnicate', NOW).text).toContain('retire <id> --yes')
  })

  it('rejects unknown ids and unknown verbs with usage', () => {
    const s = store()
    expect(planProfileCommand(s, 'show 99', NOW).kind).toBe('error')
    expect(planProfileCommand(s, 'confirm', NOW).kind).toBe('error')
    const unknown = planProfileCommand(s, 'frobnicate', NOW)
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('list | show')
  })
})

describe('/ctx-global', () => {
  it('points at the import when nothing is defined yet', () => {
    const s = store()
    const result = planGlobalCommand(s, undefined, NOW)
    expect(result.text).toContain('mc-import-workspace.mjs')
  })

  it('prints the derived cap next to the budget it came from', () => {
    const s = store()
    seedDomain(s)
    const text = planGlobalCommand(s, 'domains', NOW).text!
    expect(text).toContain(ORG)
    expect(text).toContain('budget 768 tok · cap 30')
    expect(text).toContain('disabled')
    expect(text).toContain('1 member(s)')
    expect(text).toContain('shares CONSTRAINTS')
  })

  it('lists members and adds one', () => {
    const s = store()
    seedDomain(s)
    expect(planGlobalCommand(s, 'members', NOW).text).toContain('git:company')
    expect(planGlobalCommand(s, `add ${ORG} git:other`, NOW).kind).toBe('success')
    expect(s.listDomainMembers(ORG).map(row => row.identity)).toContain('git:other')
    expect(planGlobalCommand(s, 'add no:such git:x', NOW).kind).toBe('error')
    expect(planGlobalCommand(s, `add ${ORG}`, NOW).kind).toBe('error')
  })

  it('gates remove and disable behind --yes', () => {
    const s = store()
    seedDomain(s, true)

    expect(planGlobalCommand(s, `remove ${ORG} git:company`, NOW).text).toContain('would remove')
    expect(s.listDomainMembers(ORG)).toHaveLength(1)
    planGlobalCommand(s, `remove ${ORG} git:company --yes`, NOW)
    expect(s.listDomainMembers(ORG)).toEqual([])

    expect(planGlobalCommand(s, `disable ${ORG}`, NOW).text).toContain('would disable')
    expect(s.getDomain(ORG)?.enabled).toBe(true)
    planGlobalCommand(s, `disable ${ORG} --yes`, NOW)
    expect(s.getDomain(ORG)?.enabled).toBe(false)

    // Enabling is additive and needs no confirmation.
    expect(planGlobalCommand(s, `enable ${ORG}`, NOW).kind).toBe('success')
    expect(s.getDomain(ORG)?.enabled).toBe(true)
  })

  it('refuses a global promotion without independent recurrence', () => {
    const s = store()
    seedDomain(s)
    const single = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'only one project saw this', normalizedHash: 'h1', firstIdentity: 'git:a', category: 'CONSTRAINTS' },
      NOW,
    )
    s.recordCandidateObservation({ candidateId: single.id, identity: 'git:a', sessionId: 's1' }, NOW)

    const refused = planGlobalCommand(s, `approve ${String(single.id)}`, NOW)
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('at least two')
    expect(s.getGlobalCandidate(single.id)?.state).toBe('pending')

    const two = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'two projects saw this', normalizedHash: 'h2', firstIdentity: 'git:a', category: 'CONSTRAINTS' },
      NOW,
    )
    s.recordCandidateObservation({ candidateId: two.id, identity: 'git:a', sessionId: 's1' }, NOW)
    s.recordCandidateObservation({ candidateId: two.id, identity: 'git:b', sessionId: 's2' }, NOW)

    // `approve` IS the publish now (WP9), and publishing is a write into the
    // shared store — so without --yes it is a PREVIEW and the state must not move.
    const preview = planGlobalCommand(s, `approve ${String(two.id)}`, NOW)
    expect(preview.kind).toBe('success')
    expect(preview.text).toContain('would publish')
    expect(s.getGlobalCandidate(two.id)?.state).toBe('pending')

    // With --yes but no writable shared store it says so, rather than marking a
    // candidate approved that nobody can see.
    const noWriter = planGlobalCommand(s, `approve ${String(two.id)} --yes`, NOW)
    expect(noWriter.kind).toBe('error')
    expect(noWriter.text).toContain('not writable')
    expect(s.getGlobalCandidate(two.id)?.state).toBe('pending')
  })

  it('publishes an approved candidate and reports what became visible', () => {
    const s = store()
    seedDomain(s)
    const candidate = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'DB access goes through the bastion', normalizedHash: 'h4', firstIdentity: 'git:a', category: 'CONSTRAINTS' },
      NOW,
    )
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:a', sessionId: 's1' }, NOW)
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:b', sessionId: 's2' }, NOW)

    const published: Array<{ identity: string; category: string; content: string }> = []
    const publisher = {
      publishDomainMemory: (input: { identity: string; category: string; content: string }) => {
        published.push({ identity: input.identity, category: input.category, content: input.content })
        return { ok: true as const, id: 9001, created: true }
      },
    }
    const result = planGlobalCommand(s, `approve ${String(candidate.id)} --yes`, NOW, undefined, publisher)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('#9001')
    expect(result.text).toContain(ORG)
    // The candidate is published under the DOMAIN identity, with its category —
    // the two fields the peer lane filters on.
    expect(published).toEqual([{ identity: ORG, category: 'CONSTRAINTS', content: 'DB access goes through the bastion' }])
    expect(s.getGlobalCandidate(candidate.id)?.state).toBe('approved')
  })

  it('leaves a candidate pending when the shared write refuses it', () => {
    const s = store()
    seedDomain(s)
    const candidate = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'a fact the store will refuse', normalizedHash: 'h5', firstIdentity: 'git:a', category: 'CONSTRAINTS' },
      NOW,
    )
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:a', sessionId: 's1' }, NOW)
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:b', sessionId: 's2' }, NOW)

    const refusing = {
      publishDomainMemory: () => ({ ok: false as const, detail: 'contract is read-only' }),
    }
    const result = planGlobalCommand(s, `approve ${String(candidate.id)} --yes`, NOW, undefined, refusing)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('read-only')
    // The state transition runs LAST: a failed write must stay retryable.
    expect(s.getGlobalCandidate(candidate.id)?.state).toBe('pending')
  })

  it('lists candidates with their recurrence weight', () => {
    const s = store()
    seedDomain(s)
    const candidate = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'DB access goes through the bastion', normalizedHash: 'h3', firstIdentity: 'git:a' },
      NOW,
    )
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:a', sessionId: 's1' }, NOW)
    s.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:b', sessionId: 's2' }, NOW)
    const text = planGlobalCommand(s, 'candidates', NOW).text!
    expect(text).toContain('2 project(s)')
    expect(text).toContain('bastion')
  })

  it('gates candidate rejection behind --yes and rejects unknown verbs', () => {
    const s = store()
    seedDomain(s)
    const candidate = s.upsertGlobalCandidate(
      { domainId: ORG, content: 'x', normalizedHash: 'h4', firstIdentity: 'git:a' },
      NOW,
    )
    expect(planGlobalCommand(s, `reject-candidate ${String(candidate.id)}`, NOW).text).toContain('would reject')
    expect(s.getGlobalCandidate(candidate.id)?.state).toBe('pending')
    planGlobalCommand(s, `reject-candidate ${String(candidate.id)} --yes`, NOW)
    expect(s.getGlobalCandidate(candidate.id)?.state).toBe('rejected')

    const unknown = planGlobalCommand(s, 'nope', NOW)
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('domains | members')
  })
})
