/**
 * Magic Context's memory taxonomy, duplicated verbatim so the adapter can
 * write rows Magic Context will accept without importing its TypeScript.
 *
 * Source of truth (kept in sync on purpose, with the schema-version fence in
 * `memory-bridge.ts` as the tripwire): `packages/plugin/src/features/
 * magic-context/memory/constants.ts` + `normalize-hash.ts`.
 *
 * Contract version: MC storage schema v95 (see MEMORY_SCHEMA_MAX_VERSION).
 */

/** The v2 taxonomy — the only categories new writes may use. */
export const V2_MEMORY_CATEGORIES = [
  'PROJECT_RULES',
  'ARCHITECTURE',
  'CONSTRAINTS',
  'CONFIG_VALUES',
  'NAMING',
] as const

/**
 * Categories the historian may promote. Legacy values stay promotable so
 * pre-v2 rows and lingering legacy writes keep working (MC: constants.ts:17).
 */
export const PROMOTABLE_CATEGORIES: readonly string[] = [
  ...V2_MEMORY_CATEGORIES,
  'ARCHITECTURE_DECISIONS',
  'CONFIG_DEFAULTS',
  'USER_PREFERENCES',
  'USER_DIRECTIVES',
  'ENVIRONMENT',
  'WORKFLOW_RULES',
  'KNOWN_ISSUES',
]

/** Render/priority order used when injecting memories (MC: CATEGORY_PRIORITY). */
export const MEMORY_CATEGORY_PRIORITY: readonly string[] = [
  ...V2_MEMORY_CATEGORIES,
  'USER_DIRECTIVES',
  'USER_PREFERENCES',
  'CONFIG_DEFAULTS',
  'ARCHITECTURE_DECISIONS',
  'ENVIRONMENT',
  'WORKFLOW_RULES',
  'KNOWN_ISSUES',
]

export const MEMORY_CATEGORY_ORDER_UNKNOWN = 99

export function memoryCategoryOrder(category: string): number {
  const index = MEMORY_CATEGORY_PRIORITY.indexOf(category)
  return index === -1 ? MEMORY_CATEGORY_ORDER_UNKNOWN : index
}

/** TTL in ms by category; absent = permanent (MC: CATEGORY_DEFAULT_TTL). */
export const CATEGORY_DEFAULT_TTL: Readonly<Record<string, number>> = {
  WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000,
  KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000,
}

/**
 * `expires_at` for a new row: only the legacy TTL categories expire
 * (MC: promotion.ts:36-39 → `resolveExpiresAt`).
 */
export function resolveExpiresAt(category: string, now: number): number | undefined {
  const ttl = CATEGORY_DEFAULT_TTL[category]
  return ttl === undefined ? undefined : now + ttl
}

/**
 * TTL applied to HISTORIAN-promoted rows (user decision 2026-10-16).
 *
 * The promoted pool grew monotonically and nothing bounded it: measured on the
 * live corpus, 1,941 non-domain rows, 67% of the active ones never recalled,
 * and `expires_at` non-null on exactly ZERO of them — the contract's TTL table
 * only covers two legacy categories, so the expiry pass had nothing to expire.
 * Every promoted fact now carries a 90-day window; a fact that is still being
 * re-observed refreshes it (see `promoteFacts`), so only abandoned rows age out.
 */
export const HISTORIAN_MEMORY_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * `expires_at` for a promoted historian row: the category's own TTL when it has
 * one (shorter wins — KNOWN_ISSUES already expires at 30 days), else the
 * historian window. Unlike `resolveExpiresAt` this never returns undefined:
 * every promoted row gets a window.
 */
export function resolveHistorianExpiresAt(category: string, now: number): number {
  return now + (CATEGORY_DEFAULT_TTL[category] ?? HISTORIAN_MEMORY_TTL_MS)
}

export function isPromotableCategory(category: unknown): category is string {
  return typeof category === 'string' && PROMOTABLE_CATEGORIES.includes(category)
}

/**
 * One historian-extracted fact. Magic Context's promotion path only accepts
 * categorized facts (`promotion.ts:57-68`), so the category is part of the
 * contract, not decoration: a fact without a promotable category can never
 * become a memory.
 */
export interface MemoryFact {
  readonly category: string
  readonly content: string
}
