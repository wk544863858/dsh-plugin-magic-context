/**
 * The live journal wrapper — why it exists (measured on this adapter):
 *
 * `journal.*` leaves are declared `.volatile()` so the settings form can edit
 * them, but a volatile-only commit NEVER remounts the plugin — and the journal
 * used to be constructed once inside `apply()`, so every form edit saved
 * cleanly and then did nothing until the next app start (the "dead option"
 * audit, 2026-10-10). The wrapper moves the open/close and the knob reads to
 * use time:
 *
 *  - `enabled`: false stops recording immediately; true (re)opens the journal
 *    lazily on the next write.
 *  - `level` / `mirror`: handed to `openJournal` as GETTERS, so an edit
 *    applies to the very next entry (no reopen).
 *  - `retentionDays`: the prune that used to run only at open re-runs the
 *    first time a write observes the configured value changed (floored at 1
 *    day so a stray manual-YAML zero cannot prune the whole table).
 *
 * One asymmetry is deliberate: when the journal is disabled at BOOT the
 * adapter still wires `journal: undefined` (see index.ts) — the maintenance
 * tick treats a missing journal as "do not run", and a boot-time opt-out must
 * keep meaning exactly that. This wrapper only serves compositions that
 * booted with the journal on.
 */
import { join } from 'node:path'
import type { Journal, JournalLevel, JournalStore } from '../core/journal.ts'
import { openJournal } from '../core/journal.ts'
import type { MagicContextDshConfig } from './config.ts'
import { liveBoolean, liveNumber, liveString } from './volatile.ts'
import { errText } from '../core/types.ts'

export interface LiveJournalOptions {
  readonly config: MagicContextDshConfig
  readonly stores: JournalStore
  /** Directory the mirror file lives in (`<storeDir>/activity.log`). */
  readonly storeDir: string
  readonly logger?: { info(message: string): void; warn(message: string): void }
}

export function liveJournal(options: LiveJournalOptions): Journal {
  const { config, stores, storeDir, logger } = options
  const desiredRetention = (): number => Math.max(1, liveNumber(config.journal?.retentionDays, 30))
  let inner: Journal | undefined
  let lastRetention: number | undefined

  /** (Re)open the journal lazily; re-prune when the retention value changed. */
  const ensure = (): Journal => {
    if (inner === undefined) {
      inner = openJournal({
        stores,
        level: () => liveString(config.journal?.level, 'info') as JournalLevel,
        mirrorPath: () => liveBoolean(config.journal?.mirror, true)
          ? join(storeDir, 'activity.log')
          : undefined,
        retentionDays: desiredRetention(),
        logger,
      })
      lastRetention = desiredRetention()
      return inner
    }
    const retention = desiredRetention()
    if (retention !== lastRetention) {
      lastRetention = retention
      try {
        const pruned = stores.pruneJournal(Date.now() - retention * 24 * 60 * 60_000)
        if (pruned > 0) {
          logger?.info(
            `magic-context journal: pruned ${String(pruned)} entries past ${String(retention)}d retention (retention edited at runtime)`,
          )
        }
      } catch (error) {
        logger?.warn(`magic-context journal: retention re-prune failed: ${errText(error)}`)
      }
    }
    return inner
  }

  const record: Journal['record'] = (level, kind, summary, data, sessionId) => {
    if (liveBoolean(config.journal?.enabled, true) === false) return
    ensure().record(level, kind, summary, data, sessionId)
  }

  return {
    get enabled() { return liveBoolean(config.journal?.enabled, true) !== false },
    record,
    info: (kind, summary, data, sessionId) => record('info', kind, summary, data, sessionId),
    warn: (kind, summary, data, sessionId) => record('warn', kind, summary, data, sessionId),
    error: (kind, summary, data, sessionId) => record('error', kind, summary, data, sessionId),
    tail: (limit = 50, sessionId) => inner?.tail(limit, sessionId) ?? [],
    byKind: since => inner?.byKind(since) ?? [],
    get mirrorPath() {
      return liveBoolean(config.journal?.mirror, true) ? join(storeDir, 'activity.log') : undefined
    },
  }
}
