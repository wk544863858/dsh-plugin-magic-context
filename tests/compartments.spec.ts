/**
 * Compartment contract units: the historian's output validation, the tier
 * ladder, and the m[0]/m[1] baseline rendering (no DSH, no SQLite).
 */
import { describe, expect, it } from 'vitest'
import {
  BASELINE_CLOSE,
  BASELINE_OPEN,
  findBaselineRange,
  parseHistorianOutput,
  renderBaseline,
  selectTier,
  stripBaseline,
  type Compartment,
} from '<path>'

const VALID = JSON.stringify({
  summary: { p1: 'full detail', p2: 'essentials', p3: 'terse', p4: 'gist' },
  importance: 72,
  facts: [{ category: 'CONSTRAINTS', content: 'fact one' }],
  events: ['tried X'],
})

function compartment(overrides: Partial<Compartment> = {}): Compartment {
  return {
    sessionId: 's1',
    compartmentId: 1,
    createdAt: 0,
    coveredStartSeq: 1,
    coveredEndSeq: 4,
    coveredSeqs: [1, 2, 4],
    coveredTokens: 100,
    importance: 50,
    tiers: { p1: 'P1 body', p2: 'P2 body', p3: 'P3 body', p4: 'P4 body' },
    facts: [],
    events: [],
    baselineEpoch: 1,
    ...overrides,
  }
}

describe('historian output contract', () => {
  it('accepts a valid digest, including JSON wrapped in prose', () => {
    const draft = parseHistorianOutput(`here you go:\n${VALID}\nthanks`)
    expect(draft.tiers.p1).toBe('full detail')
    expect(draft.importance).toBe(72)
    // Magic Context's promotable shape: every fact carries a category.
    expect(draft.facts).toEqual([{ category: 'CONSTRAINTS', content: 'fact one' }])
    expect(draft.events).toEqual(['tried X'])
  })

  it('tolerates legacy plain-string and unknown-category facts without failing the run', () => {
    // A model that ignores the instruction must not lose the whole digest.
    const draft = parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' },
      facts: ['legacy plain string', { category: 'MADE_UP', content: 'unknown category' }, { content: 'no category' }],
    }))
    expect(draft.facts).toEqual([
      { category: '', content: 'legacy plain string' },
      { category: 'MADE_UP', content: 'unknown category' },
      { category: '', content: 'no category' },
    ])
  })

  it('fails closed on every contract violation', () => {
    expect(() => parseHistorianOutput('no json here')).toThrow(/no JSON object/)
    expect(() => parseHistorianOutput('{ not json }')).toThrow(/invalid JSON/)
    expect(() => parseHistorianOutput(JSON.stringify({ summary: { p1: 'a' }, importance: 1 })))
      .toThrow(/summary\.p2/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: '   ' },
    }))).toThrow(/summary\.p4/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, facts: 'nope',
    }))).toThrow(/facts must be an array/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, events: 'nope',
    }))).toThrow(/must be arrays/)
  })

  it('clamps importance and defaults it to 50', () => {
    const clamped = parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, importance: 250,
    }))
    expect(clamped.importance).toBe(100)
    const defaulted = parseHistorianOutput(JSON.stringify({ summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' } }))
    expect(defaulted.importance).toBe(50)
    expect(defaulted.facts).toEqual([])
  })
})

describe('tier ladder', () => {
  it('degrades by age and promotes/demotes by importance', () => {
    const minute = 60_000
    expect(selectTier(50, 5 * minute)).toBe('p1')
    expect(selectTier(50, 60 * minute)).toBe('p2')
    expect(selectTier(50, 5 * 60 * minute)).toBe('p3')
    expect(selectTier(50, 48 * 60 * minute)).toBe('p4')
    // importance promotes one step, never beyond p1
    expect(selectTier(90, 60 * minute)).toBe('p1')
    expect(selectTier(90, 48 * 60 * minute)).toBe('p3')
    // low importance demotes one step, never beyond p4
    expect(selectTier(10, 5 * minute)).toBe('p2')
    expect(selectTier(10, 48 * 60 * minute)).toBe('p4')
  })
})

describe('baseline rendering', () => {
  it('renders memories, the frozen baseline and the delta', () => {
    const block = renderBaseline({
      now: 1000,
      baseline: [compartment({ compartmentId: 1 })],
      delta: [compartment({ compartmentId: 2, createdAt: 500, importance: 90, tiers: { p1: 'FRESH', p2: 'b', p3: 'c', p4: 'd' } })],
      memories: ['- [CONSTRAINTS] never commit secrets'],
      budgetTokens: 5000,
    })
    expect(block.startsWith(BASELINE_OPEN)).toBe(true)
    expect(block.endsWith(BASELINE_CLOSE)).toBe(true)
    expect(block).toContain('<project-memories>')
    expect(block).toContain('never commit secrets')
    expect(block).toContain('<compartment-baseline>')
    expect(block).toContain('§C1§')
    expect(block).toContain('<compartment-delta>')
    expect(block).toContain('FRESH')
  })

  it('compresses older baseline compartments to p4 when the budget is tight', () => {
    const block = renderBaseline({
      now: 1000,
      baseline: [compartment({ compartmentId: 1, tiers: { p1: 'A'.repeat(400), p2: 'b', p3: 'c', p4: 'p4-only' } })],
      delta: [],
      memories: [],
      budgetTokens: 40,
    })
    expect(block).toContain('p4-only')
    expect(block).not.toContain('A'.repeat(400))
  })

  it('returns an empty block when there is nothing to inject', () => {
    expect(renderBaseline({ now: 0, baseline: [], delta: [], memories: [], budgetTokens: 10 })).toBe('')
  })

  it('round-trips the baseline block through strip/find', () => {
    const text = `${BASELINE_OPEN}\n<compartment-delta>\n§C9§ hi\n</compartment-delta>\n${BASELINE_CLOSE}\n\n§1§ user words`
    const range = findBaselineRange(text)
    expect(range).toBeDefined()
    expect(text.slice(range!.start, range!.end)).toContain('§C9§')
    expect(stripBaseline(text)).toBe('§1§ user words')
    expect(stripBaseline('no baseline here')).toBe('no baseline here')
  })
})
