/**
 * §N§ tag allocation — Magic Context's wire format, applied to DSH durable
 * content. Pure logic over the neutral stores; no DSH imports (see
 * src/core/types.ts for the insulation contract). Prefixing itself lives in
 * seams.ts (`tagUserMessage`/`tagToolResultContent`).
 */
import type { AdapterStores } from './stores.ts'
import type { TagTarget } from './types.ts'

export function tagPrefix(tagNumber: number): string {
  return `§${tagNumber}§ `
}

/** Allocate (idempotently) a tag for one target in one session. */
export function ensureTag(stores: AdapterStores, sessionId: string, target: TagTarget, now = Date.now()): number {
  return stores.allocateTag(sessionId, target, now)
}
