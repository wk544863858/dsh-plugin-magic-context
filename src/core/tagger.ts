/**
 * §N§ tag allocation and text prefixing — Magic Context's wire format,
 * applied to DSH durable content. Pure logic over the neutral stores;
 * no DSH imports (see src/core/types.ts for the insulation contract).
 */
import type { AdapterStores } from './stores.ts'
import type { TagTarget } from './types.ts'

const TAG_PREFIX_PATTERN = /^§(\d+)§/

export function tagPrefix(tagNumber: number): string {
  return `§${tagNumber}§ `
}

export function isTaggedText(text: string): boolean {
  return TAG_PREFIX_PATTERN.test(text)
}

/** Allocate (idempotently) a tag for one target in one session. */
export function ensureTag(stores: AdapterStores, sessionId: string, target: TagTarget, now = Date.now()): number {
  return stores.allocateTag(sessionId, target, now)
}

/**
 * Prefix the first text-bearing entry of a block list with the tag,
 * inserting a text entry when none exists. Non-text entries pass through.
 * Returns the original reference when nothing changes (already tagged or
 * empty list) so callers can avoid needless copies.
 */
export function prefixTextEntries<T extends { type: string; text?: unknown }>(
  entries: readonly T[],
  tagNumber: number,
): T[] {
  if (entries.length === 0) {
    return [{ type: 'text', text: tagPrefix(tagNumber) } as unknown as T]
  }
  const firstText = entries.findIndex(entry => entry.type === 'text')
  if (firstText === -1) {
    return [{ type: 'text', text: tagPrefix(tagNumber) } as unknown as T, ...entries]
  }
  const original = entries[firstText]
  if (typeof original.text === 'string') {
    if (isTaggedText(original.text)) return entries as unknown as T[]
    const tagged = { ...original, text: `${tagPrefix(tagNumber)}${original.text}` } as T
    return [...entries.slice(0, firstText), tagged, ...entries.slice(firstText + 1)] as unknown as T[]
  }
  return entries as unknown as T[]
}
