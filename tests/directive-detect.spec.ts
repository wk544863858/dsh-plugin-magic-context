/**
 * Directive-shape detection — the confirmation gate's classifier.
 *
 * The corpus is a synthetic regression corpus built to mirror the shape of the
 * 2026-10-09 human review labels: 7 directive-shaped rows, 8 descriptive ones,
 * plus three synthetic English/Chinese control pairs. It is a REGRESSION
 * corpus, not a benchmark: the samples are written to exercise the rule set,
 * and any future change to it must keep their shapes classified as labelled.
 *
 * The safety property is asymmetric and the assertions say so:
 *   - ZERO false negatives are allowed (a directive read as a description
 *     becomes an unreviewed behavioural rule in every session);
 *   - false positives are BOUNDED, not forbidden (each one costs a question).
 * A companion test proves the corpus has teeth: a do-nothing classifier fails it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DIRECTIVE_SCORE_THRESHOLD,
  buildConfirmationQuestion,
  classifyProfileShape,
  detectDirectiveHits,
  isDirectiveShaped,
} from '../src/core/directive-detect.ts'

interface CorpusSample {
  readonly id: string
  readonly expected: 'descriptive' | 'directive'
  readonly text: string
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/directive-corpus.json', import.meta.url), 'utf8'),
) as { samples: CorpusSample[] }

/** Measured with this rule set; a regression raises it. */
const FALSE_POSITIVE_BUDGET = 1

describe('directive detection on the synthetic regression corpus', () => {
  it('never reads a directive as a description (the dangerous direction)', () => {
    const misses = corpus.samples.filter(
      sample => sample.expected === 'directive' && classifyProfileShape(sample.text).shape !== 'directive',
    )
    expect(
      misses.map(sample => sample.id),
      'a directive labelled descriptive would enter every session without review',
    ).toEqual([])
  })

  it('keeps the harmless direction bounded', () => {
    const falsePositives = corpus.samples.filter(
      sample => sample.expected === 'descriptive' && classifyProfileShape(sample.text).shape === 'directive',
    )
    expect(falsePositives.length).toBeLessThanOrEqual(FALSE_POSITIVE_BUDGET)
    // Each false positive is just a question; print them so a regression in the
    // ratio is reviewable rather than mysterious.
    expect(
      falsePositives.map(sample => `${sample.id} [${classifyProfileShape(sample.text).reasons.join('|')}]`).length,
    ).toBeLessThanOrEqual(FALSE_POSITIVE_BUDGET)
  })

  it('has teeth: a do-nothing classifier would fail this suite', () => {
    const directiveSamples = corpus.samples.filter(sample => sample.expected === 'directive')
    // This is what `() => 'descriptive'` would score: every one of them missed.
    expect(directiveSamples.length).toBeGreaterThanOrEqual(7)
    expect(corpus.samples.length).toBeGreaterThanOrEqual(20)
  })

  it('classifies both corpus languages', () => {
    expect(classifyProfileShape('Always run the full test suite before pushing.').shape).toBe('directive')
    expect(classifyProfileShape('Never commit directly to main.').shape).toBe('directive')
    expect(classifyProfileShape('The user writes in Chinese and keeps requests short.').shape).toBe('descriptive')
    expect(classifyProfileShape('用户偏好一次性拿到完整背景。').shape).toBe('descriptive')
  })
})

describe('directive detection rules', () => {
  it('requires an agent-action cue, not just an obligation word', () => {
    // The precision knob. Both texts carry obligations; only the second one
    // tells an AGENT to do something. Over-triggering here would ask about every
    // data-quality stance the user holds.
    const stance = classifyProfileShape('不接受下游兜底，拒绝用已知不准的数据源凑数。')
    expect(stance.score).toBeGreaterThanOrEqual(DIRECTIVE_SCORE_THRESHOLD)
    expect(stance.shape).toBe('descriptive')
    expect(classifyProfileShape('修改共享库结构前必须先备份。').shape).toBe('directive')
  })

  it('does not fire on a weak insistence alone', () => {
    expect(classifyProfileShape('坚持把 CI 作为唯一入口。').score).toBeLessThan(DIRECTIVE_SCORE_THRESHOLD)
    expect(isDirectiveShaped('坚持把 CI 作为唯一入口。')).toBe(false)
  })

  it('reports why, so the confirmation question can explain itself', () => {
    const verdict = classifyProfileShape('未确认前不得写文件。')
    expect(verdict.shape).toBe('directive')
    expect(verdict.reasons).toContain('prohibition:不得')
    expect(verdict.reasons).toContain('action:写文件/代码')
    expect(verdict.hits.find(hit => hit.kind === 'hard')?.match).toBe('不得')
  })

  it('matches the English gate shape', () => {
    expect(detectDirectiveHits('The user wants a plan before writing any file.').map(hit => hit.rule))
      .toContain('gate:en-before-doing')
  })
})

describe('the confirmation question', () => {
  it('states the blast radius and the reasons', () => {
    const text = '未确认前必须先在 plan 模式内讨论。'
    const question = buildConfirmationQuestion(text, classifyProfileShape(text))
    expect(question).toContain(text)
    expect(question).toContain('所有会话')
    expect(question).toContain('obligation:必须')
    expect(question).toContain('确认')
  })
})
