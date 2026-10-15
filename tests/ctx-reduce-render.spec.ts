/**
 * `ctx_reduce`'s agent-facing reply is a COUNT, not a tag list (MC 0.49.1
 * parity, followed up 2026-10-15).
 *
 * Why: the tags the agent stamps came from its own surface, so echoing them
 * back is pure noise, and the noise grows linearly with the batch size (a
 * 20-tag pass used to render 20 `§N§` handles plus two fixed lines). MC 0.49.1
 * changed the reply to a short count for exactly this reason.
 *
 * What deliberately does NOT change:
 *  - REFUSALS stay one line each: "no such tool-output tag on the current
 *    surface" / "already dropped" are actionable, and collapsing them into a
 *    count would make the agent retry a dead tag blindly.
 *  - The journal line (`ctx_reduce: queued N, refused M`, tool-bridge.ts:167)
 *    is machine-read by the client half and pinned by client-pure.spec.ts:137,
 *    so it is untouched by this change.
 *
 * `render` is a pure function of the tool result, so these specs drive it
 * without a session, a store, or the host.
 */
import { describe, expect, it } from 'vitest'
import { defineCtxReduceTool } from '../src/dsh/tool-bridge.ts'
import type { LocalDefineTool } from '../src/dsh/tool-bridge.ts'
import type { AdapterStores } from '../src/core/stores.ts'

type Render = (args: { readonly drop: string }, value: unknown) => { readonly text?: string }[]

/** Capture the registered options and hand back `output.render`. */
function reduceRender(): Render {
  const holder: { options?: { output: { render: Render } } } = {}
  const defineTool = ((options: { output: { render: Render } }) => {
    holder.options = options
    return options
  }) as unknown as LocalDefineTool
  defineCtxReduceTool({ stores: {} as AdapterStores, defineTool })
  const captured = holder.options
  if (captured === undefined) throw new Error('ctx_reduce did not register a definition')
  return captured.output.render
}

const renderText = (value: unknown): string =>
  reduceRender()({ drop: '1' }, value).map(block => block.text ?? '').join('\n')

describe('ctx_reduce reply is a count (MC 0.49.1 parity)', () => {
  it('positive: a 3-tag batch renders one count line, and no tag handles', () => {
    const text = renderText({ ok: true, queued: [3, 4, 5], refused: [] })
    expect(text).toBe('Queued 3 tags for reclaim.')
    // Negative control: the old enumerated form must stay gone.
    expect(text).not.toContain('§3§')
    expect(text).not.toContain('Queued for reclaim:')
    expect(text).not.toContain('reclaim band')
  })

  it('singular: one tag reads "tag", not "tags"', () => {
    expect(renderText({ ok: true, queued: [9], refused: [] })).toBe('Queued 1 tag for reclaim.')
  })

  it('refusals stay per-tag, on their own line, beside the count', () => {
    const text = renderText({
      ok: true,
      queued: [1, 2],
      refused: [{ tag: 7, ok: false, reason: 'already dropped' }],
    })
    expect(text).toBe('Queued 2 tags for reclaim.\n§7§ not queued: already dropped.')
  })

  it('a refusal with no reason still names the tag', () => {
    const text = renderText({ ok: true, queued: [], refused: [{ tag: 4, ok: false }] })
    expect(text).toBe('§4§ not queued: unavailable.')
  })

  it('nothing queued and nothing refused says so once', () => {
    expect(renderText({ ok: true, queued: [], refused: [] })).toBe('Nothing queued.')
    expect(renderText({})).toBe('Nothing queued.')
  })
})
