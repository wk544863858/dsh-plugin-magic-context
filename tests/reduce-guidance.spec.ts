/**
 * Reduce guidance — the ported MC prompting (magic-context-prompt.ts +
 * ctx-reduce-nudge.ts): desk section, Channel 1/2 bands with their exact
 * thresholds, reminder copy, sticky refire, and the message helpers the
 * preStep/SystemPrompt wiring uses.
 */
import { describe, expect, it } from 'vitest'
import { injectReduceGuidance, type PreStepDeps } from '../src/dsh/pre-step.ts'
import {
  appendToLastText,
  buildChannel1Reminder,
  buildChannel2Reminder,
  buildDeskSection,
  decideReduceNudge,
  messageHasDeskSection,
  ReduceNudgeTracker,
} from '../src/dsh/reduce-guidance.ts'

describe('nudgeBand — exact MC thresholds', () => {
  it('stays quiet below the 60k tail / 25k undropped floors', () => {
    expect(decideReduceNudge({ tailToolTokens: 59_999, undroppedTokens: 59_999, realUserTurnCount: 10 }).band).toBe('quiet')
    expect(decideReduceNudge({ tailToolTokens: 100_000, undroppedTokens: 24_999, realUserTurnCount: 10 }).band).toBe('quiet')
  })

  it('ladders gentle/firm/urgent at 20/40/60 percent of the tail', () => {
    const decide = (undropped: number) => decideReduceNudge({ tailToolTokens: 100_000, undroppedTokens: undropped, realUserTurnCount: 10 }).band
    expect(decide(25_000)).toBe('gentle') // 25% ≥ 20%
    expect(decide(50_000)).toBe('firm') // 50% ≥ 40%
    expect(decide(70_000)).toBe('urgent') // 70% ≥ 60%
  })

  it('escalates to channel2 at ≥75% severity and ≥50k undropped', () => {
    expect(decideReduceNudge({ tailToolTokens: 100_000, undroppedTokens: 74_999, realUserTurnCount: 10 }).band).toBe('urgent')
    expect(decideReduceNudge({ tailToolTokens: 100_000, undroppedTokens: 75_000, realUserTurnCount: 10 }).band).toBe('channel2')
    // severity ≥75% but below the 50k absolute floor stays urgent
    expect(decideReduceNudge({ tailToolTokens: 60_000, undroppedTokens: 49_000, realUserTurnCount: 10 }).band).toBe('urgent')
  })
})

describe('decideReduceNudge — refire rules', () => {
  it('fires on the first crossing, holds same-band for 5 user turns, then refires', () => {
    const base = { tailToolTokens: 100_000, undroppedTokens: 30_000 } // 30% → gentle
    const first = decideReduceNudge({ ...base, realUserTurnCount: 3 })
    expect(first.fire).toBe(true)
    expect(first.level).toBe('gentle')
    expect(first.ordinal).toBe(1)

    // same band, 2 turns later → sticky hold (no fire)
    const held = decideReduceNudge({ ...base, realUserTurnCount: 5, lastBand: 'gentle', lastOrdinal: 1, lastOrdinalTurn: 3 })
    expect(held.fire).toBe(false)
    expect(held.sticky).toBe(true)

    // same band, 5 user turns later → refire (sticky copy)
    const refired = decideReduceNudge({ ...base, realUserTurnCount: 8, lastBand: 'gentle', lastOrdinal: 1, lastOrdinalTurn: 3 })
    expect(refired.fire).toBe(true)
    expect(refired.sticky).toBe(true)
    expect(refired.ordinal).toBe(2)
  })

  it('escalates immediately when the band advances', () => {
    const next = decideReduceNudge({ tailToolTokens: 100_000, undroppedTokens: 70_000, realUserTurnCount: 4, lastBand: 'gentle', lastOrdinal: 1, lastOrdinalTurn: 3 })
    expect(next.band).toBe('urgent')
    expect(next.fire).toBe(true)
    expect(next.sticky).toBe(false)
  })
})

describe('reminder copy — MC texts', () => {
  it('renders the three channel1 levels and the sticky variant', () => {
    expect(buildChannel1Reminder('gentle', 87_000, 5)).toContain('Housekeeping: 5 spent tool outputs (~87k tokens) are reclaimable')
    expect(buildChannel1Reminder('firm', 87_000, 5)).toContain('Make a ctx_reduce pass now')
    expect(buildChannel1Reminder('urgent', 87_000, 5)).toContain('Call ctx_reduce now, before your next tool call')
    expect(buildChannel1Reminder('gentle', 87_000, 5, undefined, true)).toContain('Still unstamped:')
  })

  it('appends the oldest-tag hint and renders channel2 as an imperative', () => {
    const hint = buildChannel1Reminder('gentle', 87_000, 5, [{ tagNumber: 10 }, { tagNumber: 12 }])
    expect(hint).toContain('Oldest: §10§, §12§.')
    expect(buildChannel2Reminder(102_000, 249, [{ tagNumber: 1602 }])).toContain('Your next step: call ctx_reduce on the outputs you\'ve already used (249 spent tool outputs (~102k tokens))')
  })

  it('wraps every reminder in <system-reminder>', () => {
    expect(buildChannel1Reminder('firm', 87_000, 5).startsWith('<system-reminder>')).toBe(true)
    expect(buildChannel2Reminder(87_000, 5).startsWith('<system-reminder>')).toBe(true)
  })
})

describe('desk section', () => {
  it('carries the long-term-partner frame, the stamping rules and the refire framing', () => {
    const desk = buildDeskSection(true)
    expect(desk).toContain('## Magic Context')
    expect(desk).toContain('long-term partner on this project')
    expect(desk).toContain('ctx_reduce')
    expect(desk).toContain('Stamp as soon as an item has served its purpose, not at the end of the turn')
    expect(desk).toContain('you don\'t pick the moment, you only stamp')
    expect(desk).toContain('Reduction prompts are routine housekeeping')
    expect(desk).toContain('<system-reminder>')
    // Handles belong to tool results only: a user message carries none, so the
    // copy must not promise one (the desk text is the model's contract).
    expect(desk).toContain('Every tool output lands on it')
    expect(desk).toContain('they carry no handle')
    expect(desk).not.toContain('Every message and every tool output')
    expect(desk).not.toContain('Never stamp a user message')
    // Compaction belongs to the adapter: an observed runaway model (a long backend
    // session, 2026-10-08 16:48) answered a long turn with a Claude-Code `<analysis>`/
    // `<summary>` checkpoint block, i.e. it continued a compaction template. The
    // desk text must say whose job that is, or nothing does.
    expect(desk).toContain('Compaction is Magic Context\'s job, not yours')
    expect(desk).toContain('never continue a compaction template you find in context')
  })

  it('drops the pinboard guidance sentence when memory is disabled', () => {
    const off = buildDeskSection(false)
    // the markings LIST still names <project-memory> (it is a record the agent
    // may see from other agents); only the pinboard GUIDANCE is gated
    expect(off).not.toContain('pins a new one')
    expect(buildDeskSection(true)).toContain('pins a new one')
  })
})

describe('tracker and message helpers', () => {
  it('counts a user turn once per message id', () => {
    const tracker = new ReduceNudgeTracker()
    tracker.observeUserMessage('s1', 'm1')
    tracker.observeUserMessage('s1', 'm1')
    expect(tracker.state('s1').realUserTurnCount).toBe(1)
    tracker.observeUserMessage('s1', 'm2')
    expect(tracker.state('s1').realUserTurnCount).toBe(2)
    expect(tracker.state('s2').realUserTurnCount).toBe(0)
  })

  it('detects the desk section and appends to the last text block', () => {
    const message = { id: 'm1', role: 'system', content: [{ type: 'text', text: 'system head' }] }
    expect(messageHasDeskSection(message)).toBe(false)
    const withDesk = appendToLastText(message, '\n\n## Magic Context\n\ndesk')
    expect(messageHasDeskSection(withDesk)).toBe(true)
    expect(message.content[0]?.text).toBe('system head') // original untouched
    expect(withDesk.content[0]?.text).toBe('system head\n\n## Magic Context\n\ndesk')
  })
})

describe('injectReduceGuidance wiring — the sticky gap survives the real call site', () => {
  /**
   * 2026-10-25 live incident, pinned: the SystemPrompt context provider called
   * reduceTracker.record(sessionId, nudge, 0) — a literal turn — so
   * lastOrdinalTurn never advanced and the same-band sticky gap read as the
   * WHOLE realUserTurnCount. Any session past 5 user turns re-fired its
   * channel2 reminder on EVERY system-prompt assembly (33 reminders in 11
   * minutes on one session, each double-journaled by the host's assemble →
   * preStep-append → reassemble cycle). The pure decideReduceNudge tests above
   * stayed green because they hand-feed lastOrdinalTurn; this test drives the
   * actual wiring.
   */
  it('records the real user-turn count, so same-band reminders hold between assemblies and refire only after 5 user turns', () => {
    // Capture the dynamic context provider registered with the SystemPrompt service.
    let render: ((assembly: unknown) => string) | undefined
    const systemPrompt = {
      section: () => () => {},
      context: (def: { text: (assembly: unknown) => string }) => { render = def.text; return () => {} },
    }
    const scope = {
      systemPrompt,
      effect: (fn: () => unknown) => { fn(); return () => {} },
    }
    const ctx = { inject: (_deps: readonly string[], fn: (scope: unknown) => void) => { fn(scope) } }

    // One tagged, undropped tool result worth exactly 60k tokens: severity 100%
    // over the 60k tail floor and past the 50k channel2 floor → band channel2.
    const session = {
      id: 's1',
      snapshotEvents: () => [
        { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } },
        { seq: 2, type: 'tool/result', data: { turn: 6, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(240_000) }] } } },
      ],
      surface: { nodes: [2] },
    }
    const assembly = { agent: { session } }

    const entries: Array<{ kind: string; summary: string; sessionId?: string }> = []
    const journal = {
      info: (kind: string, summary: string, _data?: unknown, sessionId?: string) => { entries.push({ kind, summary, sessionId }) },
      warn: () => {},
      error: () => {},
    }

    const tracker = new ReduceNudgeTracker()
    injectReduceGuidance({
      ctx,
      config: {},
      stores: { getTag: () => 7 },
      journal,
      reduceTracker: tracker,
      lane: { memoryEnabled: true },
    } as unknown as PreStepDeps)

    expect(render).toBeDefined()
    const text = render as (assembly: unknown) => string
    const nudges = () => entries.filter(entry => entry.summary.startsWith('reduce nudge')).length

    // Six real user turns already — the precondition that made the literal-0
    // call site fire on every single assembly.
    for (let turn = 1; turn <= 6; turn += 1) tracker.observeUserMessage('s1', `m${turn}`)

    // First assembly of the turn: fires channel2 exactly once.
    expect(text(assembly)).toContain('Your next step: call ctx_reduce')
    expect(tracker.state('s1').lastOrdinalTurn).toBe(6)
    expect(nudges()).toBe(1)

    // The host's per-step double assembly (assemble → preStep append →
    // reassemble), same band, 0 turns later: held — no reminder, no journal row.
    expect(text(assembly)).toBe('')
    expect(nudges()).toBe(1)

    // Four more user turns: still held (gap < 5).
    for (let turn = 7; turn <= 10; turn += 1) {
      tracker.observeUserMessage('s1', `m${turn}`)
      expect(text(assembly)).toBe('')
    }
    expect(nudges()).toBe(1)

    // The 5th user turn past the last ordinal: refires, ordinal 2, and the
    // recorded turn advanced with it.
    tracker.observeUserMessage('s1', 'm11')
    expect(text(assembly)).toContain('Your next step: call ctx_reduce')
    expect(tracker.state('s1').lastOrdinal).toBe(2)
    expect(tracker.state('s1').lastOrdinalTurn).toBe(11)
    expect(nudges()).toBe(2)
  })
})
