/**
 * THE DSH CONTACT SURFACE. Every import of `@deepseek-ai/*` in this package
 * lives in `src/dsh/`. When DSH iterates (developer preview, breaking
 * changes expected), this is the only module that changes: event names,
 * payload shapes, and the durable-surface vocabulary are wrapped here and
 * exposed to `src/core` and `src/index.ts` in neutral terms.
 *
 * Seams consumed (verified against upstream master @ 5badb15):
 *  - `agent/pre-step` waterfall   — payload { agent, messages, turn, step, signal },
 *    decision { kind: 'enter', messages, startsRequestSeries? } rewrites the
 *    admitted user batch before it lands on the surface (packages/core/agent-loop/src/agent.ts:276).
 *  - `tools/post-execute` waterfall — decision { kind: 'accept', content } replaces
 *    the tool-result projection before it is logged (packages/core/tools/src/index.ts:617;
 *    spill-policy is the precedent consumer).
 *  - `session/event` — durable append feed; `assistant/message` carries usage.
 *  - `Session.append(type, data, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })` —
 *    the durable surface mutation (packages/core/session/src/types.ts:450; "any
 *    surface-replacing producer may use it").
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ContentBlock,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { LlmSeamMessage } from '../core/types.ts'
import { randomUUID } from 'node:crypto'

/**
 * Provider-neutral code the adapter's emergency band reacts to. Defined
 * locally on purpose: a runtime import here would break the cross-repo
 * patch-overlay loading mode (the adapter's runtime has zero @deepseek-ai
 * imports). Drift guard: upstream owns this string in `@deepseek-ai/dsh-llm`
 * (exported as CONTEXT_WINDOW_EXCEEDED_CODE); the seam contract test pins it.
 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** The seam event names, centralized so renames touch one file. */
export const DSH_EVENTS = {
  preStep: 'agent/pre-step',
  postToolExecute: 'tools/post-execute',
  sessionEvent: 'session/event',
  requestError: 'agent/request-error',
} as const

/** Narrowed pre-step payload (upstream: runtime-types.ts:320). */
export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Narrowed enter decision (upstream: runtime-types.ts:112). */
export type PreStepEnterDecision = { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }

export type { ContentBlock, Session, SessionEvent, SessionSeq, UserMessage }

/**
 * Admission-time message stamping is deliberately ABSENT (removed 2026-10-08).
 *
 * `tagUserMessage` used to prefix `§N§ ` onto the admitted user batch. Those
 * handles were dead: every reclaim lane in this adapter resolves tags against
 * surface tool results only, so `ctx_reduce` refused them ("no such tool-output
 * tag on the current surface"). The prefix, however, is durable, so it reached
 * the conversation transcript and — through `session-title`'s deterministic
 * first-prompt fallback, which reads the first `source: 'user'` message — the
 * session title. opencode/pi never had this problem because they stamp a
 * per-call array the host throws away; DSH derives every request from the log,
 * so nothing stamped here can stay invisible. Tool results still carry their
 * handle: they are stamped at landing (`tools/post-execute`, index.ts), the one
 * lane with reclaim consumers. Ruling: `docs/dsh-port-feasibility-2026-10-06.md`
 * §7.4.
 */

/** A tagged copy of a tool-result content projection. */
export function tagToolResultContent(content: readonly ContentBlock[], prefix: (tag: number) => string, tag: number): ContentBlock[] {
  const firstText = content.findIndex(block => block.type === 'text')
  if (firstText === -1) {
    return [{ type: 'text', text: prefix(tag) }, ...content]
  }
  return content.map((block, index) =>
    index === firstText && block.type === 'text'
      ? { ...block, text: `${prefix(tag)}${block.text}` }
      : block,
  )
}

/**
 * Durable drop: replace one `tool/result` surface node with a placeholder
 * citing the original event, so replay can recover the full-fidelity result
 * (the DSH spelling of Magic Context's `[dropped §N§]` + ctx_expand).
 * Returns the replacement event's seq.
 */
export function replaceToolResultWithPlaceholder(
  session: Session,
  targetSeq: SessionSeq,
  placeholderText: string,
): SessionSeq {
  return replaceToolResultContent(session, targetSeq, [{ type: 'text', text: placeholderText }])
}

/** One current tool-result surface node, seen through the adapter's lens. */
export interface SurfaceToolNode {
  readonly seq: SessionSeq
  readonly callId: string
  readonly turn: number
  readonly step: number
  /** Adapter tag number for this result, when one was allocated. */
  readonly tagNumber?: number
  /** Whether the node's content is already a `[dropped §N§]` placeholder. */
  readonly isPlaceholder: boolean
  /** The placeholder's tag number when isPlaceholder. */
  readonly droppedTag?: number
  /** C2: the calling tool's name (paired `tool/call` event), for the drop
   *  tiers. Undefined when the call event was compacted away. */
  readonly toolName?: string
  /** C1: total text characters of the result content (token-estimate input). */
  readonly textLength: number
}

const DROPPED_PATTERN = /^\[dropped §(\d+)§\]$/

/**
 * Enumerate CURRENT tool-result surface nodes (model-visible order —
 * `session.surface.nodes` excludes shadowed log events, which is what the
 * replace validator requires targets to be).
 * @param tagOf - resolves a node's adapter tag from its callId.
 */
export function enumerateSurfaceToolResults(
  session: Session,
  tagOf: (callId: string) => number | undefined,
): SurfaceToolNode[] {
  const nodes: SurfaceToolNode[] = []
  const events = session.snapshotEvents()
  const toolNameByCallId = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      toolNameByCallId.set(event.data.callId, event.data.name)
    }
  }
  for (const seq of session.surface.nodes) {
    const event = events.find(candidate => candidate.seq === seq)
    if (event?.type !== 'tool/result') continue
    const callId = event.data.message.toolCallId
    const first = event.data.message.content[0]
    const firstText = first?.type === 'text' ? first.text : undefined
    const dropped = firstText === undefined ? null : DROPPED_PATTERN.exec(firstText)
    const textLength = event.data.message.content.reduce(
      (total, block) => total + (block.type === 'text' ? block.text.length : 0),
      0,
    )
    nodes.push({
      seq,
      callId,
      turn: event.data.turn,
      step: event.data.step,
      tagNumber: tagOf(callId),
      isPlaceholder: dropped !== null,
      droppedTag: dropped === null ? undefined : Number(dropped[1]),
      ...toolNameByCallId.get(callId) === undefined ? {} : { toolName: toolNameByCallId.get(callId) },
      textLength,
    })
  }
  return nodes
}

/**
 * Replace one current tool-result node's CONTENT while preserving its whole
 * identity envelope (the surface validator restricts tool/result rewrites to
 * exactly the content field).
 */
export function replaceToolResultContent(
  session: Session,
  targetSeq: SessionSeq,
  content: readonly ContentBlock[],
): SessionSeq {
  const events = session.snapshotEvents()
  const original = events.find((event): event is SessionEvent<'tool/result'> =>
    event.seq === targetSeq && event.type === 'tool/result')
  if (original === undefined) {
    throw new Error(`magic-context dsh adapter: seq ${targetSeq} is not a tool/result surface node`)
  }
  const { content: _replaced, ...messageRest } = original.data.message
  const replacement = session.append('tool/result', {
    turn: original.data.turn,
    step: original.data.step,
    message: { ...messageRest, content: [...content] },
    ...original.data.error === undefined ? {} : { error: original.data.error },
    ...original.data.meta === undefined ? {} : { meta: original.data.meta },
  }, {
    surfaceOp: { op: 'replace', startSeq: targetSeq, endSeq: targetSeq },
    sourceEventSeqs: [original.seq],
  })
  return replacement.seq
}

/** The `[dropped §N§]` placeholder content (Magic Context's canonical string). */
export function dropPlaceholderContent(tagNumber: number): ContentBlock[] {
  return [{ type: 'text', text: `[dropped §${tagNumber}§]` }]
}

/** The full-fidelity original content cited by a placeholder node, when recoverable. */
export function originalContentOfPlaceholder(
  session: Session,
  placeholderSeq: SessionSeq,
): ContentBlock[] | undefined {
  const events = session.snapshotEvents()
  const node = events.find((event): event is SessionEvent<'tool/result'> => event.seq === placeholderSeq)
  if (node?.type !== 'tool/result') return undefined
  const cited = node.sourceEventSeqs
  if (cited === undefined || cited.length !== 1) return undefined
  const original = events.find((event): event is SessionEvent<'tool/result'> => event.seq === cited[0])
  if (original?.type !== 'tool/result') return undefined
  return [...original.data.message.content]
}

/** The logged request envelope facts pressure math needs. */
export function requestContextOf(session: Session): {
  provider?: string
  model?: string
  contextWindow?: number
} {
  const context = session.requestContext()
  if (context === undefined) return {}
  return {
    provider: context.provider,
    model: context.model,
    contextWindow: context.contextWindow,
  }
}

/** Structural view used for the tolerant reads below (same pattern as `contentOf`). */
interface AssistantUsageEventData {
  readonly data?: {
    readonly turn?: number
    readonly step?: number
    readonly message?: { readonly source?: { readonly provider: string; readonly model: string } }
    readonly usage?: {
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly cacheReadTokens?: number
      readonly cacheWriteTokens?: number
    }
  }
}

/** Neutral usage fields read from an `assistant/message` durable event. */
export function readUsageFields(event: SessionEvent): {
  seq: number
  turn: number
  step: number
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
} | undefined {
  if (event.type !== 'assistant/message') return undefined
  // Tolerant reads: this helper runs in the `session/event` listener, which the
  // host emits on EVERY append (the user's own messages included). A drift in
  // the assistant event shape must skip the usage row (fail-open; the next
  // assistant message anchors a fresh one), not throw into that emission.
  const data = (event as unknown as AssistantUsageEventData).data
  const source = data?.message?.source
  const usage = data?.usage
  if (source === undefined) return undefined
  return {
    seq: event.seq,
    turn: data?.turn ?? 0,
    step: data?.step ?? 0,
    provider: source.provider,
    model: source.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
  }
}

/** Whether a Cordis context exposes the seam surface this adapter needs. */
export function probeDshSeams(ctx: Context): { ok: boolean; problems: readonly string[] } {
  const problems: string[] = []
  if (typeof ctx.on !== 'function') problems.push('ctx.on is not a function (Cordis event API missing)')
  if (typeof ctx.logger?.info !== 'function') problems.push('ctx.logger missing (diagnostics would be invisible)')
  return { ok: problems.length === 0, problems }
}

// ── Phase 2: the general surface lens (historian eligibility, publishing) ────

export type SurfaceRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

/** One current surface node, in provider-visible order. */
export interface SurfaceNode {
  readonly seq: SessionSeq
  readonly type: string
  readonly role: SurfaceRole
  /** Concatenated text blocks (tool-call arguments excluded — they are not text). */
  readonly text: string
  /** Whether the node carries at least one non-empty text block. */
  readonly hasText: boolean
  /** Whether the node's text is one of the adapter's reclaim placeholders. */
  readonly isPlaceholder: boolean
  /** Whether an assistant node carries tool calls (tool-pairing boundary logic). */
  readonly hasToolCalls: boolean
  /** The provider call ids an assistant node requests (publish pairing closure). */
  readonly toolCallIds?: readonly string[]
  /** The `toolCallId` of a `tool/result` node — the other half of the pairing closure. */
  readonly toolCallId?: string
  /**
   * `data.source.kind` of the event, when it carries one. The baseline must
   * never attach to a `compact-checkpoint` node: a checkpoint is the host's (or
   * the engine's) compaction artifact, and folding a baseline into it makes the
   * checkpoint's own text ride inside m[0] forever — every later refresh then
   * re-emits and rewrites that foreign text (the GUI also correlates its
   * compaction card by source kind + compactionId, which the rewrite destroyed).
   */
  readonly sourceKind?: string
}

const ROLE_BY_TYPE: Record<string, SurfaceRole> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

const PLACEHOLDER_PATTERN = /^\[(?:dropped|compacted) §(?:C)?\d+§\]$/

interface MessageBearingEvent {
  readonly data?: {
    readonly message?: { readonly content?: readonly ContentBlock[] }
    /**
     * `user/message` (and friends) carry the message ITSELF as the event data
     * (`session/types.ts`, `surface.ts deriveEventMessage: return event.data`),
     * so the content blocks sit one level higher than on assistant events.
     */
    readonly content?: readonly ContentBlock[]
  }
}

/**
 * The message content blocks of a message-bearing surface event.
 *
 * Both shapes matter: reading only `data.message.content` left every user node
 * with empty text, which silently disabled `refreshBaseline`'s byte-identical
 * short-circuit — i.e. every execute pass rewrote the baseline node (new
 * `mc-baseline-<uuid>` id, replaceGeneration++) instead of leaving the cache
 * prefix untouched (measured: docs/dsh-plugin-memory-goal-status).
 */
function contentOf(event: SessionEvent): readonly ContentBlock[] {
  const data = (event as unknown as MessageBearingEvent).data
  return data?.message?.content ?? data?.content ?? []
}

/** Concatenated text of a surface event, ignoring tool-call/reasoning blocks. */
export function textOfSurfaceEvent(event: SessionEvent): string {
  return contentOf(event)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * `data.source.kind` of a message-bearing surface event. `user/message` carries
 * the message itself as its data, so the source sits on `data.source`; other
 * message types wrap it (`data.message.source`).
 */
function sourceKindOf(event: SessionEvent): string | undefined {
  const data = (event as unknown as { data?: { source?: { kind?: unknown }; message?: { source?: { kind?: unknown } } } }).data
  const kind = data?.source?.kind ?? data?.message?.source?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** The provider call ids requested by a node's `tool-call` blocks. */
function toolCallIdsOf(blocks: readonly ContentBlock[]): readonly string[] {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map(block => block.id)
}

/** One node view, or undefined when the event carries no surface message. */
function surfaceNodeOf(seq: SessionSeq, event: SessionEvent): SurfaceNode | undefined {
  const role = ROLE_BY_TYPE[event.type]
  if (role === undefined) return undefined
  const text = textOfSurfaceEvent(event)
  const sourceKind = sourceKindOf(event)
  const blocks = contentOf(event)
  return {
    seq,
    type: event.type,
    role,
    text,
    hasText: text.trim().length > 0,
    isPlaceholder: PLACEHOLDER_PATTERN.test(text.trim()),
    hasToolCalls: blocks.some(block => block.type === 'tool-call'),
    ...(role === 'assistant' ? { toolCallIds: toolCallIdsOf(blocks) } : {}),
    ...(event.type === 'tool/result' ? { toolCallId: event.data.message.toolCallId } : {}),
    ...sourceKind === undefined ? {} : { sourceKind },
  }
}

/**
 * Enumerate the CURRENT surface in provider-visible order. `session.surface.nodes`
 * excludes shadowed events, which is exactly the live window the historian may
 * digest and the publish lane may replace.
 */
export function enumerateSurfaceNodes(session: Session): SurfaceNode[] {
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const nodes: SurfaceNode[] = []
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const node = surfaceNodeOf(seq, event)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

/**
 * Widen the window `nodes[first..last]` until no live node pairs across the
 * window boundary, and pull in stranded results — a `tool/result` whose
 * `toolCallId` no live assistant requests can never pair again, so folding it
 * into the same replacement is the only way to get it off the wire.
 *
 * Why this exists: the provider rejects a request whose `tool_result` blocks
 * lack the matching `tool_use` in the preceding assistant message. Publishing
 * a range that cuts a pair strands one side and the whole next turn fails with
 * `invalid_request_error` — observed live 2026-10-09, when drop placeholders
 * (`[dropped §N§]`) re-sequenced results to the surface tail moments before
 * the publish computed its positional range.
 *
 * Widening is a positional range operation — everything between the old window
 * and a pulled-in node is shadowed by the same replacement — so the window only
 * ever grows and never splits. Orphans are pulled forward-only so the window
 * cannot drift backward onto the frozen m[0] baseline at the surface head.
 * @returns the closed window; callers must slice `nodes` with it.
 */
export function pairingClosedWindow(
  nodes: readonly SurfaceNode[],
  first: number,
  last: number,
): { first: number; last: number } {
  const liveCallIds = new Set<string>()
  for (const node of nodes) {
    for (const id of node.toolCallIds ?? []) liveCallIds.add(id)
  }
  let lo = first
  let hi = last
  let changed = true
  while (changed) {
    changed = false
    const windowCallIds = new Set<string>()
    const windowResultIds = new Set<string>()
    for (let i = lo; i <= hi; i += 1) {
      const node = nodes[i]
      if (node === undefined) continue
      for (const id of node.toolCallIds ?? []) windowCallIds.add(id)
      if (node.toolCallId !== undefined) windowResultIds.add(node.toolCallId)
    }
    for (let i = 0; i < nodes.length; i += 1) {
      if (i >= lo && i <= hi) continue
      const node = nodes[i]
      if (node === undefined) continue
      const pairsWithWindow = (node.toolCallId !== undefined && windowCallIds.has(node.toolCallId))
        || (node.toolCallIds ?? []).some(id => windowResultIds.has(id))
      const stranded = node.toolCallId !== undefined && !liveCallIds.has(node.toolCallId) && i > hi
      if (!pairsWithWindow && !stranded) continue
      if (i < lo) { lo = i; changed = true }
      if (i > hi) { hi = i; changed = true }
    }
  }
  return { first: lo, last: hi }
}

/**
 * Live `tool/result` nodes whose tool-call id no live assistant requests.
 *
 * One of these on the wire fails every strict-provider request
 * (`invalid_request_error: unexpected tool_use_id ... found in tool_result
 * blocks`) — the one adapter failure mode that can take the main conversation
 * down. The decision layer forces the execute band when this is non-empty and
 * the pass's repair lane sweeps it. Light on purpose: no text extraction, so
 * the pre-step can afford it every model step.
 */
export function wireStrandedResults(session: Session): ReadonlyArray<{ seq: SessionSeq; callId: string }> {
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const liveCallIds = new Set<string>()
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event?.type !== 'assistant/message') continue
    for (const block of contentOf(event)) {
      if (block.type === 'tool-call') liveCallIds.add(block.id)
    }
  }
  const stranded: Array<{ seq: SessionSeq; callId: string }> = []
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event?.type !== 'tool/result') continue
    const callId = event.data.message.toolCallId
    if (!liveCallIds.has(callId)) stranded.push({ seq, callId })
  }
  return stranded
}

/**
 * Node views for EXPLICIT seqs, shadowed events included. The recomp lane
 * re-digests history that already left the surface (a replacement cites the
 * events it shadowed, and they stay in the log forever), so
 * `enumerateSurfaceNodes` — the live window — cannot serve it.
 * @param session - the session whose log is the source of truth.
 * @param seqs - the seqs to render, in the order they should appear.
 * @returns one node per resolvable message-bearing event, skipping the rest.
 */
export function nodesForSeqs(session: Session, seqs: readonly SessionSeq[]): SurfaceNode[] {
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const nodes: SurfaceNode[] = []
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const node = surfaceNodeOf(seq, event)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

/**
 * The provider-visible messages of a surface span, in surface order — the
 * prefix replayed into an auxiliary (historian) call so the request stays a
 * true prefix of the last routed one and the provider's KV cache is reused.
 *
 * The message objects are passed through VERBATIM (identity envelope
 * included): the runtime reads `source.replayState` off assistant messages
 * (packages/llm/llm/src/index.ts:985), and a reduced projection would both
 * break that and lose the cache-relevant bytes.
 */
/** The provider message of a message-bearing surface event, in the exact shapes
 * `deriveEventMessage` uses (packages/core/session/src/surface.ts:132-145):
 * `user/message` carries the message ITSELF as `event.data`, while
 * system/developer/assistant/tool wrap it in `data.message`. Reading only the
 * wrapped shape silently dropped every user turn from the historian's replayed
 * prefix.
 */
function messageOf(event: SessionEvent): unknown {
  const data = (event as unknown as { data?: { message?: unknown } }).data
  if (data === undefined) return undefined
  return event.type === 'user/message' ? data : data.message
}

/**
 * Replay the request messages a set of surface seqs would produce.
 *
 * The return type is the LLM seam's own message contract: this is the one wire
 * boundary the adapter owns, and its consumer (the historian) feeds the result
 * straight to `ctx.llm.stream`. The events' payloads arrive as `unknown`, so the
 * per-message cast happens here rather than at every call site.
 */
export function spanRequestMessages(
  session: Session,
  seqs: readonly SessionSeq[],
): LlmSeamMessage[] {
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const messages: LlmSeamMessage[] = []
  const requested = new Set<string>()
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    if (ROLE_BY_TYPE[event.type] === undefined) continue
    const message = messageOf(event)
    if (message === undefined) continue
    // A request is a wire boundary: a provider rejects a tool result whose
    // tool-call is not in the same request (`host: packages/core/session/src/
    // repair.ts:164` states the mirror rule — "providers reject dangling
    // assistant calls"). Every edge this adapter controls is kept pairing-safe
    // (`planChunkSpans`, the historian's span scan), but a surface written by an
    // OLDER build can still hold an interior orphan: the publish lane used to
    // cite only the covered subset and the live journal carries the 400 it
    // produced. Drop the orphan rather than send a request that cannot succeed.
    if (event.type === 'assistant/message') {
      const content = (message as { content?: Array<{ type?: string; id?: string }> }).content ?? []
      for (const block of content) {
        if (block.type === 'tool-call' && typeof block.id === 'string') requested.add(block.id)
      }
    } else if (event.type === 'tool/result') {
      const callId = (message as { toolCallId?: string }).toolCallId
      if (typeof callId === 'string' && !requested.has(callId)) continue
    }
    messages.push(message as LlmSeamMessage)
  }
  return messages
}

/**
 * A plugin-injected context source — the ONE shape this adapter uses for every
 * synthetic node it authors (baseline refresh, compartment publication, pass
 * notices). `form`/`summary` are the host's display vocabulary
 * (ui-chat ContextBody.tsx:551-591; `notice` is the only form that renders its
 * summary on a collapsed row), and the producer label comes from `kind`
 * (ui-chat conversation-nodes/event-projection.ts:60-76). The model keeps
 * reading the full content either way: only the presentation changes.
 *
 * Synthetic nodes must NOT claim `{ kind: 'user' }`. They are model-only by
 * contract (`session/src/surface.ts:80-85`: "replacement copies stay
 * model-only"), but `session-title` folds the log for the first
 * `source.kind === 'user'` message and would count a plugin-authored node as
 * authored material.
 * @param summary - the collapsed row's one-line account.
 * @returns the durable source object.
 */
export function magicContextSource(summary: string): unknown {
  return { kind: 'magic-context', form: 'notice', summary }
}

/**
 * The host's compaction-checkpoint source (`@deepseek-ai/dsh-compaction`
 * checkpoint.ts:33 `compactCheckpointSource`). Defined locally like every other
 * seam constant: this adapter's runtime has zero `@deepseek-ai/*` imports (the
 * patch-overlay loading mode). The marker is load-bearing — the Chat client
 * correlates a compaction card to its checkpoint by exactly this kind
 * (ui-chat conversation-nodes/command.ts:82-92) — so a checkpoint written with
 * any other source is invisible to that correlation.
 * @param compactionId - the owning `compaction/start … compaction/end` identity.
 * @param sourceCommandId - the initiating manual command, when present.
 * @returns the durable source object.
 */
export function compactCheckpointSource(compactionId: string, sourceCommandId?: string): unknown {
  return {
    kind: 'compact-checkpoint',
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  }
}

/**
 * Replace a surface RANGE with one fresh `user/message` node, citing every
 * shadowed event. The range is expressed as the seqs of its first and last
 * current node (surface positions — the validator accepts either numeric
 * order). Returns the replacement event's seq.
 * @param source - the synthetic node's durable source: `magicContextSource`
 * for this adapter's own nodes, `compactCheckpointSource` for a real
 * compaction checkpoint. Never `{ kind: 'user' }` (see `magicContextSource`).
 */
export function replaceSurfaceRange(
  session: Session,
  firstSeq: SessionSeq,
  lastSeq: SessionSeq,
  content: readonly ContentBlock[],
  shadowed: readonly SessionSeq[],
  id: string,
  source: unknown,
): SessionSeq {
  const replacement = session.append('user/message', {
    id,
    role: 'user',
    content: [...content],
    source,
  } as never, {
    surfaceOp: { op: 'replace', startSeq: firstSeq, endSeq: lastSeq },
    sourceEventSeqs: [...shadowed],
  })
  return replacement.seq
}

/** A fresh synthetic-node identity (the session validates message shapes, not ids). */
export function syntheticNodeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

