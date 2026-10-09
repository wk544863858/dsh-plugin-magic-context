/**
 * `/ctx-profile` and `/ctx-global` — the command surface (WP12).
 *
 * Once Magic Context's dashboard is gone there is no UI left, so the whole
 * operating loop has to fit in commands: answer the profile-confirmation queue,
 * and manage the global domains. Two rules shape every handler here:
 *
 *  1. **Reads are free, writes are explicit.** A mutating subcommand prints what
 *     it would do and does nothing until `--yes` is present. Destructive verbs
 *     (disable / remove / reject) are the ones that matter; the flag is required
 *     for all of them rather than only some, so the habit is uniform.
 *  2. **Every answer is a sentence a human can act on.** No bare counts: the
 *     queue prints the candidate text, the domain list prints the derived cap
 *     next to the budget it came from.
 *
 * The planning functions are separated from host registration and take a store
 * directly, so the whole surface is testable without a host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import { decideConfirmation, listPendingConfirmations } from '../core/profile-confirmation.ts'
import {
  ORG_DOMAIN_ID,
  approvalGate,
  detectGlobalCandidates,
  promoteMemoryToCandidate,
} from '../core/global-domains.ts'

export interface SurfaceDeps {
  readonly stores: AdapterStores
  /**
   * The shared store's path, for the two subcommands that have to READ it
   * (`detect` scans it, `promote` resolves a memory id). Absent when the memory
   * lane is unavailable, in which case those two say so instead of guessing.
   */
  readonly contractDbPath?: string
}

type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** Narrowed registration surface (keeps the package typecheck standalone). */
type CommandRegistrar = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { readonly rawInput?: string }) => CommandResult
  }): unknown
}

const PROFILE_USAGE = 'list | show <id> | confirm <id> | reject <id>'
const GLOBAL_USAGE = 'domains | members [<domain>] | enable <domain> | disable <domain> --yes | '
  + 'add <domain> <identity> | remove <domain> <identity> --yes | candidates [<domain>] | '
  + 'promote <memoryId> [--domain <domain>] | detect | approve <candidateId> | reject-candidate <candidateId> --yes'

function tokenize(rawInput: string | undefined): string[] {
  return (rawInput ?? '').trim().split(/\s+/).filter(token => token.length > 0)
}

function wantsApply(tokens: readonly string[]): boolean {
  return tokens.includes('--yes') || tokens.includes('-y')
}

function stripFlags(tokens: readonly string[]): string[] {
  return tokens.filter(token => !token.startsWith('-'))
}

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

// ── /ctx-profile ───────────────────────────────────────────────────────────

/**
 * Plan or perform one `/ctx-profile` invocation.
 *
 * `confirm` is intentionally NOT gated behind `--yes`: it is the action the
 * notice asks the human to take, and gating it would make the queue harder to
 * drain than to fill. `reject` IS gated, because a rejection is what makes a
 * candidate disappear from the reviewer's view for good.
 */
export function planProfileCommand(store: AdapterStores, rawInput: string | undefined, now: number): CommandResult {
  const tokens = stripFlags(tokenize(rawInput))
  const verb = tokens[0] ?? 'list'

  if (verb === 'list') {
    const pending = listPendingConfirmations(store)
    if (pending.length === 0) return { kind: 'success', text: 'Magic Context: no profile candidate is waiting.' }
    const blocks = pending.map(row => `#${String(row.id)}\n${row.question}`)
    return {
      kind: 'success',
      text: [`${String(pending.length)} candidate(s) waiting:`, ...blocks, `Reply with: /ctx-profile ${PROFILE_USAGE}`].join('\n\n'),
    }
  }

  if (verb === 'show') {
    const id = parseId(tokens[1])
    const row = id === undefined
      ? undefined
      : store.listProfileConfirmations().find(candidate => candidate.id === id)
    if (row === undefined) return { kind: 'error', text: `Magic Context: no confirmation #${tokens[1] ?? '?'}.` }
    return { kind: 'success', text: `#${String(row.id)} [${row.state}]\n${row.question}` }
  }

  if (verb === 'confirm') {
    const id = parseId(tokens[1])
    if (id === undefined) return { kind: 'error', text: `Magic Context: /ctx-profile confirm needs an id. Usage: ${PROFILE_USAGE}` }
    const decided = decideConfirmation(store, id, 'approved', now)
    if (decided === undefined) return { kind: 'error', text: `Magic Context: #${String(id)} is not waiting for a decision.` }
    return {
      kind: 'success',
      text: `Magic Context: #${String(id)} confirmed. It is now an approved profile rule and takes effect in every session.\n`
        + 'Promotion into the shared profile happens on the next maintenance tick; nothing is written from this command.',
    }
  }

  if (verb === 'reject') {
    const id = parseId(tokens[1])
    if (id === undefined) return { kind: 'error', text: `Magic Context: /ctx-profile reject needs an id. Usage: ${PROFILE_USAGE}` }
    if (!wantsApply(tokenize(rawInput))) {
      return { kind: 'success', text: `Magic Context: would reject #${String(id)} (add --yes to apply).` }
    }
    const decided = decideConfirmation(store, id, 'rejected', now)
    if (decided === undefined) return { kind: 'error', text: `Magic Context: #${String(id)} is not waiting for a decision.` }
    return { kind: 'success', text: `Magic Context: #${String(id)} rejected. It will never be promoted.` }
  }

  return { kind: 'error', text: `Magic Context: unknown /ctx-profile subcommand '${verb}'. Usage: ${PROFILE_USAGE}` }
}

// ── /ctx-global ────────────────────────────────────────────────────────────

function domainLine(store: AdapterStores, domain: ReturnType<AdapterStores['listDomains']>[number]): string {
  const members = store.listDomainMembers(domain.domainId).length
  return `- ${domain.domainId} [${domain.kind}] ${domain.enabled ? 'enabled' : 'disabled'}`
    + ` · budget ${String(domain.budgetTokens)} tok · cap ${String(domain.cap)}`
    + ` · shares ${domain.shareCategories.length === 0 ? '(nothing)' : domain.shareCategories.join(', ')}`
    + ` · ${String(members)} member(s)`
}

export function planGlobalCommand(
  store: AdapterStores,
  rawInput: string | undefined,
  now: number,
  contractDbPath?: string,
): CommandResult {
  const tokens = stripFlags(tokenize(rawInput))
  const verb = tokens[0] ?? 'domains'

  if (verb === 'domains') {
    const domains = store.listDomains()
    if (domains.length === 0) {
      return {
        kind: 'success',
        text: 'Magic Context: no global domain is defined yet. '
          + 'Import the existing organisation membership with: node scripts/mc-import-workspace.mjs',
      }
    }
    return { kind: 'success', text: ['Global domains:', ...domains.map(domain => domainLine(store, domain))].join('\n') }
  }

  if (verb === 'members') {
    const domainId = tokens[1]
    const rows = store.listDomainMembers(domainId)
    if (rows.length === 0) {
      return { kind: 'success', text: domainId === undefined ? 'Magic Context: no domain members.' : `Magic Context: ${domainId} has no members (it activates nothing).` }
    }
    return { kind: 'success', text: rows.map(row => `- ${row.identity} (${row.domainId})`).join('\n') }
  }

  if (verb === 'add') {
    const domainId = tokens[1]
    const identity = tokens[2]
    if (domainId === undefined || identity === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global add needs <domain> <identity>. Usage: ${GLOBAL_USAGE}` }
    }
    if (store.getDomain(domainId) === undefined) {
      return { kind: 'error', text: `Magic Context: unknown domain '${domainId}'.` }
    }
    store.addDomainMember(domainId, identity, now)
    return { kind: 'success', text: `Magic Context: ${identity} now activates ${domainId}.` }
  }

  if (verb === 'remove') {
    const domainId = tokens[1]
    const identity = tokens[2]
    if (domainId === undefined || identity === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global remove needs <domain> <identity>. Usage: ${GLOBAL_USAGE}` }
    }
    if (!wantsApply(tokenize(rawInput))) {
      return { kind: 'success', text: `Magic Context: would remove ${identity} from ${domainId} (add --yes to apply).` }
    }
    store.removeDomainMember(domainId, identity)
    return { kind: 'success', text: `Magic Context: ${identity} no longer activates ${domainId}.` }
  }

  if (verb === 'enable' || verb === 'disable') {
    const domainId = tokens[1]
    if (domainId === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global ${verb} needs a domain. Usage: ${GLOBAL_USAGE}` }
    }
    const enabled = verb === 'enable'
    if (!enabled && !wantsApply(tokenize(rawInput))) {
      return { kind: 'success', text: `Magic Context: would disable ${domainId} (add --yes to apply).` }
    }
    if (store.getDomain(domainId) === undefined) {
      return { kind: 'error', text: `Magic Context: unknown domain '${domainId}'.` }
    }
    store.setDomainEnabled(domainId, enabled, now)
    return {
      kind: 'success',
      text: enabled
        ? `Magic Context: ${domainId} enabled. Its rows become visible to its members on the next pass.`
        : `Magic Context: ${domainId} disabled. Its rows stop being injected; existing memories stay in the shared store.`,
    }
  }

  if (verb === 'detect') {
    if (contractDbPath === undefined) {
      return { kind: 'error', text: 'Magic Context: the shared store is unavailable, so recurrence cannot be scanned.' }
    }
    const scan = detectGlobalCandidates(store, { contractDbPath, now })
    if (scan.hashes === 0) {
      return {
        kind: 'success',
        text: 'Magic Context: recurrence scan found 0 cross-project candidates.\n'
          + 'That is the expected result on this corpus (measured 2026-10-10: 1292 active rows across 33 projects, '
          + 'no normalized hash shared by two projects) — historian facts are project-bound. '
          + 'Use /ctx-global promote <memoryId> for human-judged organisation knowledge.',
      }
    }
    return {
      kind: 'success',
      text: `Magic Context: recurrence scan found ${String(scan.hashes)} hash(es); upserted ${String(scan.upserted)}, `
        + `skipped ${String(scan.blocked)} credential-shaped.`,
    }
  }

  if (verb === 'promote') {
    const memoryId = parseId(tokens[1])
    if (memoryId === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global promote needs a memory id. Usage: ${GLOBAL_USAGE}` }
    }
    if (contractDbPath === undefined) {
      return { kind: 'error', text: 'Magic Context: the shared store is unavailable, so a memory cannot be read.' }
    }
    const domainFlag = tokens.indexOf('--domain')
    const domainId = domainFlag >= 0 && tokens[domainFlag + 1] !== undefined ? tokens[domainFlag + 1] : ORG_DOMAIN_ID
    const promoted = promoteMemoryToCandidate(store, {
      contractDbPath,
      memoryId,
      domainId,
      now,
    })
    if (!promoted.ok) return { kind: 'error', text: `Magic Context: ${promoted.error}` }
    const candidate = promoted.candidate
    return {
      kind: 'success',
      text: `Magic Context: memory #${String(memoryId)} is now candidate #${String(candidate.id)} for ${domainId}`
        + `${candidate.category === undefined ? '' : ` (category ${candidate.category})`}.\n`
        + `It is human-judged, so /ctx-global approve ${String(candidate.id)} does not need the recurrence gate.`,
    }
  }

  if (verb === 'candidates') {
    const domainId = tokens[1]
    const rows = store.listGlobalCandidates({ state: 'pending', ...domainId === undefined ? {} : { domainId } })
    if (rows.length === 0) return { kind: 'success', text: 'Magic Context: no pending global candidate.' }
    return {
      kind: 'success',
      text: rows.map(row =>
        `- #${String(row.id)} [${row.domainId}] observed by ${String(row.distinctIdentities)} project(s), `
        + `${String(row.observationCount)} time(s): ${row.content.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n'),
    }
  }

  if (verb === 'approve' || verb === 'reject-candidate') {
    const id = parseId(tokens[1])
    if (id === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global ${verb} needs a candidate id. Usage: ${GLOBAL_USAGE}` }
    }
    const state = verb === 'approve' ? 'approved' : 'rejected'
    if (state === 'rejected' && !wantsApply(tokenize(rawInput))) {
      return { kind: 'success', text: `Magic Context: would reject candidate #${String(id)} (add --yes to apply).` }
    }
    const row = store.getGlobalCandidate(id)
    if (row === undefined) return { kind: 'error', text: `Magic Context: no candidate #${String(id)}.` }
    if (state === 'approved') {
      const gate = approvalGate(store, row)
      if (!gate.ok) return { kind: 'error', text: `Magic Context: ${gate.error}` }
    }
    store.setGlobalCandidateState(id, state, now)
    return {
      kind: 'success',
      text: state === 'approved'
        ? `Magic Context: candidate #${String(id)} approved for ${row.domainId}.\n`
          // Saying "publishing happens on the next tick" would be a lie: the
          // write into the shared store under a domain identity is not
          // implemented yet (it is the step that awaits a go-ahead).
          + 'NOT PUBLISHED YET: writing it into the shared store under the domain identity is still ahead, '
          + 'so nothing is visible to other projects until that lands.'
        : `Magic Context: candidate #${String(id)} rejected.`,
    }
  }

  return { kind: 'error', text: `Magic Context: unknown /ctx-global subcommand '${verb}'. Usage: ${GLOBAL_USAGE}` }
}

// ── registration ───────────────────────────────────────────────────────────

export function registerCtxProfileCommand(ctx: Context, deps: SurfaceDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as CommandRegistrar | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-profile unavailable')
    return
  }
  commands.register({
    name: 'ctx-profile',
    description: 'Magic Context: answer the profile-confirmation queue (directive-shaped candidates need you).',
    input: { hint: PROFILE_USAGE },
    handler: invocation => planProfileCommand(deps.stores, invocation.rawInput, Date.now()),
  })
}

export function registerCtxGlobalCommand(ctx: Context, deps: SurfaceDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as CommandRegistrar | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-global unavailable')
    return
  }
  commands.register({
    name: 'ctx-global',
    description: 'Magic Context: global domains — inspect, activate, and manage their membership.',
    input: { hint: GLOBAL_USAGE },
    handler: invocation => planGlobalCommand(deps.stores, invocation.rawInput, Date.now(), deps.contractDbPath),
  })
}
