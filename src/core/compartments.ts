/**
 * Compartments — Magic Context's historian output, in adapter-neutral terms.
 *
 * A compartment is an LLM-written digest of a contiguous span of the
 * conversation, stored with four detail tiers so the adapter can degrade it
 * gracefully as it ages (Magic Context's p1–p4 ladder) instead of losing it
 * to a single fixed summary. The tiers are produced in one call: the
 * historian is asked for all four at once.
 *
 * This module owns the historian's OUTPUT CONTRACT and its rendering. It has
 * no DSH and no SQLite dependency, so the whole thing is unit-testable.
 */
import type { MemoryFact } from './memory-categories.ts'
import { errText } from './types.ts'

/** One compartment's four detail tiers, most detailed (p1) to most compressed (p4). */
export interface CompartmentTiers {
  readonly p1: string
  readonly p2: string
  readonly p3: string
  readonly p4: string
}

/** The validated historian output, before it is stored. */
export interface CompartmentDraft {
  readonly tiers: CompartmentTiers
  readonly importance: number
  /** Categorized facts — the only shape Magic Context can promote. */
  readonly facts: readonly MemoryFact[]
  readonly events: readonly string[]
  /**
   * WP5: statements about the USER that would still hold in another project
   * ("always answer in Chinese", "never push without asking"). They travel
   * outside `facts` because facts are project-scoped and these are not.
   *
   * Optional on purpose: a compartment row stored before WP5 has none, and the
   * historian writes them to the candidate pool immediately after the digest
   * lands, so nothing has to re-read them out of the row later.
   */
  readonly userObservations?: readonly string[]
}

/** A stored compartment row. */
export interface Compartment extends CompartmentDraft {
  readonly sessionId: string
  readonly compartmentId: number
  readonly createdAt: number
  /** First and last covered surface seqs (inclusive). */
  readonly coveredStartSeq: number
  readonly coveredEndSeq: number
  /** Every covered surface node seq, in surface order. */
  readonly coveredSeqs: readonly number[]
  /** Token estimate of the covered span at summarization time. */
  readonly coveredTokens: number
  /** The `baseline_epoch` in force when the compartment was created. */
  readonly baselineEpoch: number
  /** The placeholder event that landed for it, once the publish lane ran. */
  readonly landedEventSeq?: number
  /**
   * Terminal non-publish outcome (adapter schema v7): `not-shrinkable` (the
   * publish guard proved the digest does not pay for its baseline render) or
   * `superseded-entrants` (substantive nodes entered the positional range
   * after drafting — the row is retired and its span re-claimed for a fresh
   * digest). A row with a landed reason is never published and never retried;
   * `listUnlandedCompartments` excludes it.
   */
  readonly landedReason?: string
}

export type CompartmentTier = 'p1' | 'p2' | 'p3' | 'p4'

/** The `[compacted §C<n>§]` placeholder (Magic Context's dropped-then-compacted marker). */
export function compactedPlaceholder(compartmentId: number): string {
  return `[compacted §C${compartmentId}§]`
}

/** Rough token estimate used for triggering and budgets (chars/4, min 1). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Pick the detail tier for one compartment from its importance and age.
 * Adapter-side approximation of Magic Context's decay math (documented
 * divergence): four fixed age bands, promoted/demoted one step by importance.
 */
export function selectTier(importance: number, ageMs: number): CompartmentTier {
  const bands: readonly CompartmentTier[] = ['p1', 'p2', 'p3', 'p4']
  const age = Math.max(0, ageMs)
  let index = age < 10 * 60_000 ? 0 : age < 2 * 60 * 60_000 ? 1 : age < 24 * 60 * 60_000 ? 2 : 3
  if (importance >= 80) index -= 1
  else if (importance <= 20) index += 1
  return bands[Math.min(bands.length - 1, Math.max(0, index))] as CompartmentTier
}

/** The text of one compartment at its natural tier. */
export function tierText(compartment: Compartment, now: number): { tier: CompartmentTier; text: string } {
  const tier = selectTier(compartment.importance, now - compartment.createdAt)
  return { tier, text: compartment.tiers[tier] }
}

/** The header line identifying a compartment in a rendered baseline. */
export function compartmentHeader(compartment: Compartment, now: number): string {
  const { tier } = tierText(compartment, now)
  const minutes = Math.max(0, Math.round((now - compartment.createdAt) / 60_000))
  return `§C${compartment.compartmentId}§ [${tier}, importance ${String(compartment.importance)}, ${String(minutes)}m ago]`
}

/**
 * Render one compartment as a baseline block: header, digest, and the
 * extracted facts/events. `mostCompressedTier` bounds fidelity downward (the
 * budget path forces p4 on a compartment whose natural tier is more detailed).
 */
export function renderCompartment(
  compartment: Compartment,
  now: number,
  mostCompressedTier?: CompartmentTier,
): string {
  const natural = tierText(compartment, now)
  const order: readonly CompartmentTier[] = ['p1', 'p2', 'p3', 'p4']
  const forced = mostCompressedTier !== undefined
    && order.indexOf(mostCompressedTier) > order.indexOf(natural.tier)
  const tier = forced ? (mostCompressedTier as CompartmentTier) : natural.tier
  const lines = [`${compartmentHeader(compartment, now)}`, compartment.tiers[tier]]
  if (compartment.facts.length > 0) {
    lines.push(`facts: ${compartment.facts.map(fact =>
      fact.category.length === 0 ? fact.content : `[${fact.category}] ${fact.content}`).join(' | ')}`)
  }
  if (compartment.events.length > 0) lines.push(`events: ${compartment.events.join(' | ')}`)
  return lines.join('\n')
}

/** The in-band sentinels wrapping the injected baseline inside its node. */
export const BASELINE_OPEN = '<magic-context>'
export const BASELINE_CLOSE = '</magic-context>'

// ── m[1] mutation deltas: Magic Context's `<memory-updates>` block ───────────
//
// Contract: `docs/dsh-plugin-memory-write-contract.md` §6. Additive writes
// surface through the `maxMemoryId` watermark (`<new-memories>`); everything
// non-additive (`update`/`archive`/`delete`/`superseded`) is recorded in the
// shared `memory_mutation_log` and must surface as a *delta* here instead. The
// block is rendered with the exact bytes of Magic Context's
// `renderMemoryUpdatesBlock` (TS `inject-compartments.ts:2794-2876`, Rust
// `memory_render.rs:333-377`) so the two hosts agree on the wire format.

/** Magic Context's `memory_mutation_log.mutation_type` vocabulary (§6.1). */
export type MemoryMutationType = 'archive' | 'delete' | 'update' | 'superseded'

/**
 * One coalesced mutation-log row, ready to render. The bridge resolves the
 * live memory row for `update` and the supersede chain for `superseded` so
 * this stays a pure, DB-free value object.
 */
export interface MemoryUpdateLine {
  /** `memory_mutation_log.id` — the ordering key (globally monotonic). */
  readonly id: number
  readonly targetMemoryId: number
  readonly mutationType: MemoryMutationType
  /** The new category, when the mutation carries one (`update`/`superseded`). */
  readonly category?: string
  /** The live content for an `update` (MC re-reads the row, §6.3). */
  readonly content?: string
  /** The replacement id for a `superseded` mutation. */
  readonly supersededById?: number
  /**
   * `superseded` only: true when the replacement resolves to an eligible
   * memory. Otherwise the line degrades to `<removed>` (MC §6.4).
   */
  readonly replacementResolvable?: boolean
}

/**
 * Magic Context's visibility sentinel: the mutation only flipped the row's
 * cross-project visibility, the content is unchanged (§6.2).
 */
export const MEMORY_VISIBILITY_SENTINEL = '__mc_visibility__'

/** MC inject-compartments.ts:1142 — forced rows per delta render, hard cap. */
export const MAX_FORCED_MEMORIES_PER_DELTA = 10

/** The full `<memory-updates>` render: the block plus MC's forced set
 *  (inject-compartments.ts:2822-2869) for the sibling `<new-memories>`. */
export interface MemoryUpdatesRender {
  readonly block: string
  readonly count: number
  readonly forcedMemoryIds: readonly number[]
}

export const MEMORY_UPDATES_OPEN = '<memory-updates>'
export const MEMORY_UPDATES_CLOSE = '</memory-updates>'
export const MEMORY_UPDATES_HEADER = 'These memories changed since the snapshot below — trust these:'

/** Attribute escaping (MC `memory_render.rs:36-47`): `& < > "`. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Text escaping (MC `memory_render.rs:36-47`): `& < >`. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render Magic Context's `<memory-updates>` block, or `''` when there is
 * nothing to say. The header alone means "empty" (§6.4), so an empty delta
 * contributes zero bytes — the cache-prefix invariant depends on it.
 *
 * @param options.renderedIds - ids whose content is already rendered in the
 *   sibling `<new-memories>` block of the same m[1] region. An `<updated>`
 *   line for one of them is dropped so no memory's content is rendered twice;
 *   pointer lines (`<superseded>`/`<removed>`) are still emitted.
 * @param options.baselineIds - ids rendered in the m[0] baseline. When given,
 *   mutations for any other target are dropped entirely (MC
 *   inject-compartments.ts:2843-2848): the model never saw that id, so an
 *   `<updated>`/`<removed>` pointer for it would be phantom.
 */
export function renderMemoryUpdates(
  updates: readonly MemoryUpdateLine[],
  options: {
    readonly renderedIds?: ReadonlySet<number>
    readonly baselineIds?: ReadonlySet<number>
    /** MC `eligibleMemoryIds`: every currently-visible row, pre-budget. */
    readonly eligibleIds?: ReadonlySet<number>
  } = {},
): MemoryUpdatesRender {
  const lines: string[] = [MEMORY_UPDATES_HEADER]
  const emitted = new Set<number>()
  // MC inject-compartments.ts:2822-2869 — rows the model never saw in m[0]
  // can still be FORCED into `<new-memories>`: a `superseded` replacement and
  // a visibility-flipped target are eligible even when out of the baseline.
  const forcedIds = new Set<number>()
  for (const update of [...updates].sort((left, right) => left.id - right.id)) {
    const target = update.targetMemoryId
    // When the caller supplies the eligible set it is authoritative (MC);
    // without it a legacy caller cannot be checked — stay permissive.
    const eligible = options.eligibleIds === undefined || options.eligibleIds.has(target)
    if (update.mutationType === 'superseded') {
      // MC order (:2825-2841): the replacement is forced FIRST (even when the
      // target itself was never in the baseline), then the pointer line only
      // renders when the target WAS in the baseline — otherwise it is phantom.
      const replacement = update.supersededById
      const replacementVisible = options.eligibleIds === undefined
        || (replacement !== undefined && options.eligibleIds.has(replacement))
      const replacementResolvable = update.replacementResolvable === true && replacementVisible
      if (replacement !== undefined && replacementResolvable
        && options.baselineIds?.has(replacement) !== true) {
        forcedIds.add(replacement)
      }
      if (options.baselineIds !== undefined && !options.baselineIds.has(target)) continue
      emitted.add(target)
      lines.push(replacement !== undefined && replacementResolvable
        ? `  <superseded id="${String(target)}" by="${String(replacement)}"/>`
        : `  <removed id="${String(target)}"/>`)
      continue
    }
    if (options.baselineIds !== undefined && !options.baselineIds.has(target)) {
      // Out-of-baseline target: a visibility flip still surfaces the row
      // (forced), anything else stays silent (MC :2843-2848).
      if (update.mutationType === 'update'
        && update.category === MEMORY_VISIBILITY_SENTINEL
        && eligible) {
        forcedIds.add(target)
      }
      continue
    }
    // Coalescing already keeps one row per target upstream; this is the
    // defensive second gate ("the same change never appears twice").
    if (emitted.has(target)) continue
    if (update.mutationType !== 'update') {
      emitted.add(target)
      lines.push(`  <removed id="${String(target)}"/>`)
      continue
    }
    if (options.renderedIds?.has(target) === true) continue
    const content = update.content
    if (content === undefined || content.length === 0) {
      emitted.add(target)
      lines.push(`  <removed id="${String(target)}"/>`)
      continue
    }
    emitted.add(target)
    const category = update.category
    // MC omits the attribute for an empty category and for the visibility
    // sentinel (it is not a real category) — §6.4.
    const hasCategory = category !== undefined
      && category.length > 0
      && category !== MEMORY_VISIBILITY_SENTINEL
    lines.push(hasCategory
      ? `  <updated id="${String(target)}" category="${escapeAttribute(category)}">${escapeText(content)}</updated>`
      : `  <updated id="${String(target)}">${escapeText(content)}</updated>`)
  }
  const forcedMemoryIds = [...forcedIds].sort((left, right) => left - right)
    .slice(0, MAX_FORCED_MEMORIES_PER_DELTA)
  if (lines.length === 1) return { block: '', count: 0, forcedMemoryIds }
  return {
    block: [MEMORY_UPDATES_OPEN, ...lines, MEMORY_UPDATES_CLOSE].join('\n'),
    count: lines.length - 1,
    forcedMemoryIds,
  }
}

/**
 * Compose the m[0] baseline / m[1] delta block. m[0] is frozen history
 * (compartments created at or before the last hard rebuild, plus project
 * memories); m[1] is the delta accumulated since. Newest first inside m[1],
 * oldest first inside m[0] so the model reads a stable, chronological spine.
 *
 * @param budgetTokens - soft cap; older m[0] compartments degrade to their
 *   compressed tier and then drop out when the budget is exhausted. m[1] is
 *   never truncated (it is the part that must not be lost).
 */
export function renderBaseline(input: {
  readonly now: number
  /** Compartments created at or before the last hard rebuild. */
  readonly baseline: readonly Compartment[]
  /** Compartments accumulated since the last hard rebuild. */
  readonly delta: readonly Compartment[]
  readonly memories: readonly string[]
  /**
   * Memories written AFTER the m[0] watermark (Magic Context's additive lane).
   * They render in the delta region, never in m[0]: a new memory must not
   * rebuild the cached prefix.
   */
  readonly newMemories?: readonly string[]
  /**
   * Ids of {@link newMemories}, in the same order. Used to keep the
   * `<memory-updates>` block from re-rendering content that `<new-memories>`
   * already carries in the same m[1] region (no memory rendered twice).
   */
  readonly newMemoryIds?: readonly number[]
  /**
   * Ids rendered in the m[0] baseline. When given, `<memory-updates>` only
   * announces mutations whose target is one of them (MC
   * inject-compartments.ts:2843-2848): a target the model never saw would
   * make the pointer phantom.
   */
  readonly baselineIds?: readonly number[]
  /**
   * Non-additive changes (MC's `memory_mutation_log` delta) since the frozen
   * m[0]. They are rendered as `<memory-updates>`, positioned after the m[0]
   * sections and before `<new-memories>`, so their bytes live entirely in the
   * m[1] region: an update can never disturb the cached prefix.
   */
  readonly memoryUpdates?: readonly MemoryUpdateLine[]
  /**
   * MC `eligibleMemoryIds`: every currently-visible memory id, pre-budget.
   * Supplied, `<memory-updates>` collects forced rows (a `superseded`
   * replacement, a visibility flip) that must appear in `<new-memories>`
   * regardless of the delta budget (cap {@link MAX_FORCED_MEMORIES_PER_DELTA}).
   */
  readonly eligibleIds?: readonly number[]
  /**
   * Rendered lines for the forced ids (caller maps them via the eligible
   * rows). Appended to `<new-memories>` after the budgeted additions, exactly
   * like MC's deltaMemories composition (inject-compartments.ts:2966-2969).
   */
  readonly forcedMemoryLines?: readonly string[]
  /**
   * WP8: the user-profile lines that belong to m[0] (`<user-profile>`). The
   * profile has no activation rule — it is global to the person, exactly as in
   * Magic Context — so it renders ABOVE the project memories: who the person is
   * frames what the project is.
   *
   * The budget is the caller's (the bridge trims with the same `continue`
   * semantics the memory pool uses), because only the reader knows how many
   * tokens the profile is worth.
   */
  readonly profileLines?: readonly string[]
  /**
   * WP8: profile rows written AFTER the frozen m[0] watermark. They render in
   * the m[1] region as `<new-user-profile>`, so a new profile entry never
   * rebuilds the cached prefix.
   */
  readonly newProfileLines?: readonly string[]
  readonly budgetTokens: number
}): string {
  const sections: string[] = []
  const profileLines = input.profileLines ?? []
  if (profileLines.length > 0) {
    sections.push(['<user-profile>', ...profileLines, '</user-profile>'].join('\n'))
  }
  if (input.memories.length > 0) {
    sections.push(['<project-memories>', ...input.memories, '</project-memories>'].join('\n'))
  }
  if (input.baseline.length > 0) {
    const ordered = [...input.baseline].sort((left, right) => left.createdAt - right.createdAt)
    const rendered: string[] = []
    let used = 0
    for (const compartment of ordered) {
      const full = renderCompartment(compartment, input.now)
      const fullCost = estimateTokens(full)
      if (used + fullCost <= input.budgetTokens) {
        rendered.push(full)
        used += fullCost
        continue
      }
      const compressed = renderCompartment(compartment, input.now, 'p4')
      const compressedCost = estimateTokens(compressed)
      if (used + compressedCost <= input.budgetTokens) {
        rendered.push(compressed)
        used += compressedCost
      }
    }
    if (rendered.length > 0) sections.push(['<compartment-baseline>', ...rendered, '</compartment-baseline>'].join('\n'))
  }
  // m[1] begins here: every section below is delta-shaped and may change without
  // touching a single byte of the sections above (the cache-prefix invariant).
  const memoryUpdates = renderMemoryUpdates(input.memoryUpdates ?? [], {
    ...input.newMemoryIds === undefined ? {} : { renderedIds: new Set(input.newMemoryIds) },
    ...input.baselineIds === undefined ? {} : { baselineIds: new Set(input.baselineIds) },
    ...input.eligibleIds === undefined ? {} : { eligibleIds: new Set(input.eligibleIds) },
  })
  if (memoryUpdates.block.length > 0) sections.push(memoryUpdates.block)
  const forcedMemoryLines = input.forcedMemoryLines ?? []
  const budgetedNewMemories = input.newMemories ?? []
  const newMemories = budgetedNewMemories.length > 0 || forcedMemoryLines.length > 0
    ? [...budgetedNewMemories, ...forcedMemoryLines]
    : []
  if (newMemories.length > 0) {
    sections.push(['<new-memories>', ...newMemories, '</new-memories>'].join('\n'))
  }
  const newProfileLines = input.newProfileLines ?? []
  if (newProfileLines.length > 0) {
    sections.push(['<new-user-profile>', ...newProfileLines, '</new-user-profile>'].join('\n'))
  }
  if (input.delta.length > 0) {
    const ordered = [...input.delta].sort((left, right) => right.createdAt - left.createdAt)
    sections.push([
      '<compartment-delta>',
      ...ordered.map(compartment => renderCompartment(compartment, input.now)),
      '</compartment-delta>',
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return [BASELINE_OPEN, ...sections, BASELINE_CLOSE].join('\n')
}

/** Index of the baseline block inside a message's text, if it carries one. */
export function findBaselineRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(BASELINE_OPEN)
  if (start === -1) return undefined
  const close = text.indexOf(BASELINE_CLOSE, start + BASELINE_OPEN.length)
  if (close === -1) return undefined
  return { start, end: close + BASELINE_CLOSE.length }
}

/** Strip any previously injected baseline block from a message text. */
export function stripBaseline(text: string): string {
  const range = findBaselineRange(text)
  if (range === undefined) return text
  return (text.slice(0, range.start) + text.slice(range.end)).trim()
}

export class HistorianOutputError extends Error {
  constructor(message: string) {
    super(`magic-context historian output rejected: ${message}`)
    this.name = 'HistorianOutputError'
  }
}

function asTier(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HistorianOutputError(`summary.${key} must be a non-empty string`)
  }
  return value.trim()
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HistorianOutputError('facts/events must be arrays')
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

/**
 * Facts as `{category, content}` (Magic Context's promotable shape).
 *
 * Legacy plain strings are still accepted by the HISTORIAN contract — a model
 * that returns `["..."]` must not fail the whole run — but they carry no
 * category and are therefore not promotable; they are kept as `category: ''`
 * so the compartment still renders them and the journal can explain why they
 * were skipped. Unknown categories are kept verbatim for the same reason:
 * Magic Context drops them at promotion time, not at parse time.
 */
function asFactArray(value: unknown): MemoryFact[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HistorianOutputError('facts must be an array')
  const facts: MemoryFact[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content.length > 0) facts.push({ category: '', content })
      continue
    }
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const content = typeof record.content === 'string' ? record.content.trim() : ''
      if (content.length === 0) continue
      const category = typeof record.category === 'string' ? record.category.trim() : ''
      facts.push({ category, content })
    }
  }
  return facts
}

/**
 * A one-line description of why a JSON-ish text does not balance, for the
 * failure journal.
 *
 * All four live `invalid-output` failures (2026-10-08..10-10) reported a JSON
 * syntax error at the LAST character of the output — position = `outputChars - 1`
 * — while the tail the journal kept was a well-formed ending (`...".` then `}`).
 * A parser only trips on the final `}` when something earlier never closed, so
 * the text looked intact at both ends and the defect sat in the middle, exactly
 * where the journal kept nothing. Counting openers against closers, ignoring
 * both inside string literals, turns that into a recorded fact instead of a
 * guess about the model.
 */
export function describeJsonImbalance(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      const want = char === '}' ? '{' : '['
      if (stack.length === 0) return `unexpected '${char}'`
      if (stack[stack.length - 1] !== want) return `'${stack[stack.length - 1] as string}' closed by '${char}'`
      stack.pop()
    }
  }
  if (inString) return 'unterminated string'
  if (stack.length === 0) return ''
  const closers = new Map<string, number>()
  for (const open of stack) {
    const close = open === '{' ? '}' : ']'
    closers.set(close, (closers.get(close) ?? 0) + 1)
  }
  return `unclosed ${[...closers.entries()].map(([close, count]) => `'${close}'×${String(count)}`).join('+')}`
}

/**
 * Parse and validate a historian response. Throws {@link HistorianOutputError}
 * on any contract violation — the run then fails closed (no compartment row,
 * no mutation) rather than storing a half-digest.
 */
export function parseHistorianOutput(text: string): CompartmentDraft {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open === -1 || close <= open) {
    throw new HistorianOutputError('no JSON object found in the response')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(open, close + 1))
  } catch (error) {
    const imbalance = describeJsonImbalance(text.slice(open, close + 1))
    throw new HistorianOutputError(
      `invalid JSON (${errText(error)})${imbalance === '' ? '' : ` [${imbalance}]`}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new HistorianOutputError('response is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const summary = record.summary
  if (summary === null || typeof summary !== 'object') {
    throw new HistorianOutputError('summary must be an object with p1..p4')
  }
  const tiers = summary as Record<string, unknown>
  const importanceRaw = record.importance
  const importance = typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
    ? Math.min(100, Math.max(0, Math.round(importanceRaw)))
    : importanceRaw === undefined
      ? 50
      : undefined
  if (importance === undefined) throw new HistorianOutputError('importance must be a number when present')
  return {
    tiers: {
      p1: asTier(tiers.p1, 'p1'),
      p2: asTier(tiers.p2, 'p2'),
      p3: asTier(tiers.p3, 'p3'),
      p4: asTier(tiers.p4, 'p4'),
    },
    importance,
    facts: asFactArray(record.facts),
    events: asStringArray(record.events),
    // WP5: absent on every digest written before the field existed, and on any
    // model that follows the instruction by omitting an empty array.
    userObservations: asStringArray(record.userObservations),
  }
}
