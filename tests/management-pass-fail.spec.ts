/**
 * Management-pass diagnosability (test-design audit P1-3): a management pass
 * that throws must (a) fail open — the turn continues with the tagged
 * messages — and (b) land a terminal journal row carrying WHY. Before this
 * was pinned, the catch only wrote a logger line: a run of silent failures
 * (the class that let the historian spin with 127 start rows and no terminal
 * for weeks) would have been invisible in the journal.
 *
 * Faults are injected at two stages to prove the outer catch sees them all:
 * the queued-drops scan (step 1) and compartment publishing (step 2+4).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'

interface Recorded {
  level: string
  kind: string
  summary: string
  data: unknown
}

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: unknown) => {
    entries.push({ level, kind, summary, data })
  }
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Journal
}

/** An empty surface: the enumerators see nothing, so step 1 is a no-op. */
const emptySession = {
  snapshotEvents: () => [],
  surface: { nodes: [], replaceGeneration: 0 },
} as unknown as Parameters<typeof runManagementPass>[0]['session']

const silentLogger = {
  warnings: [] as string[],
  info: () => {},
  warn: (message: string) => { silentLogger.warnings.push(message) },
}

function baseStores(extra: Record<string, unknown>): AdapterStores {
  return { listPendingDrops: () => [], ...extra } as unknown as AdapterStores
}

function boot(stores: AdapterStores, entries: Recorded[]) {
  return runManagementPass({
    session: emptySession,
    sessionId: 'mc-pass-fail',
    stores,
    policy: DEFAULT_POLICY,
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 42.5,
    journal: recordingJournal(entries),
  })
}

describe('a management pass that throws fails open AND journals why', () => {
  it('fault in the queued-drops scan: fail-open + one terminal error row', () => {
    const entries: Recorded[] = []
    const result = boot(baseStores({
      listPendingDrops: () => { throw new Error('store closed mid-pass') },
    }), entries)

    // Fail-open: the pass reports nothing done, but returns.
    expect(result.published).toEqual([])
    expect(result.landedDrops).toEqual([])
    expect(result.baselineUpdated).toBe(false)
    expect(result.historianStarted).toBe(false)
    expect(silentLogger.warnings.some(w => w.includes('management pass failed (continuing)'))).toBe(true)

    // Diagnosable: exactly one terminal journal row, with the why attached.
    const errors = entries.filter(entry => entry.level === 'error')
    expect(errors.length).toBe(1)
    expect(errors[0]!.kind).toBe('error')
    const data = errors[0]!.data as { scope?: string; detail?: string; errorName?: string; trigger?: string; pressure?: number }
    expect(data.scope).toBe('management-pass')
    expect(data.detail).toContain('store closed mid-pass')
    expect(data.errorName).toBe('Error')
    expect(data.trigger).toBe('execute-threshold')
    expect(data.pressure).toBe(42.5)
  })

  it('fault in compartment publishing (a later stage): same terminal shape', () => {
    const entries: Recorded[] = []
    const result = boot(baseStores({
      baselineState: () => undefined,
      listUnlandedCompartments: () => { throw new Error('mutation log unreadable') },
    }), entries)

    expect(result.published).toEqual([])
    const errors = entries.filter(entry => entry.level === 'error')
    expect(errors.length).toBe(1)
    const data = errors[0]!.data as { scope?: string; detail?: string }
    expect(data.scope).toBe('management-pass')
    expect(data.detail).toContain('mutation log unreadable')
  })

  it('a healthy pass journals no error rows', () => {
    const entries: Recorded[] = []
    const result = boot(baseStores({
      baselineState: () => undefined,
      listUnlandedCompartments: () => [],
      listCompartments: () => [],
      markCompartmentLanded: () => {},
      setBaselineState: () => {},
    }), entries)
    expect(result.published).toEqual([])
    expect(entries.filter(entry => entry.level === 'error').length).toBe(0)
  })
})
