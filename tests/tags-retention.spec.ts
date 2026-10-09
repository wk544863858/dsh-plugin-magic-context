/**
 * §N§ tag registry retention: the tags table is the adapter's only
 * unbounded-growth table (one row per tagged target). Mount-time pruning must
 * remove rows past the cutoff, keep the per-session counter monotonic (a
 * re-tag after pruning still gets a fresh number), and leave unrelated tables
 * (pending_drops, journal) untouched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'

describe('tag registry retention', () => {
  it('prunes rows past the cutoff without breaking tag allocation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-tags-retention-'))
    const stores = openStores(dataDir)
    try {
      const now = Date.now()
      const day = 24 * 60 * 60 * 1000

      const old1 = stores.allocateTag('session-a', { kind: 'tool-result', callId: 'call-old-1' }, now - 40 * day)
      const old2 = stores.allocateTag('session-a', { kind: 'tool-result', callId: 'call-old-2' }, now - 35 * day)
      const fresh = stores.allocateTag('session-a', { kind: 'tool-result', callId: 'call-fresh' }, now - 1 * day)
      expect(old1).toBe(1)
      expect(old2).toBe(2)
      expect(fresh).toBe(3)
      stores.queueDrop('session-a', 2, now)

      const pruned = stores.pruneTags(now - 30 * day)
      expect(pruned).toBe(2)

      // the recent row survives; a pruned target can be re-tagged with a fresh number
      expect(stores.getTag('session-a', { kind: 'tool-result', callId: 'call-fresh' })).toBe(3)
      expect(stores.getTag('session-a', { kind: 'tool-result', callId: 'call-old-1' })).toBeUndefined()
      expect(stores.allocateTag('session-a', { kind: 'tool-result', callId: 'call-old-1' }, now)).toBe(4)

      // other sessions keep their own counter; pending_drops rows survive the prune
      expect(stores.allocateTag('session-b', { kind: 'tool-result', callId: 'call-x' }, now)).toBe(1)
      expect(stores.listPendingDrops('session-a')).toEqual([2])

      // pruning again at the same cutoff is a no-op
      expect(stores.pruneTags(now - 30 * day)).toBe(0)
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps user-message rows under the same retention rule', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-tags-retention-user-'))
    const stores = openStores(dataDir)
    try {
      const now = Date.now()
      const day = 24 * 60 * 60 * 1000
      stores.allocateTag('session-a', { kind: 'user-message', messageId: 'm-old' }, now - 60 * day)
      stores.allocateTag('session-a', { kind: 'user-message', messageId: 'm-new' }, now)
      expect(stores.pruneTags(now - 30 * day)).toBe(1)
      expect(stores.getTag('session-a', { kind: 'user-message', messageId: 'm-old' })).toBeUndefined()
      expect(stores.getTag('session-a', { kind: 'user-message', messageId: 'm-new' })).toBe(2)
    } finally {
      stores.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
