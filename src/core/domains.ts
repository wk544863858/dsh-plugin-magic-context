/**
 * The adapter's global domains: `user` (the person), `org` (organisation
 * knowledge), `machine` (this machine's environment).
 *
 * Why domains exist at all
 * ------------------------
 * A *global* memory is one that is not owned by any single project. Magic
 * Context ships exactly one such lane — the user profile — because a profile
 * "applies everywhere" and therefore needs no activation rule. Organisation
 * knowledge does not have that property: the company database pointer must be
 * invisible in an open-source project's session. So the domain axis answers
 * exactly one question — **under what circumstances should this be visible?** —
 * and deliberately does not answer "what is it about" (that is `category`).
 *
 * One domain = one activation rule + one budget + one cap derived from it.
 * The kind set is closed at three on purpose: a new kind has to earn its place
 * with an independent activation rule, audience and budget.
 *
 * See docs/dsh-plugin-platform-takeover-and-global-domains-2026-10-09.md.
 */
import { V2_MEMORY_CATEGORIES } from './memory-categories.ts'

/** The closed set of global domains. */
export const DOMAIN_KINDS = ['user', 'org', 'machine'] as const

export type DomainKind = (typeof DOMAIN_KINDS)[number]

export function isDomainKind(value: unknown): value is DomainKind {
  return typeof value === 'string' && (DOMAIN_KINDS as readonly string[]).includes(value)
}

/**
 * Per-domain *render* budget in tokens. These are the numbers the composed
 * baseline must respect; they are not the same as the cap's source (below)
 * because `user` renders across two blocks (m[0] profile + m[1] delta) while
 * remaining a curated, small set.
 */
export const DEFAULT_DOMAIN_BUDGET_TOKENS: Record<DomainKind, number> = {
  user: 5000,
  org: 768,
  machine: 512,
}

/**
 * The curation target a domain's cap is derived from. It differs from the
 * render budget for `user` on purpose: the profile renders under a 4000-token
 * m[0] budget, but an unbounded set of behavioural notes is not a curated
 * profile — the cap has to be a product decision expressed as a token target.
 */
export const DEFAULT_DOMAIN_CAP_BUDGET_TOKENS: Record<DomainKind, number> = {
  user: 750,
  org: 768,
  machine: 500,
}

/** Estimated tokens for one rendered memory line (content + list overhead). */
export const DOMAIN_TOKENS_PER_LINE = 20

/** Headroom kept below the cap budget, so a domain never sits exactly at its ceiling. */
export const DOMAIN_CAP_SAFETY = 0.8

/**
 * A domain's cap is DERIVED, never picked: it is the number of lines the cap
 * budget can hold, with headroom. Non-finite and non-positive budgets collapse
 * to the floor of one line rather than to zero (a domain that can hold nothing
 * would silently reject every candidate).
 */
export function deriveDomainCap(capBudgetTokens: number): number {
  if (!Number.isFinite(capBudgetTokens) || capBudgetTokens <= 0) return 1
  return Math.max(1, Math.floor((capBudgetTokens / DOMAIN_TOKENS_PER_LINE) * DOMAIN_CAP_SAFETY))
}

export function defaultDomainCap(kind: DomainKind): number {
  return deriveDomainCap(DEFAULT_DOMAIN_CAP_BUDGET_TOKENS[kind])
}

/** The provider identity that owns a domain's rows in the shared store. */
export function domainIdentity(kind: DomainKind): string {
  return `dir:global:${kind}`
}

/** What a missing allowlist means (the contract's own column default). */
export const DEFAULT_SHARE_CATEGORIES: readonly string[] = ['CONSTRAINTS']

/**
 * Parse a share allowlist with the contract's fail-closed convention
 * (upstream `normalizeShareCategories`, workspaces.ts:69-97):
 *
 *   missing/null  -> the default allowlist
 *   malformed, not an array, or ANY unknown category -> `[]`, share nothing
 *
 * The asymmetry is deliberate and load-bearing: a corrupt allowlist must not
 * silently widen what becomes visible across projects.
 */
export function parseShareCategories(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [...DEFAULT_SHARE_CATEGORIES]
  if (typeof raw !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const valid = new Set<string>(V2_MEMORY_CATEGORIES)
  const categories: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !valid.has(item)) return []
    if (!categories.includes(item)) categories.push(item)
  }
  return categories.sort((left, right) => left.localeCompare(right))
}

/**
 * Serialize an allowlist for storage, rejecting unknown categories. This is
 * also the publish-time pre-check: a category outside the allowlist would be
 * written and then be invisible forever, which is a silent failure — so it is
 * refused here instead.
 */
export function serializeShareCategories(categories: readonly string[]): string {
  const valid = new Set<string>(V2_MEMORY_CATEGORIES)
  for (const category of categories) {
    if (!valid.has(category)) {
      throw new Error(
        `unknown share category '${category}' (allowed: ${V2_MEMORY_CATEGORIES.join(', ')})`,
      )
    }
  }
  return JSON.stringify([...new Set(categories)].sort((left, right) => left.localeCompare(right)))
}
