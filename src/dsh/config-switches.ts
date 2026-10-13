/**
 * The effective feature-switch snapshot and its drift alarm (2026-10-12).
 *
 * The incident that motivated this: the Desktop profile's `config` block is
 * REPLACE semantics, and a rewrite silently dropped three keys — the switches
 * fell back to their defaults with no error row anywhere, discovered ~12 hours
 * later by inference. Two defenses live here:
 *
 *  1. {@link buildSwitchSnapshot} — every behavior-relevant switch with its
 *     EFFECTIVE value (default applied), written into each `boot` journal row
 *     so "what is on right now" is one query away and needs no profile parse.
 *  2. {@link diffSwitches} — classify the movement between the previous
 *     mount's snapshot and this one. A `went-off` row is the alarm: the switch
 *     that used to be on is now off, which is exactly the shape the incident
 *     produced and nothing else in the journal reports it.
 *
 * The previous snapshot persists in the adapter store's `meta` table (key
 * `switch_snapshot`), written by index.ts at mount BEFORE the boot row — so
 * the first mount only seeds, and every later mount can diff.
 */
import type { MagicContextDshConfig } from './config.ts'
import { liveBoolean, liveNumber, liveString } from './volatile.ts'
import { vectorBackfillEnabled } from './maintenance-wiring.ts'

/** Every tracked switch. Booleans alarm on `went-off`; the rest report changes. */
export const SWITCH_KEYS = [
  'write',
  'autoPromote',
  'embedBackfill',
  'vectorBackfill',
  'scoring',
  'userRender',
  'userCollect',
  'userReview',
  'machine',
  'machineAutoStage',
  'guardMode',
  'forceWaitMs',
] as const

export type SwitchKey = (typeof SWITCH_KEYS)[number]
export type SwitchSnapshot = Record<SwitchKey, boolean | string | number>

/** The effective switch values for THIS mount, defaults already applied. */
export function buildSwitchSnapshot(config: MagicContextDshConfig): SwitchSnapshot {
  return {
    write: liveBoolean(config.memory?.write, true),
    autoPromote: liveBoolean(config.memory?.autoPromote, true),
    embedBackfill: liveBoolean(config.memory?.embedBackfill, true),
    vectorBackfill: vectorBackfillEnabled(config.memory),
    scoring: liveBoolean(config.memory?.scoring?.enabled, true),
    userRender: liveBoolean(config.memory?.global?.user?.render, true),
    userCollect: liveBoolean(config.memory?.global?.user?.collect, true),
    userReview: liveBoolean(config.memory?.global?.user?.review, true),
    machine: liveBoolean(config.memory?.global?.machine?.enabled, true),
    machineAutoStage: liveBoolean(config.memory?.global?.machine?.autoStage, true),
    // liveString/liveNumber unwrap schemastery volatile references — a raw
    // read serialized the reference object into the boot row (measured 12:31:
    // guardMode arrived as {"get":"[depth]"}).
    guardMode: liveString(config.policy?.compartmentGuardMode, 'observe'),
    forceWaitMs: liveNumber(config.policy?.forceWaitReadyMs, 0),
  }
}

export interface SwitchDiffRow {
  readonly key: SwitchKey
  readonly before: boolean | string | number
  readonly after: boolean | string | number
  /**
   * `went-off` is the alarm (journal warn): a switch the previous mount had ON
   * is now off — either a deliberate operator decision or a dropped key, and
   * the journal line is what makes the difference discoverable the moment it
   * happens instead of hours later. `came-on`/`changed` are info-level.
   */
  readonly severity: 'went-off' | 'came-on' | 'changed'
}

/** Classify the movement between two snapshots; identical values produce no rows. */
export function diffSwitches(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SwitchDiffRow[] {
  const rows: SwitchDiffRow[] = []
  for (const key of SWITCH_KEYS) {
    // Snapshot values are only boolean | string | number by construction.
    const was = before[key] as boolean | string | number | undefined
    const now = after[key] as boolean | string | number | undefined
    if (was === undefined || now === undefined || was === now) continue
    if (typeof was === 'boolean' && typeof now === 'boolean') {
      rows.push({ key, before: was, after: now, severity: was && !now ? 'went-off' : 'came-on' })
    } else {
      rows.push({ key, before: was, after: now, severity: 'changed' })
    }
  }
  return rows
}

/** The meta-table key holding the JSON snapshot of the previous mount. */
export const SWITCH_SNAPSHOT_META_KEY = 'switch_snapshot'
