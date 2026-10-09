/**
 * WP10 — the `machine` domain: what every project on THIS machine can share,
 * with an operator-supplied exclusion list.
 *
 * It is a domain like the other two — same identity shape, same peer lane, same
 * cap derivation — so nothing in recall, search or the watermark needs to know
 * it exists. What is specific to it is only WHO the members are: this machine's
 * projects, minus the ones the operator keeps out.
 *
 * Two decisions carry the design:
 *
 *  1. **Membership is added, never inferred away.** The identities this process
 *     has seen are a PARTIAL view — it has served some projects, not all — so
 *     "not seen" can never mean "not a member". Only an explicit exclusion
 *     removes a member. Getting this wrong would delete a colleague's project
 *     from the domain because nobody opened it this hour.
 *  2. **Disabling is reversible and never destructive.** Turning the switch off
 *     flips the domain's `enabled` flag and leaves the membership rows alone, so
 *     switching it back on restores exactly what was there. The flag is what the
 *     activation function reads, so a disabled domain is genuinely invisible
 *     rather than merely unused.
 */

import {
  DEFAULT_DOMAIN_BUDGET_TOKENS,
  DEFAULT_SHARE_CATEGORIES,
  defaultDomainCap,
  domainIdentity,
} from './domains.ts'
import type { AdapterStores } from './stores.ts'

export interface MachineDomainConfig {
  readonly enabled?: boolean
  readonly excludeProjects?: readonly string[]
}

export interface MachineDomainPlan {
  readonly enabled: boolean
  /** The membership the domain should have while enabled. */
  readonly members: readonly string[]
  readonly add: readonly string[]
  /** Members removed because the operator excluded them. */
  readonly remove: readonly string[]
  readonly changed: boolean
}

/**
 * Decide the machine domain's next state. Pure, so the membership rules are
 * testable without a store.
 */
export function planMachineDomain(input: {
  readonly identities: readonly string[]
  readonly existingMembers: readonly string[]
  readonly config: MachineDomainConfig
}): MachineDomainPlan {
  const enabled = input.config.enabled === true
  const excluded = new Set(input.config.excludeProjects ?? [])
  const existing = [...new Set(input.existingMembers)]
  if (!enabled) {
    // While off, membership is not touched: the only thing that changes is the
    // flag (applied by the caller), because off must be as reversible as on.
    return { enabled: false, members: existing, add: [], remove: [], changed: false }
  }
  const target = [...new Set(input.identities.filter(identity => !excluded.has(identity)))].sort()
  const targetSet = new Set(target)
  const existingSet = new Set(existing)
  const add = target.filter(identity => !existingSet.has(identity))
  // Only explicit exclusions remove a member — never a partial view of identity.
  const remove = existing.filter(identity => excluded.has(identity))
  return {
    enabled: true,
    members: [...new Set([...target, ...existing.filter(identity => !excluded.has(identity))])].sort(),
    add,
    remove,
    changed: add.length > 0 || remove.length > 0,
  }
}

/**
 * Apply the plan. Idempotent: a second call with the same inputs reports
 * `changed: false` and writes nothing, so it is safe to run on every pass.
 */
export function syncMachineDomain(
  stores: AdapterStores,
  input: {
    readonly identities: readonly string[]
    readonly config: MachineDomainConfig
    readonly now: number
  },
): MachineDomainPlan {
  const domainId = domainIdentity('machine')
  const existing = stores.getDomain(domainId)
  const enabled = input.config.enabled === true
  // Nothing configured and nothing remembered: not even a row to keep in sync.
  if (existing === undefined && !enabled) {
    return { enabled: false, members: [], add: [], remove: [], changed: false }
  }

  const existingMembers = stores.listDomainMembers(domainId).map(member => member.identity)
  const plan = planMachineDomain({
    identities: input.identities,
    existingMembers,
    config: input.config,
  })

  if (existing === undefined) {
    // Born with the derived cap and the contract's default allowlist, exactly
    // like an imported domain — the operator can still edit both afterwards.
    stores.upsertDomain({
      domainId,
      kind: 'machine',
      enabled: plan.enabled,
      budgetTokens: DEFAULT_DOMAIN_BUDGET_TOKENS.machine,
      cap: defaultDomainCap('machine'),
      shareCategories: DEFAULT_SHARE_CATEGORIES,
    }, input.now)
  } else if (existing.enabled !== plan.enabled) {
    // Flip only the switch: a hand-edited cap or allowlist must survive a sync.
    stores.setDomainEnabled(domainId, plan.enabled, input.now)
  }

  for (const identity of plan.add) stores.addDomainMember(domainId, identity, input.now)
  for (const identity of plan.remove) stores.removeDomainMember(domainId, identity)
  return plan
}
