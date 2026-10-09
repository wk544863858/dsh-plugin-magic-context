/**
 * Pressure policy and pass decisions — the DSH spelling of Magic Context's
 * scheduler (execute/defer) and escalation bands. Pure logic over the
 * neutral stores; no DSH imports.
 *
 * Discipline note (load-bearing): landing a durable drop is a priced cache
 * bust in DSH exactly like a wire rewrite is in OpenCode. The execute band
 * (pressure >= threshold, or the cache presumed dead past the TTL) is the
 * one permission under which queued drops land; below it the adapter defers.
 */
import type { UsageRecord } from './types.ts'

export interface PressurePolicy {
  /** Usage percent at or above which a pass may mutate (MC execute threshold). */
  readonly executeThreshold: number
  /** Usage percent at or above which automatic reclaim runs (MC force band). */
  readonly forceThreshold: number
  /**
   * Window assumed when the routed model discloses none, for the pressure
   * decision and everything that reports it. Without a denominator every pass
   * defers 'no-window' and the execute band never opens, so a route that
   * publishes no window must still be scheduled against something.
   * Scheduling only: emergency reclaim keeps the disclosed window
   * (dsh/emergency.ts), and the historian trigger budget keeps its own
   * {@link historianAssumedWindow}.
   */
  readonly assumedContextWindow: number
  /** Idle past this since the last response presumes the provider cache dead (MC cache TTL). */
  readonly ttlMs: number
  /** Newest tool-result tags the reclaim never touches (MC protected tail, count-based MVP). */
  readonly protectedToolResults: number
  /** Newest surface nodes the historian never digests (MC's protected tail). */
  readonly historianProtectedNodes: number
  /** Minimum nodes in an eligible span before a historian call is considered. */
  readonly historianMinNodes: number
  /**
   * Wall-clock budget for one historian run (including its repair attempt).
   * A provider that never settles must not leave the run unaccounted: the
   * historian journals a terminal `failed` when this budget is spent.
   */
  readonly historianTimeoutMs: number
  /** Generation cap for the historian's auxiliary call (the historian floors it at 8192). */
  readonly historianMaxTokens: number
  /** Upper bound the historian may escalate to when a run truncates at the token cap. */
  readonly historianMaxTokensCeiling: number
  /** Window assumed when the routed model discloses none (trigger budget math). */
  readonly historianAssumedWindow: number
  /** Trigger-budget floor in tokens (Magic Context's 5k; tests lower it). */
  readonly historianMinBudgetTokens: number
  /** Soft token cap for the m[0] baseline rendering (MC's memory/compartment budget). */
  readonly baselineTokens: number
  /** Project-memory recall cap (MC's DEFAULT_MEMORY_BUDGET_TOKENS is 8000). */
  readonly memoryBudgetTokens: number
  /** Maximum project memories recalled into the baseline. */
  readonly memoryLimit: number
  /**
   * The compartment publish guard (schema v7): `observe` journals what it
   * WOULD reject, `enforce` acts on the verdicts (supersede a drifted draft,
   * reject a digest that would not shrink the wire), `off` skips the guard.
   * Anything else reads as `observe` — the fail-safe default.
   */
  readonly compartmentGuardMode: 'observe' | 'enforce' | 'off'
  /** Entrant tokens past which a draft's range counts as drifted (0 disables the drift check). */
  readonly compartmentEntrantTokens: number
  /**
   * How long the provider-overflow path may wait on an in-flight historian
   * before falling back to emergency reclaim (0 = never wait — the shipped
   * default; flip after the force-path observation window).
   */
  readonly forceWaitReadyMs: number
}

export const DEFAULT_POLICY: PressurePolicy = {
  executeThreshold: 65,
  forceThreshold: 85,
  assumedContextWindow: 256_000,
  ttlMs: 5 * 60_000,
  protectedToolResults: 8,
  historianProtectedNodes: 8,
  historianMinNodes: 3,
  historianTimeoutMs: 120_000,
  historianMaxTokens: 8192,
  historianMaxTokensCeiling: 32_768,
  historianAssumedWindow: 128_000,
  historianMinBudgetTokens: 5_000,
  baselineTokens: 2000,
  memoryBudgetTokens: 8000,
  memoryLimit: 40,
  compartmentGuardMode: 'observe',
  compartmentEntrantTokens: 200,
  forceWaitReadyMs: 0,
}

/**
 * The request's total input tokens as the provider counts them against the
 * window: the DSH TokenUsage splits input into uncached input plus cache
 * read/write, so pressure must sum all three (MC's OpenCode usage figure is
 * already the total; this is the same quantity reassembled).
 */
export function totalInputTokens(usage: Pick<UsageRecord, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Usage percent against the model's context window, or undefined when unknown. */
export function pressurePercent(
  latest: UsageRecord | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (latest === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  const total = totalInputTokens(latest)
  if (total <= 0) return 0
  return (total / contextWindow) * 100
}

/**
 * The denominator for pressure math: the window the routed model disclosed, or
 * {@link PressurePolicy.assumedContextWindow} when it disclosed none (also for
 * a placeholder 0 or a non-finite reading).
 *
 * Every pressure reader resolves through here, so one number governs the pass
 * decision, its journal row and `/ctx-status`. Callers that need the fact
 * itself — the DSH route window as disclosed — still read `contextWindow`.
 */
export function pressureWindowTokens(
  contextWindow: number | undefined,
  policy: PressurePolicy,
): number {
  return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : policy.assumedContextWindow
}

export type PassDecision =
  | { readonly kind: 'execute'; readonly reason: 'execute-threshold' | 'cache-ttl-expired' | 'wire-repair' }
  | { readonly kind: 'defer'; readonly reason: 'no-usage' | 'no-window' | 'below-threshold' }

/**
 * One pass decision. Mirrors MC's scheduler: execute at the threshold, or
 * when the idle clock (last served response, not last prepared request)
 * passes the cache TTL; otherwise defer.
 *
 * Iron rule: the adapter must never leave the main wire unpairable. A
 * stranded `tool_result` 400s every strict-provider request, so any live
 * wire defect forces the execute band before pressure is even considered.
 */
export function decidePass(args: {
  latest: UsageRecord | undefined
  pressure: number | undefined
  now: number
  policy: PressurePolicy
  /** Live tool/results whose tool_use left the wire (see `wireStrandedResults`). */
  wireDefects?: number
}): PassDecision {
  if ((args.wireDefects ?? 0) > 0) return { kind: 'execute', reason: 'wire-repair' }
  if (args.latest === undefined) return { kind: 'defer', reason: 'no-usage' }
  if (args.pressure === undefined) return { kind: 'defer', reason: 'no-window' }
  if (args.pressure >= args.policy.executeThreshold) return { kind: 'execute', reason: 'execute-threshold' }
  if (args.now - args.latest.recordedAt > args.policy.ttlMs) {
    return { kind: 'execute', reason: 'cache-ttl-expired' }
  }
  return { kind: 'defer', reason: 'below-threshold' }
}

/** Parse MC's drop-range grammar: "3-5,8,12-15" → ascending unique tag numbers. */
export function parseTagRanges(input: string): number[] {
  const tags = new Set<number>()
  for (const part of input.split(',')) {
    const token = part.trim()
    if (token.length === 0) continue
    const range = token.match(/^(\d+)-(\d+)$/)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 10_000) continue
      for (let tag = start; tag <= end; tag++) tags.add(tag)
      continue
    }
    if (/^\d+$/.test(token)) {
      const tag = Number(token)
      if (tag >= 1) tags.add(tag)
    }
  }
  return [...tags].sort((a, b) => a - b)
}
