/**
 * The client's pure functions, pinned under node (no browser, no React).
 *
 * The panel's number/text formatters are its display contract — `compactTok`
 * exists because a bare five-digit token number used to be possible, and the
 * scope bug where `recordOf` referenced a component-scoped helper briefly
 * unmounted the whole pill subtree. These were only assertable through the
 * `__diagnostics` seat against the real bundle; this spec loads the shipped
 * client the same way the records-check script does (module shell + stub
 * React) and pins the formatting rules.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CLIENT = '<path>'

let definition: { factory?: (require: (name: string) => unknown) => Record<string, unknown> } | null = null
const window = { __ModuleLoader__: { load: (def: unknown) => { definition = def as typeof definition } } }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function('window', readFileSync(CLIENT, 'utf8'))(window)
const factory = definition?.factory
if (typeof factory !== 'function') throw new Error('client bundle did not register a module')

const stubReact = {
  createElement: () => null,
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const api = factory((name) => {
  if (name === 'react') return stubReact
  throw new Error('unexpected require: ' + name)
}) as {
  __diagnostics: {
    compactTok: (value: unknown) => string
    fmtInt: (value: unknown) => string
    spanOf: (value: unknown) => string
    timeShort: (value: unknown) => string
    trimSummary: (summary: unknown) => Record<string, unknown>
    recordOf: (event: unknown) => { category: string; text: string } | null
    recordsOf: (rows: readonly unknown[]) => Array<{ category: string; text: string }>
    recordCategories: Record<string, { icon: string; labelKey: string; tone: string }>
    dictionaryKeys: () => { zh: string[]; en: string[] }
  }
}

const { compactTok, fmtInt, spanOf, trimSummary } = api.__diagnostics

describe('compactTok — the one token-scale formatter', () => {
  it('keeps small counts bare, k-scale with one decimal, M-scale likewise', () => {
    expect(compactTok(912)).toBe('912')
    expect(compactTok(1_234)).toBe('1.2k')
    expect(compactTok(125_000)).toBe('125k')
    expect(compactTok(100_000)).toBe('100k')
    expect(compactTok(1_200_000)).toBe('1.2M')
    expect(compactTok(12_000_000)).toBe('12M')
    expect(compactTok(1_000_000)).toBe('1M')
  })
  it('refuses to format a non-number into digits', () => {
    expect(compactTok(undefined)).toBe('')
    expect(compactTok(null)).toBe('')
    expect(compactTok(Number.NaN)).toBe('')
    expect(compactTok('125000')).toBe('')
  })
})

describe('fmtInt — the one counting formatter', () => {
  it('adds thousands separators and never prints decimals', () => {
    expect(fmtInt(912)).toBe('912')
    expect(fmtInt(7_189)).toBe('7,189')
    expect(fmtInt(1_366_348)).toBe('1,366,348')
    expect(fmtInt(42.6)).toBe('43')
  })
  it('refuses non-numbers', () => {
    expect(fmtInt(undefined)).toBe('')
    expect(fmtInt(Number.NaN)).toBe('')
  })
})

describe('spanOf — durations', () => {
  it('ms below one second, one-decimal seconds above', () => {
    expect(spanOf(135)).toBe('135ms')
    expect(spanOf(999.6)).toBe('1000ms')
    expect(spanOf(9_700)).toBe('9.7s')
  })
  it('empty when the Host sent no number', () => {
    expect(spanOf(undefined)).toBe('')
  })
})

describe('recordCategories — the panel table is the single source', () => {
  it('every category the client can emit exists in its own table', () => {
    const rows = [
      { at: 1, level: 'info', kind: 'memory-promote', summary: 'promoted 2 facts', data: { promoted: 2 } },
      { at: 2, level: 'info', kind: 'memory-recall', summary: 'recalled 40 project memories', data: { rows: 40 } },
      { at: 3, level: 'info', kind: 'compartment-published', summary: 'published §C1§', data: { id: 'C1' } },
      { at: 4, level: 'info', kind: 'baseline', summary: 'baseline HARD rebuild (epoch 3)', data: { mode: 'hard', epoch: 3 } },
      { at: 5, level: 'warn', kind: 'emergency-reclaim', summary: 'emergency reclaim', data: { dropped: 3 } },
      { at: 6, level: 'error', kind: 'historian', summary: 'historian run failed (invalid-output)', data: { phase: 'failed', kind: 'invalid-output', reason: 'x' } },
      { at: 7, level: 'info', kind: 'maintenance', summary: 'maintenance: expired 0 · verified 1', data: { verified: 1 } },
      { at: 8, level: 'warn', kind: 'maintenance', summary: 'maintenance: verify call failed', data: {} },
      { at: 9, level: 'info', kind: 'tool-call', summary: 'ctx_memory', data: { action: 'write' } },
      { at: 10, level: 'info', kind: 'drop-landed', summary: 'landed 3 drop(s)', data: { count: 3 } },
      { at: 11, level: 'error', kind: 'error', summary: 'boom', data: {} },
    ]
    const { recordsOf, recordCategories, dictionaryKeys } = api.__diagnostics
    const records = recordsOf(rows)
    expect(records.length).toBeGreaterThan(4)
    for (const record of records) {
      // The records-check script used to keep a hand-copied table; it drifted
      // when `maintain` was added and crashed on a category it did not know.
      expect(Object.keys(recordCategories)).toContain(record.category)
    }
    // The seven shipped roles, each renderable (icon + a label the zh dictionary knows).
    for (const role of ['write', 'read', 'reclaim', 'drop', 'maintain', 'archive', 'error']) {
      expect(Object.keys(recordCategories)).toContain(role)
    }
    const zhKeys = dictionaryKeys().zh
    for (const entry of Object.values(recordCategories)) {
      expect(typeof entry.icon).toBe('string')
      expect(zhKeys).toContain(entry.labelKey)
    }
  })
})

describe('trimSummary — the badge whitelist', () => {
  it('passes the acted-on numbers through the num() gate', () => {
    const trimmed = trimSummary({
      scope: 'session',
      adapter: { schemaVersion: 6, engine: 'mc', toolsMode: 'rw' },
      project: { identity: 'git:93eea8cdeebd2eb57f476137abf32fa0c42cd3f5', memories: 42 },
      health: {
        journalRows: 10,
        errorsSinceBoot: 0,
        lastPressure: 26,
        lastTokens: 103_000,
        lastContextWindow: 400_000,
        memoryStats: { verified: 34, unverified: 7 },
        maintenanceLast: { at: 1, expired: 0, verified: 3, updated: 0, archived: 0 },
      },
    })
    expect(trimmed.scope).toBe('session')
    // The shipped Host half names it toolsMode (contract sketch said tools).
    expect(trimmed.tools).toBe('rw')
    expect(trimmed.errorsSinceBoot).toBe(0)
    expect(trimmed.lastPressure).toBe(26)
    expect(trimmed.lastTokens).toBe(103_000)
    expect(trimmed.projectMemories).toBe(42)
    expect(trimmed.memoryStats).toEqual({ verified: 34, unverified: 7 })
    expect(trimmed.maintenanceLast).toMatchObject({ verified: 3 })
    expect(typeof trimmed.projectIdentity).toBe('string')
    expect((trimmed.projectIdentity as string).length).toBeGreaterThan(0)
  })

  it('defaults the scope and drops non-numeric noise instead of rendering it', () => {
    const trimmed = trimSummary({
      health: { lastPressure: '26%', errorsSinceBoot: null, memoryStats: 'garbage' },
    })
    expect(trimmed.scope).toBe('global')
    expect(trimmed.engine).toBe('unknown')
    // A string pressure must NOT render as a percentage of nothing.
    expect(trimmed.lastPressure).toBeUndefined()
    // errorsSinceBoot is a raw passthrough (the red-pill reader) — null stays null.
    expect(trimmed.errorsSinceBoot).toBeNull()
    expect(trimmed.memoryStats).toBeUndefined()
  })
})
