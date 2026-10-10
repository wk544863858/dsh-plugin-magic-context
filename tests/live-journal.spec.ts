/**
 * The live journal wrapper — the fix for the "dead option" audit (2026-10-10):
 * `journal.*` leaves are volatile, and a volatile-only settings commit never
 * remounts the plugin, so the journal's construction knobs must be read at
 * WRITE time or every settings-form edit is a saved no-op until restart.
 *
 * Each test drives the wrapper with mutable references — the shape schemastery
 * hands to `apply()` — and flips them mid-run exactly like a form save does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import mcDshPlugin, { openStores } from '../src/index.ts'
import { liveJournal } from '../src/dsh/live-journal.ts'
import type { Journal } from '../src/core/journal.ts'
import type { MagicContextDshConfig } from '../src/dsh/config.ts'

void mcDshPlugin

/** A mutable volatile reference, the shape schemastery hands to apply(). */
function ref<T>(initial: T): { get(): T; set(value: T): void } {
  let current = initial
  return {
    get: () => current,
    set: value => { current = value },
  }
}

function boot(config: MagicContextDshConfig): { journal: Journal; storeDir: string; cleanup: () => void } {
  const storeDir = mkdtempSync(join(tmpdir(), 'mc-live-journal-'))
  const stores = openStores(storeDir)
  const journal = liveJournal({ config, stores, storeDir })
  return { journal, storeDir, cleanup: () => {
    stores.close()
    rmSync(storeDir, { recursive: true, force: true })
  } }
}

describe('live journal', () => {
  it('applies a level edit to the very next write', () => {
    const level = ref('info')
    const { journal, cleanup } = boot({ journal: { level: level as unknown as string } })
    try {
      journal.info('pass', 'kept at info')
      level.set('warn')
      journal.info('pass', 'dropped after the edit')
      journal.warn('error', 'kept as warn')
      const rows = journal.tail(10)
      // tail() is newest-first.
      expect(rows.map(row => row.summary)).toEqual(['kept as warn', 'kept at info'])
    } finally {
      cleanup()
    }
  })

  it('toggles the mirror without a reopen', () => {
    const mirror = ref(true)
    const { journal, storeDir, cleanup } = boot({ journal: { mirror: mirror as unknown as boolean } })
    const mirrorPath = join(storeDir, 'activity.log')
    try {
      journal.warn('error', 'mirrored line')
      expect(existsSync(mirrorPath)).toBe(true)
      expect(readFileSync(mirrorPath, 'utf8')).toContain('mirrored line')
      mirror.set(false)
      expect(journal.mirrorPath).toBeUndefined()
      journal.warn('error', 'db-only line')
      expect(readFileSync(mirrorPath, 'utf8')).not.toContain('db-only line')
      expect(journal.tail(10).map(row => row.summary)).toContain('db-only line')
      mirror.set(true)
      journal.warn('error', 'back on')
      expect(readFileSync(mirrorPath, 'utf8')).toContain('back on')
    } finally {
      cleanup()
    }
  })

  it('re-prunes when the retention value changes at runtime', () => {
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60_000
    const retention = ref(60)
    const storeDir = mkdtempSync(join(tmpdir(), 'mc-live-journal-'))
    const stores = openStores(storeDir)
    try {
      stores.appendJournal({
        at: fortyDaysAgo,
        level: 'info',
        kind: 'pass',
        summary: 'old row',
      })
      const journal = liveJournal({
        config: { journal: { retentionDays: retention as unknown as number } },
        stores,
        storeDir,
      })
      // Opens with 60d retention: the 40d-old row survives the open prune.
      journal.info('pass', 'first write')
      expect(journal.tail(10).map(row => row.summary)).toContain('old row')
      // A form edit to 30d: the next write observes the change and re-prunes.
      retention.set(30)
      journal.info('pass', 'second write')
      expect(journal.tail(10).map(row => row.summary)).not.toContain('old row')
    } finally {
      stores.close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('stops and resumes recording as `enabled` flips', () => {
    const enabled = ref(true)
    const { journal, cleanup } = boot({ journal: { enabled: enabled as unknown as boolean } })
    try {
      journal.info('pass', 'while on')
      expect(journal.enabled).toBe(true)
      enabled.set(false)
      expect(journal.enabled).toBe(false)
      journal.warn('error', 'while off')
      enabled.set(true)
      journal.info('pass', 'back on')
      expect(journal.tail(10).map(row => row.summary)).toEqual(['back on', 'while on'])
    } finally {
      cleanup()
    }
  })

  it('floors a stray retention below 1 day instead of pruning everything', () => {
    // A hand-edited patch can bypass the schema's min(1); the wrapper must
    // still refuse to prune with a future cutoff.
    const retention = ref(0)
    const { journal, cleanup } = boot({ journal: { retentionDays: retention as unknown as number } })
    try {
      journal.info('pass', 'survives a zero retention')
      expect(journal.tail(10).map(row => row.summary)).toEqual(['survives a zero retention'])
    } finally {
      cleanup()
    }
  })
})
