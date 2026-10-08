/**
 * The volatile-reference readers and the decision-point policy resolver
 * (moved verbatim out of index.ts so every wiring module reads config the
 * same way). Schemastery's volatile fields arrive as live references; the
 * `live*` helpers unwrap them (recursively — nested objects wrap each level)
 * so a settings-form edit applies without a remount.
 */
import { DEFAULT_POLICY, type PressurePolicy } from '../core/policy.ts'

/** Same as {@link liveNumber} for strings (volatile enums such as log level). */
export function liveString(value: unknown, fallback: string): string {
  const resolved = liveValue(value)
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : fallback
}

/**
 * Unwrap a schemastery volatile reference chain. Nested config objects wrap
 * each level, so `config.a?.b?.c` can hand back a reference whose `.get()`
 * is itself a reference — one dereference is not always enough (measured:
 * `maintenance.verifyProvider` printed `[object Object]` with single unwrap).
 */
export function liveValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return liveValue((value as { get(): unknown }).get())
  }
  return value
}

/** Read a value that may be a plain number or a volatile reference. */
export function liveNumber(value: unknown, fallback: number): number {
  const resolved = liveValue(value)
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback
}

/** Same as {@link liveNumber} for booleans (volatile toggles). */
export function liveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    const current = (value as { get(): unknown }).get()
    if (typeof current === 'boolean') return current
  }
  return fallback
}

/**
 * The effective pressure policy, evaluated AT THE DECISION POINT.
 *
 * This is what makes a settings-form edit take effect without a restart: the
 * form writes a volatile value, the loader commits it into the reference, and
 * the next pass re-reads it here.
 */
export function policyOf(configured: Partial<PressurePolicy> | undefined): PressurePolicy {
  const raw = (configured ?? {}) as Record<string, unknown>
  // Deliberately unannotated: annotating this `PressurePolicy` makes every
  // property below a read-only assignment (45 compile errors) even though the
  // spread already produced a mutable copy. The return type still checks it.
  const policy = { ...DEFAULT_POLICY }
  for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof PressurePolicy>) {
    const value = raw[key]
    if (value === undefined) continue
    const fallback = DEFAULT_POLICY[key]
    if (typeof fallback === 'number') {
      policy[key] = liveNumber(value, fallback) as never
    } else if (typeof fallback === 'boolean') {
      policy[key] = liveBoolean(value, fallback) as never
    } else {
      policy[key] = value as never
    }
  }
  return policy
}
