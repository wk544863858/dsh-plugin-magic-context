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
  publishGlobalCandidate,
  type DomainWritePort,
} from '../core/global-domains.ts'
import {
  DEFAULT_DOMAIN_BUDGET_TOKENS,
  DEFAULT_SHARE_CATEGORIES,
  defaultDomainCap,
  isDomainKind,
} from '../core/domains.ts'

import type { ProfileWriter } from '../core/profile-write.ts'

export interface SurfaceDeps {
  readonly stores: AdapterStores
  /**
   * The shared store's path, for the two subcommands that have to READ it
   * (`detect` scans it, `promote` resolves a memory id). Absent when the memory
   * lane is unavailable, in which case those two say so instead of guessing.
   */
  readonly corpusDbPath?: string
  /**
   * WP9: the only way `/ctx-global approve` becomes visible to other projects.
   * Absent (read-only or fenced contract) ⇒ approving says so instead of
   * marking a candidate approved with nothing behind it.
   */
  readonly publisher?: DomainWritePort
  /**
   * WP12/DoD: `/ctx-profile retire` is the user domain's retirement path — the
   * drill found the org lane had one and the profile lane did not. Absent
   * (read-only or fenced contract) ⇒ `retire` says so rather than reporting a
   * retirement that never happened.
   */
  readonly profileWriter?: ProfileWriter
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

const PROFILE_USAGE = 'list | show <id> | confirm <id> | reject <id> | retire <id> --yes'
const GLOBAL_USAGE = 'domains | create <domain> --kind org|machine | members [<domain>] | enable <domain> | disable <domain> --yes | '
  + 'add <domain> <identity> | remove <domain> <identity> --yes | candidates [<domain>] | '
  + 'promote <memoryId> [--domain <domain>] | detect | approve <candidateId> --yes | reject-candidate <candidateId> --yes | '
  + 'review via ctx_memory action=review_global (approval cards)'

/** Flag value extractor: `--kind org` → 'org'. */
function flagValue(tokens: readonly string[], name: string): string | undefined {
  const index = tokens.indexOf(name)
  return index === -1 || index + 1 >= tokens.length ? undefined : tokens[index + 1]
}

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
export function planProfileCommand(
  store: AdapterStores,
  rawInput: string | undefined,
  now: number,
  profileWriter?: ProfileWriter,
): CommandResult {
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

  if (verb === 'retire') {
    const id = parseId(tokens[1])
    if (id === undefined) return { kind: 'error', text: `Magic Context: /ctx-profile retire needs a profile id. Usage: ${PROFILE_USAGE}` }
    if (profileWriter === undefined || profileWriter.status.ok !== true) {
      return {
        kind: 'error',
        text: 'Magic Context: the shared profile is not writable right now, so the row was left as it is.',
      }
    }
    const row = profileWriter.listActiveProfiles().find(profile => profile.id === id)
    if (row === undefined) {
      // Distinguishing "not active" from "not writable" matters: an id that is
      // already dismissed must not look like a failed write.
      return { kind: 'error', text: `Magic Context: #${String(id)} is not an active profile row.` }
    }
    if (!wantsApply(tokenize(rawInput))) {
      return {
        kind: 'success',
        text: `Magic Context: would retire #${String(id)} — "${row.content.slice(0, 120)}".\n`
          + 'It would stop being injected in every session, and the removal forces a HARD baseline rebuild '
          + '(the profile digest covers active rows). Add --yes to apply.',
      }
    }
    if (!profileWriter.retireProfile(id, now)) {
      return { kind: 'error', text: `Magic Context: #${String(id)} could not be retired; nothing changed.` }
    }
    return {
      kind: 'success',
      text: `Magic Context: #${String(id)} retired. It no longer renders in <user-profile>, and every session `
        + 'that had it folds its baseline on the next pass (the digest covers active rows). The row itself is '
        + 'kept as dismissed — it is the record of what was once injected.',
    }
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
  corpusDbPath?: string,
  publisher?: DomainWritePort,
): CommandResult {
  // Flags must be read from the RAW tokens: stripFlags removes every
  // `-`-prefixed token, so any flag looked up in `tokens` is invisible (the
  // 2026-10-12 promote --domain bug: the flag was always "absent", so every
  // promotion silently landed in org — even one naming an unknown domain).
  const rawTokens = tokenize(rawInput)
  const tokens = stripFlags(rawTokens)
  const verb = tokens[0] ?? 'domains'

  if (verb === 'domains') {
    const domains = store.listDomains()
    if (domains.length === 0) {
      return {
        kind: 'success',
        text: 'Magic Context: no global domain is defined yet. '
          + 'Create one with: /ctx-global create <domain-id> --kind org|machine '
          + '(e.g. /ctx-global create dir:global:org --kind org), then add members with: /ctx-global add <domain-id> <identity>',
      }
    }
    return { kind: 'success', text: ['Global domains:', ...domains.map(domain => domainLine(store, domain))].join('\n') }
  }

  if (verb === 'create') {
    const rawTokens = tokenize(rawInput)
    const domainId = tokens[1]
    const kind = flagValue(rawTokens, '--kind') ?? 'org'
    if (domainId === undefined) {
      return { kind: 'error', text: `Magic Context: /ctx-global create needs <domain>. Usage: ${GLOBAL_USAGE}` }
    }
    if (!isDomainKind(kind)) {
      return { kind: 'error', text: `Magic Context: --kind must be org or machine (got '${kind}'). Usage: ${GLOBAL_USAGE}` }
    }
    if (store.getDomain(domainId) !== undefined) {
      return { kind: 'error', text: `Magic Context: domain '${domainId}' already exists.` }
    }
    // Born with the derived defaults, exactly like the machine bootstrap
    // (machine-domain.ts) — the operator can edit budget/cap/allowlist later.
    store.upsertDomain({
      domainId,
      kind,
      enabled: true,
      budgetTokens: DEFAULT_DOMAIN_BUDGET_TOKENS[kind],
      cap: defaultDomainCap(kind),
      shareCategories: [...DEFAULT_SHARE_CATEGORIES],
    }, now)
    return { kind: 'success', text: `Magic Context: domain ${domainId} (kind ${kind}) created and enabled. Add members with: /ctx-global add ${domainId} <identity>` }
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
    if (corpusDbPath === undefined) {
      return { kind: 'error', text: 'Magic Context: the shared store is unavailable, so recurrence cannot be scanned.' }
    }
    const scan = detectGlobalCandidates(store, { corpusDbPath, now })
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
    if (corpusDbPath === undefined) {
      return { kind: 'error', text: 'Magic Context: the shared store is unavailable, so a memory cannot be read.' }
    }
    const domainFlag = rawTokens.indexOf('--domain')
    const domainValue = domainFlag >= 0 ? rawTokens[domainFlag + 1] : undefined
    // A flag without a value (or followed by another flag) must FAIL, not fall
    // back to org: a silent fallback publishes human-judged knowledge to the
    // wrong audience, which is the one mistake this flag exists to prevent.
    if (domainFlag >= 0 && (domainValue === undefined || domainValue.startsWith('-'))) {
      return { kind: 'error', text: `Magic Context: --domain needs a value. Usage: ${GLOBAL_USAGE}` }
    }
    const domainId = domainValue ?? ORG_DOMAIN_ID
    const promoted = promoteMemoryToCandidate(store, {
      corpusDbPath,
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
        + `It is human-judged, so /ctx-global approve ${String(candidate.id)} does not need the recurrence gate.\n`
        + `Instant path next time: ctx_memory action=promote (memory_id + domain) enqueues AND raises the card.`,
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
    const apply = wantsApply(tokenize(rawInput))
    const row = store.getGlobalCandidate(id)
    if (row === undefined) return { kind: 'error', text: `Magic Context: no candidate #${String(id)}.` }

    if (verb === 'reject-candidate') {
      if (!apply) {
        return { kind: 'success', text: `Magic Context: would reject candidate #${String(id)} (add --yes to apply).` }
      }
      store.setGlobalCandidateState(id, 'rejected', now)
      return { kind: 'success', text: `Magic Context: candidate #${String(id)} rejected.` }
    }

    // `approve` IS the publish: the state flag alone made a candidate that was
    // "approved" and visible to nobody. The gate runs before the preview and
    // before the apply, so the two can never disagree about publishability.
    const gate = approvalGate(store, row)
    if (!gate.ok) return { kind: 'error', text: `Magic Context: ${gate.error}` }
    if (!apply) {
      return {
        kind: 'success',
        text: `Magic Context: would publish candidate #${String(id)} as ${row.domainId} [${row.category}] `
          + `— every peer project would see it. Add --yes to publish.`,
      }
    }
    if (publisher === undefined) {
      return {
        kind: 'error',
        text: 'Magic Context: the shared store is not writable right now (no memory writer), so the candidate '
          + 'was left pending rather than marked approved with nothing published.',
      }
    }
    const published = publishGlobalCandidate(store, { candidateId: id, writer: publisher, now })
    if (!published.ok) return { kind: 'error', text: `Magic Context: ${published.error}` }
    return {
      kind: 'success',
      text: `Magic Context: candidate #${String(id)} ${published.created ? 'published' : 'was already published'} `
        + `as memory #${String(published.memoryId)} under ${published.identity} [${published.category}]`
        + `${published.created ? '' : ' (its recurrence counter moved instead of a duplicate row)'}; `
        + 'every member project sees it now.',
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
    handler: invocation => planProfileCommand(deps.stores, invocation.rawInput, Date.now(), deps.profileWriter),
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
    handler: invocation => planGlobalCommand(deps.stores, invocation.rawInput, Date.now(), deps.corpusDbPath, deps.publisher),
  })
}
