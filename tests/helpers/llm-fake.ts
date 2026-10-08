/**
 * The shared strict LLM seam fake.
 *
 * Test-design audit, structural risk #3: the spec-side doubles read only
 * `maxTokens`/`signal` and accept any request shape, which is how two real
 * defects stayed invisible — a bare-string `content` (the host calls
 * `content.some(...)` and throws) killed every live maintenance verify tick
 * before anyone noticed, and a session stub invented a `data.message` wrapper
 * no live session produces. This fake enforces the request shape on every
 * call and refuses to answer anything that the real seam would have rejected.
 */

export interface LlmCall {
  /** Concatenated text of the last message's text blocks ('' if none). */
  text: string
  maxTokens?: number
  route?: unknown
  model?: unknown
  signal?: AbortSignal
  /** The verbatim request, for the rare assertion that needs more than text. */
  messages: Array<{ role?: unknown; content?: unknown }>
  /** The whole options object as the seam received it. */
  request: unknown
}

export type ScriptEntry = string | Error | (() => AsyncIterable<unknown>)

export interface LlmFake {
  /** Drop-in seam: pass `fake.llm` wherever the spec passed its local double. */
  llm: {
    stream(options: {
      messages?: unknown
      maxTokens?: number
      signal?: AbortSignal
      route?: unknown
      model?: unknown
    }): AsyncIterable<unknown>
  }
  /** One record per stream() call, in order. */
  calls: LlmCall[]
  /** Per-call last-message text (shorthand over `calls`). */
  texts: string[]
  /** Per-call output cap (the `caps` arrays the old local doubles kept). */
  maxTokens: number[]
  /** Per-call abort signals (what `hangingLlm` used to collect externally). */
  signals: AbortSignal[]
}

/** The host contract: content is a BLOCK ARRAY; text blocks carry string text. */
function assertRequestShape(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('llm-fake: messages must be a non-empty array')
  }
  messages.forEach((message, index) => {
    const content = (message as { content?: unknown })?.content
    if (!Array.isArray(content) || content.length === 0) {
      throw new TypeError(
        `llm-fake: messages[${index}].content must be a non-empty block array`
          + ` (the host calls content.some(...) — a bare string throws 'content.some is not a function')`,
      )
    }
    for (const block of content) {
      if (typeof block !== 'object' || block === null || typeof (block as { type?: unknown }).type !== 'string') {
        throw new TypeError(`llm-fake: messages[${index}] blocks must be objects with a string type`)
      }
      if ((block as { type: string }).type === 'text' && typeof (block as { text?: unknown }).text !== 'string') {
        throw new TypeError(`llm-fake: messages[${index}] text blocks must carry string text`)
      }
    }
  })
}

function lastMessageText(messages: Array<{ role?: unknown; content?: unknown }>): string {
  const last = messages.at(-1)
  if (!Array.isArray(last?.content)) return ''
  return (last!.content as Array<{ type?: string; text?: unknown }>)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * A seam scripted per call: the n-th request gets the n-th entry; beyond the
 * last entry the final one repeats (matching the local doubles this replaces).
 *  - a string answers with one text-delta and a clean `stop` finish;
 *  - an Error throws from the iterator's first `next()` (what the consumers'
 *    catch blocks see);
 *  - a thunk answers with a raw frame (cap-truncated or invalid-JSON
 *    scenarios build their own).
 */
export function scriptLlm(entries: Array<ScriptEntry>): LlmFake {
  if (entries.length === 0) throw new TypeError('llm-fake: scriptLlm needs at least one entry')
  const calls: LlmCall[] = []
  const fake: LlmFake = {
    calls,
    texts: [],
    maxTokens: [],
    signals: [],
    llm: {
      stream(options) {
        assertRequestShape(options.messages)
        const messages = options.messages as Array<{ role?: unknown; content?: unknown }>
        const call: LlmCall = {
          text: lastMessageText(messages),
          maxTokens: options.maxTokens,
          route: options.route,
          model: options.model,
          signal: options.signal,
          messages,
          request: options,
        }
        calls.push(call)
        fake.texts.push(call.text)
        if (options.maxTokens !== undefined) fake.maxTokens.push(options.maxTokens)
        if (options.signal !== undefined) fake.signals.push(options.signal)
        const entry = entries[Math.min(calls.length - 1, entries.length - 1)]!
        if (typeof entry === 'string') {
          const text = entry
          return (async function* () {
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
        if (entry instanceof Error) {
          const failure = entry
          return (async function* () {
            throw failure
          })()
        }
        return entry()
      },
    },
  }
  return fake
}

/** A seam that NEVER settles — neither the iterator nor the abort handler. */
export function hangingLlm(): LlmFake {
  const calls: LlmCall[] = []
  const fake: LlmFake = {
    calls,
    texts: [],
    maxTokens: [],
    signals: [],
    llm: {
      stream(options) {
        assertRequestShape(options.messages)
        const messages = (options.messages ?? []) as Array<{ role?: unknown; content?: unknown }>
        calls.push({
          text: lastMessageText(messages),
          maxTokens: options.maxTokens,
          route: options.route,
          model: options.model,
          signal: options.signal,
          messages,
          request: options,
        })
        if (options.signal !== undefined) fake.signals.push(options.signal)
        return {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }
          },
        } as AsyncIterable<unknown>
      },
    },
  }
  return fake
}

/**
 * One text answer streamed as the REAL chunk protocol does: block-start,
 * per-character deltas, block-end, usage, clean finish. Same answer on every
 * call (what `answeringLlm` did locally).
 */
export function answerLlm(text: string): LlmFake {
  const calls: LlmCall[] = []
  const fake: LlmFake = {
    calls,
    texts: [],
    maxTokens: [],
    signals: [],
    llm: {
      stream(options) {
        assertRequestShape(options.messages)
        const messages = (options.messages ?? []) as Array<{ role?: unknown; content?: unknown }>
        calls.push({
          text: lastMessageText(messages),
          maxTokens: options.maxTokens,
          route: options.route,
          model: options.model,
          signal: options.signal,
          messages,
          request: options,
        })
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          for (const char of text) yield { type: 'text-delta', index: 0, text: char }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  return fake
}
