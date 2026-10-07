/**
 * The historian — Magic Context's summarizer, translated to a durable
 * compartment instead of an in-band checkpoint.
 *
 * Magic Context's discipline, kept intact:
 *  - the historian is a MODEL-FREE transform from the pass's point of view:
 *    its LLM call runs out of band and only writes a store row; nothing on the
 *    wire changes because of it (publishing is a separate, busting pass);
 *  - it digests a contiguous span from the FRONT of the context, never the
 *    protected tail, never a span that would break tool-call pairing;
 *  - it fires only when the eligible span is worth a call (Magic Context's
 *    trigger budget: 5% of the window, clamped to 5k–50k tokens);
 *  - a failed or invalid response changes nothing (fail closed, one repair
 *    attempt only).
 *
 * Divergence from Magic Context, deliberate and documented: the four detail
 * tiers are produced in one call (MC's ladder is accumulated across calls),
 * and the token estimate is chars/4 rather than a real tokenizer.
 */
import {
  estimateTokens,
  HistorianOutputError,
  parseHistorianOutput,
  type Compartment,
  type CompartmentDraft,
} from '../core/compartments.ts'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import { spanRequestMessages, type SurfaceNode } from './seams.ts'

/** The narrow LLM seam the historian needs (satisfied by `ctx.llm`). */
export interface HistorianLlm {
  stream(options: HistorianStreamOptions): AsyncIterable<unknown>
}

export interface HistorianStreamOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly unknown[]
  readonly toolHistory?: unknown
  readonly maxTokens: number
  readonly sessionId: string
  readonly purpose: 'compaction'
  readonly signal?: AbortSignal
}

export interface HistorianLogger {
  info(message: string): void
  warn(message: string): void
}

/**
 * The historian's default wall-clock budget, used only as a runtime guard for
 * a policy object that predates `policy.historianTimeoutMs` (the core policy
 * table now always carries the field; see `DEFAULT_POLICY`).
 */
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 120_000

/**
 * The run exceeded its wall-clock budget. Distinct from a provider failure so
 * the journal can say *why* nothing was stored.
 */
export class HistorianTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`historian call timed out after ${String(timeoutMs)}ms`)
    this.name = 'HistorianTimeoutError'
  }
}

/**
 * The provider stopped at the output-token cap before the JSON contract was
 * complete. Observed in production with `historianMaxTokens: 2048`: the model
 * spends part of the budget on reasoning and the digest never closes, so every
 * run failed and no compartment (and therefore no fact) was ever stored.
 *
 * Retryable ONCE with an escalated cap — unlike a transport error, the request
 * itself was valid and the answer was merely too long.
 */
export class HistorianTruncatedError extends Error {
  constructor(
    readonly maxTokens: number,
    /** Characters already streamed when the cap was hit — 0 means the whole
     * budget went to reasoning, large means the JSON contract was too long. */
    readonly partialChars = 0,
  ) {
    super(
      `historian call truncated at the ${String(maxTokens)}-token output cap `
      + `(incomplete digest, ${String(partialChars)} chars streamed)`,
    )
    this.name = 'HistorianTruncatedError'
  }
}

/**
 * The output cap below which the four-tier JSON contract cannot reliably close.
 * A configured `historianMaxTokens` under this floor is raised TO it (and the
 * raise is journaled), because a smaller cap is a guaranteed truncation rather
 * than a preference. The ceiling matches the largest useful answer and keeps a
 * single attempt inside the default wall-clock budget.
 */
export const HISTORIAN_MIN_OUTPUT_TOKENS = 8_192

/** The hard upper bound for one historian answer. */
export const HISTORIAN_MAX_OUTPUT_TOKENS = 32_768

export interface HistorianDeps {
  readonly stores: AdapterStores
  /** `historianTimeoutMs` on the core policy caps one run (both attempts). */
  readonly policy: PressurePolicy
  readonly llm: HistorianLlm
  readonly logger: HistorianLogger
  /** Explicit route override; default is the session's last routed model. */
  readonly route?: { provider: string; model: string }
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
  /** Explicit wall-clock cap; default is `policy.historianTimeoutMs`, else 60s. */
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** The eligible span the historian would digest. */
export interface HistorianRange {
  readonly nodes: readonly SurfaceNode[]
  readonly tokens: number
}

/**
 * Magic Context's trigger budget: the eligible span must exceed 5% of the
 * context window, clamped to [5k, 50k] tokens, before a call is worth making.
 */
export function historianTriggerBudget(
  contextWindow: number | undefined,
  assumedWindow: number,
  minBudgetTokens = 5_000,
): number {
  const window = contextWindow === undefined || contextWindow <= 0 ? assumedWindow : contextWindow
  const floor = Math.max(1, minBudgetTokens)
  return Math.max(floor, Math.min(50_000, Math.round(window * 0.05)))
}

/** A node whose text OPENS with a reclaim marker (a placeholder, or a manual
 * checkpoint that carries its digest inline) holds no content worth digesting. */
const SKIPPABLE_PLACEHOLDER = /^\[(?:dropped|compacted|checkpoint) §/

/**
 * Select the oldest contiguous eligible span.
 *
 * Skipped: the system head, the composed baseline node (our own synthetic
 * node), anything already covered by a compartment, and empty reclaim
 * placeholders. The span never reaches into the newest `protectedNodes`
 * surface nodes, and both of its edges are pulled to a tool-pairing boundary:
 * it never OPENS on a tool result (whose assistant tool-call precedes the
 * span) and never CLOSES on a tool result or on an assistant that requested
 * tools (whose results fall outside the span). Either violation makes the
 * auxiliary request structurally invalid for tool-using providers, which
 * reject it before the historian can produce anything.
 */
export function selectHistorianRange(input: {
  readonly nodes: readonly SurfaceNode[]
  readonly covered: ReadonlySet<number>
  readonly baselineNodeSeq?: number
  readonly protectedNodes: number
  readonly minNodes: number
}): HistorianRange | undefined {
  const { nodes, covered } = input
  let start = 0
  const skippable = (node: SurfaceNode): boolean =>
    node.role === 'system'
    || node.seq === input.baselineNodeSeq
    || covered.has(node.seq)
    || node.isPlaceholder
    || SKIPPABLE_PLACEHOLDER.test(node.text.trim())
    || !node.hasText
  while (start < nodes.length && skippable(nodes[start] as SurfaceNode)) start += 1
  // TOOL-PAIRING, head: a `tool` node can never OPEN the replay, because its
  // assistant tool-call always precedes it in the surface — opening on one
  // sends an orphan `tool_result`, which tool-using providers reject outright
  // (HTTP 400) before the historian ever sees a token. The skipped node that
  // exposed it (a tool-call-only assistant, an already-digested or placeholder
  // producer) is not eligible either, so skip the whole unpaired run.
  while (start < nodes.length && (nodes[start] as SurfaceNode).role === 'tool') start += 1
  if (start >= nodes.length) return undefined

  let cut = Math.max(start, nodes.length - Math.max(0, input.protectedNodes))
  // TOOL-PAIRING, both edges: never end the span on a `tool` result (its
  // producer would be inside while the result is out) and never end it on an
  // assistant that REQUESTED tools (the request would carry a dangling
  // `tool_use`). Dropping the call — and the results it would have dragged
  // along — costs a little digest scope and keeps the auxiliary request valid.
  for (;;) {
    while (cut > start && (nodes[cut] as SurfaceNode | undefined)?.role === 'tool') cut -= 1
    if (cut > start && (nodes[cut - 1] as SurfaceNode | undefined)?.hasToolCalls === true) {
      cut -= 1
      continue
    }
    break
  }
  const slice = nodes.slice(start, cut)
  if (slice.length < Math.max(1, input.minNodes)) return undefined
  const tokens = slice.reduce((total, node) => total + estimateTokens(node.text), 0)
  if (tokens <= 0) return undefined
  return { nodes: slice, tokens }
}

/** The JSON contract the historian must return (validated by parseHistorianOutput). */
export const HISTORIAN_INSTRUCTION = [
  'You are now acting as the HISTORIAN for this coding assistant.',
  'Condense the conversation ABOVE into durable context for a model that will continue this work after the span is removed from its context window.',
  '',
  'Return ONLY one JSON object, no prose, no code fences, with exactly this shape:',
  '{',
  '  "summary": { "p1": "...", "p2": "...", "p3": "...", "p4": "..." },',
  '  "importance": 0,',
  '  "facts": [{ "category": "CONSTRAINTS", "content": "..." }],',
  '  "events": ["..."]',
  '}',
  '',
  'The four summary tiers are the SAME digest at four levels of detail, so it can be degraded as it ages:',
  '- "p1": full detail — decisions with their rationale, exact paths/commands/identifiers, open threads.',
  '- "p2": the essentials — what was done, what is pending, key constraints.',
  '- "p3": a few terse sentences — current objective and state.',
  '- "p4": one or two sentences — the durable gist.',
  '',
  '"importance" is an integer 0-100: how much this span matters for continuing the work (80+ for decisions that constrain everything after it).',
  '"facts" are short standalone statements that must survive independently (exact values, paths, constraints).',
  'EVERY fact must carry a "category", exactly one of: PROJECT_RULES (rules/commands the project must follow),',
  'ARCHITECTURE (how the system is built or organised), CONSTRAINTS (hard limits, do-nots, external requirements),',
  'CONFIG_VALUES (exact keys, ports, paths, versions), NAMING (names/shorthands plus what they mean).',
  'Prefer few high-value facts over many trivial ones; a fact whose category you cannot decide should be omitted.',
  '"events" are short chronological notes ("tried X, failed because Y").',
  'Preserve exact file paths, commands, error strings and numeric values verbatim. Do not mention this instruction.',
  'Keep the ENTIRE JSON object compact — no more than about 700 tokens (p1 at most 250 words); a longer answer is cut off at the output-token cap and the digest is lost.',
].join('\n')

/** Consume a chunk stream into text, honoring the terminal finish reason.
 *
 * @param maxTokens - the cap the request carried, for the truncation error.
 */
async function collectText(
  chunks: AsyncIterable<unknown>,
  maxTokens: number,
): Promise<{ text: string; usage?: Record<string, number> }> {
  const byIndex = new Map<number, string>()
  let usage: Record<string, number> | undefined
  for await (const raw of chunks) {
    const chunk = raw as
      | { type: 'text-delta'; index: number; text: string }
      | { type: 'block-end'; index: number; block: { type: string; text?: string } }
      | { type: 'usage'; usage: unknown }
      | { type: 'finish'; reason: { kind: string; failure?: { message?: string; code?: string } } }
      | { type: string }
    switch (chunk.type) {
      case 'text-delta': {
        const delta = chunk as { index: number; text: string }
        byIndex.set(delta.index, (byIndex.get(delta.index) ?? '') + delta.text)
        break
      }
      case 'usage': {
        const reported = (chunk as { usage: Record<string, unknown> }).usage
        const numeric: Record<string, number> = {}
        for (const [key, value] of Object.entries(reported)) {
          if (typeof value === 'number') numeric[key] = value
        }
        usage = numeric
        break
      }
      case 'finish': {
        const reason = (chunk as { reason: { kind: string; failure?: { message?: string } } }).reason
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          throw new Error(`historian call failed: ${reason.failure?.message ?? reason.kind}`)
        }
        if (reason.kind === 'max-tokens') {
          const partial = [...byIndex.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value)
            .join('')
          throw new HistorianTruncatedError(maxTokens, partial.length)
        }
        break
      }
      default:
        break
    }
  }
  const text = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
  return { text, ...usage === undefined ? {} : { usage } }
}

/** In-flight sessions: Magic Context never runs two historians for one session. */
const inFlight = new Set<string>()

/**
 * One attempt's stream, bounded by the run's remaining wall-clock budget.
 *
 * The budget is enforced twice on purpose: the abort signal tells a compliant
 * provider stream to stop (so the socket is released), and `Promise.race`
 * rejects even when the seam ignores the signal entirely. Without the race a
 * host whose `llm.stream()` never settles would leave the run — and the
 * session's `inFlight` slot — hanging forever, which is exactly the "start
 * with no terminal event" failure this guards.
 */
async function collectAttempt(
  deps: Pick<HistorianDeps, 'llm'>,
  options: HistorianStreamOptions,
  budgetMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<{ text: string; usage?: Record<string, number> }> {
  const controller = new AbortController()
  const relayAbort = (): void => controller.abort(outerSignal?.reason)
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) relayAbort()
    else outerSignal.addEventListener('abort', relayAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new HistorianTimeoutError(budgetMs))
    }, budgetMs)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([
      collectText(deps.llm.stream({ ...options, signal: controller.signal }), options.maxTokens),
      expiry,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', relayAbort)
  }
}

/** Why a historian run produced no digest, in the journal's vocabulary. */
function classifyFailure(error: unknown): string {
  if (error instanceof HistorianTimeoutError) return 'timeout'
  if (error instanceof HistorianTruncatedError) return 'max-tokens'
  if (error instanceof HistorianOutputError) return 'invalid-output'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'stream-error'
}

/**
 * The cap one attempt carries: the floor-respecting cap, doubled on retry and
 * clamped to the ceiling (`HISTORIAN_MAX_OUTPUT_TOKENS` unless the policy
 * carries an explicit `historianMaxTokensCeiling`).
 */
function attemptOutputCap(effective: number, attempt: number, ceiling = HISTORIAN_MAX_OUTPUT_TOKENS): number {
  return Math.min(ceiling, effective * 2 ** attempt)
}

/**
 * The retry ceiling, read defensively: `historianMaxTokensCeiling` is an
 * optional policy key, so this adapter works both with and without the Config
 * entry. The ceiling is never allowed below the first attempt's cap.
 */
function retryCeiling(policy: PressurePolicy, effective: number): number {
  const configured = (policy as { readonly historianMaxTokensCeiling?: number }).historianMaxTokensCeiling
  const ceiling = Math.min(
    HISTORIAN_MAX_OUTPUT_TOKENS,
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : HISTORIAN_MAX_OUTPUT_TOKENS,
  )
  return Math.max(effective, ceiling)
}

/**
 * Split an oversized span into contiguous chunks of about `chunkTokens`
 * tokens (never splitting a node, at most 4 chunks, only when the span is at
 * least 4 nodes — smaller spans digest in one call exactly as before).
 */
export function planChunkSpans(
  nodes: readonly SurfaceNode[],
  spanTokens: number,
  chunkTokens?: number,
): readonly (readonly SurfaceNode[])[] {
  if (chunkTokens === undefined || chunkTokens <= 0 || spanTokens <= chunkTokens || nodes.length < 4) {
    return [nodes]
  }
  const count = Math.min(4, Math.max(2, Math.ceil(spanTokens / chunkTokens)))
  const target = Math.ceil(spanTokens / count)
  const groups: SurfaceNode[][] = []
  let current: SurfaceNode[] = []
  let acc = 0
  for (const node of nodes) {
    current.push(node)
    acc += Math.max(1, Math.ceil(node.text.length / 4))
    if (acc >= target && groups.length < count - 1) {
      groups.push(current)
      current = []
      acc = 0
    }
  }
  if (current.length > 0) groups.push(current)
  return groups.length > 0 ? groups : [nodes]
}

/** The merge step's contract: one final JSON object from the partial digests. */
export const HISTORIAN_MERGE_INSTRUCTION = [
  'You are the HISTORIAN merging PARTIAL digests of ONE long span into the final single JSON object.',
  'Return ONLY one JSON object with exactly the same shape: summary {p1,p2,p3,p4}, importance, facts [{category,content}], events.',
  'Merge and deduplicate the partials; keep the most durable facts; preserve exact paths, commands and error strings verbatim.',
  'p1 at most 250 words; the other tiers one or two sentences each; at most about 700 tokens overall.',
].join('\n')

/**
 * Run the historian's auxiliary call over a span and return the validated
 * digest WITHOUT storing it (the manual/checkpoint path owns the result).
 *
 * Every exit after the `start` event writes exactly one terminal event:
 * `done` on a validated digest, `failed` (with `reason`, `durationMs`,
 * `attempts`) on every other outcome. The two repair attempts share ONE
 * wall-clock budget so the run cannot outlive `timeoutMs`.
 */
export async function callHistorian(
  deps: Pick<HistorianDeps, 'policy' | 'llm' | 'logger' | 'route' | 'now' | 'journal' | 'timeoutMs'>,
  input: {
    readonly sessionId: string
    readonly session: Parameters<typeof spanRequestMessages>[0]
    readonly nodes: readonly SurfaceNode[]
    readonly route?: { provider: string; model: string }
    readonly signal?: AbortSignal
    /** The system head seq, replayed first for prefix-cache fidelity. */
    readonly systemSeq?: number
    /** Set by the manual (checkpoint) path so the journal can attribute the run. */
    readonly trigger?: 'automatic' | 'manual'
    /**
     * D1: when given and the span exceeds it, the span is digested in
     * contiguous chunks of about this many tokens and a final merge call
     * combines the partial digests. The per-call wall-clock budget scales
     * with the chunk count, capped at 600s (MC's historian budget).
     */
    readonly chunkTokens?: number
  },
): Promise<CompartmentDraft> {
  const route = deps.route ?? input.route
  if (route === undefined || route.provider.length === 0 || route.model.length === 0) {
    throw new Error('no routed provider/model available for the historian call')
  }
  const trigger = input.trigger ?? 'automatic'
  const spanTokens = input.nodes.reduce(
    (total, node) => total + Math.max(1, Math.ceil(node.text.length / 4)),
    0,
  )
  const clock = deps.now ?? Date.now
  const startedAt = clock()
  const timeoutMs = deps.timeoutMs ?? deps.policy.historianTimeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS
  // A cap below the contract floor is a guaranteed truncation, not a
  // preference: the production failure was `historianMaxTokens: 2048`, which
  // the model spent on reasoning before the JSON ever closed.
  const configuredMaxTokens = deps.policy.historianMaxTokens
  const effectiveMaxTokens = Math.min(
    HISTORIAN_MAX_OUTPUT_TOKENS,
    Math.max(HISTORIAN_MIN_OUTPUT_TOKENS, configuredMaxTokens),
  )
  const ceiling = retryCeiling(deps.policy, effectiveMaxTokens)
  // Everything that can throw is prepared BEFORE the `start` row. The invariant
  // is "no row, or `start` + exactly one terminal sibling", and a preparation
  // failure (e.g. a session store that throws inside `spanRequestMessages`)
  // must not be able to leave a `start` without its terminal event.
  const coveredSeqs = input.nodes.map(node => node.seq)
  const chunks = planChunkSpans(input.nodes, spanTokens, input.chunkTokens)
  const merging = chunks.length > 1
  const plannedCalls = chunks.length + (merging ? 1 : 0)
  // D3: the run budget scales with the call count (per-call attempts share
  // it), capped at MC's 600s historian wall clock. The extra slot reserves
  // budget for the merge call — measured live (the 17:50 timeout): four
  // chunks with retries spent ~5.9min of the 4×180s budget, leaving the
  // merge 129s, which it overran.
  const deadline = startedAt + Math.min(600_000, timeoutMs * plannedCalls + (merging ? timeoutMs : 0))
  const spanSeqsOf = (call: number): number[] =>
    (chunks[Math.min(call, chunks.length - 1)] as readonly SurfaceNode[]).map(node => node.seq)
  const replayOf = (call: number): unknown[] => {
    const seqs = spanSeqsOf(call)
    return spanRequestMessages(
      input.session,
      input.systemSeq === undefined ? seqs : [input.systemSeq, ...seqs],
    )
  }
  const baseMessages = [
    ...replayOf(0),
    { role: 'user', content: [{ type: 'text', text: HISTORIAN_INSTRUCTION }] },
  ]
  const baseData = {
    trigger,
    nodes: input.nodes.length,
    tokens: spanTokens,
    route: `${route.provider}/${route.model}`,
    maxTokens: effectiveMaxTokens,
    ...effectiveMaxTokens === configuredMaxTokens ? {} : { configuredMaxTokens },
    timeoutMs,
    ...merging ? { chunks: chunks.length } : {},
  }
  deps.journal?.info('historian', `historian ${trigger} run started over ${String(input.nodes.length)} nodes${merging ? ` in ${String(chunks.length)} chunks` : ''}`, {
    phase: 'start',
    trigger,
    nodes: input.nodes.length,
    tokens: spanTokens,
    route: `${route.provider}/${route.model}`,
    maxTokens: effectiveMaxTokens,
    ...effectiveMaxTokens === configuredMaxTokens ? {} : { configuredMaxTokens },
    timeoutMs,
    ...merging ? { chunks: chunks.length } : {},
  }, input.sessionId)
  let terminal = false
  let attempts = 0
  let failure: Error | undefined
  // The stage a failure should be attributed to: updated as the run advances
  // ('start' → 'chunk 2/4' → 'merge'), so the failed row says WHERE it died.
  let stage = 'start'
  try {
    const partials: CompartmentDraft[] = []
    let finalDraft: CompartmentDraft | undefined
    let lastCap = effectiveMaxTokens
    for (let call = 0; call < plannedCalls; call += 1) {
      const isMerge = merging && call === plannedCalls - 1
      stage = isMerge ? 'merge' : `chunk ${String(call + 1)}/${String(chunks.length)}`
      if (isMerge) {
        // The merge was invisible until it timed out (the 17:50 failure) —
        // give it the same per-call beat the chunks have.
        deps.journal?.info('historian', `historian merging ${String(partials.length)} partial digest(s)`, {
          phase: 'merge',
          partials: partials.length,
          ...baseData,
        }, input.sessionId)
      }
      const baseMessagesForCall = isMerge
        ? [
          {
            role: 'user',
            content: [{
              type: 'text',
              text: `${HISTORIAN_MERGE_INSTRUCTION}\n\n${partials
                .map((partial, index) => `Partial digest ${String(index + 1)}:\n${JSON.stringify(partial)}`)
                .join('\n\n')}`,
            }],
          },
        ]
        : call === 0
          ? baseMessages
          : [
            ...replayOf(call),
            { role: 'user', content: [{ type: 'text', text: HISTORIAN_INSTRUCTION }] },
          ]
      let callDraft: CompartmentDraft | undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        attempts += 1
        const maxTokens = attemptOutputCap(effectiveMaxTokens, attempt, ceiling)
        lastCap = maxTokens
        const truncated = failure instanceof HistorianTruncatedError
        const messages = attempt === 0
          ? baseMessagesForCall
          : [
            ...baseMessagesForCall,
            {
              role: 'user',
              content: [{
                type: 'text',
                text: truncated
                  ? `Your previous response was cut off at the ${String(attemptOutputCap(effectiveMaxTokens, attempt - 1, ceiling))}-token output cap before the JSON closed. `
                    + 'Return ONLY the JSON object, and keep it far shorter: p1 at most 150 words, the other tiers one or two sentences.'
                  : `Your previous response was rejected: ${failure?.message ?? 'invalid output'}. `
                    + 'Return ONLY the JSON object described above.',
              }],
            },
          ]
        const budgetMs = deadline - clock()
        if (budgetMs <= 0) throw new HistorianTimeoutError(timeoutMs)
        try {
          const collected = await collectAttempt(deps, {
            provider: route.provider,
            model: route.model,
            messages,
            maxTokens,
            sessionId: input.sessionId,
            purpose: 'compaction',
          }, budgetMs, input.signal)
          const parsed = parseHistorianOutput(collected.text)
          if (isMerge) {
            finalDraft = parsed
          } else {
            partials.push(parsed)
            if (merging) {
              deps.journal?.info(
                'historian',
                `historian chunk ${String(call + 1)}/${String(chunks.length)} digested (importance ${String(parsed.importance)})`,
                {
                  phase: 'chunk',
                  index: call + 1,
                  of: chunks.length,
                  nodes: (chunks[call] as readonly SurfaceNode[]).length,
                  importance: parsed.importance,
                  facts: parsed.facts.length,
                  events: parsed.events.length,
                  attempts,
                },
                input.sessionId,
              )
            }
          }
          callDraft = parsed
          break
        } catch (error) {
          // Truncation and a rejected digest are retryable (once, with a longer
          // cap or a repair nudge). A provider or transport failure is not: the
          // request itself failed, so retrying it would only double the cost.
          if (!(error instanceof HistorianTruncatedError) && !(error instanceof HistorianOutputError)) throw error
          failure = error
          deps.logger.warn(
            `magic-context historian: ${merging ? `call ${String(call + 1)}/${String(plannedCalls)} ` : ''}attempt ${String(attempt + 1)} rejected at ${String(maxTokens)} tokens (${failure.message})`,
          )
        }
      }
      if (callDraft === undefined) throw failure ?? new Error('historian produced no digest')
    }
    const draft = finalDraft ?? partials[0]
      ?? (() => { throw new Error('historian produced no digest') })()
    deps.journal?.info(
      'historian',
      `historian digest ready (importance ${String(draft.importance)}, ${String(input.nodes.length)} nodes)`,
      {
        phase: 'done',
        ...baseData,
        maxTokens: lastCap,
        importance: draft.importance,
        facts: draft.facts.length,
        events: draft.events.length,
        attempts,
        durationMs: clock() - startedAt,
      },
      input.sessionId,
    )
    terminal = true
    return draft
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // The invariant this repairs: a `start` row with no terminal sibling is
    // indistinguishable from a wedged run. Anything that escapes the attempt
    // loop — provider errors, aborted streams, the timeout, an invalid digest
    // twice — lands here exactly once.
    if (!terminal) {
      terminal = true
      deps.journal?.error('historian', `historian run failed (${classifyFailure(error)}): ${reason}`, {
        phase: 'failed',
        ...baseData,
        // WHERE it died: the merge after a long chunk run is the observed
        // failure point (the 17:50 timeout), so name the stage explicitly.
        stage,
        kind: classifyFailure(error),
        reason,
        errorName: error instanceof Error ? error.name : typeof error,
        attempts,
        durationMs: clock() - startedAt,
        // The measured shape of a truncation: how much of the answer made it
        // out before the cap. 0 chars ⇒ the budget was spent on reasoning;
        // a long partial ⇒ the requested digest itself is too big.
        ...error instanceof HistorianTruncatedError
          ? { maxTokens: error.maxTokens, partialChars: error.partialChars }
          : {},
      }, input.sessionId)
    }
    deps.logger.warn(`magic-context historian: run failed (${classifyFailure(error)}): ${reason}`)
    throw error
  }
}

/**
 * Run one historian pass for a session. Returns the stored compartment, or
 * undefined when nothing was eligible / a run is already in flight. Throws
 * only for call or contract failures (the caller logs and continues).
 */
export async function runHistorian(
  deps: HistorianDeps,
  input: {
    readonly sessionId: string
    readonly nodes: readonly SurfaceNode[]
    readonly baselineNodeSeq?: number
    readonly contextWindow?: number
    readonly route?: { provider: string; model: string }
    readonly signal?: AbortSignal
    readonly session: Parameters<typeof spanRequestMessages>[0]
    /** Explicit span (the manual/region path); default is the eligibility scan. */
    readonly forcedRange?: readonly SurfaceNode[]
  },
): Promise<Compartment | undefined> {
  if (inFlight.has(input.sessionId)) return undefined
  const range = input.forcedRange !== undefined
    ? { nodes: input.forcedRange, tokens: input.forcedRange.reduce((total, node) => total + estimateTokens(node.text), 0) }
    : selectHistorianRange({
      nodes: input.nodes,
      covered: deps.stores.coveredSeqs(input.sessionId),
      ...input.baselineNodeSeq === undefined ? {} : { baselineNodeSeq: input.baselineNodeSeq },
      protectedNodes: deps.policy.historianProtectedNodes,
      minNodes: deps.policy.historianMinNodes,
    })
  if (range === undefined) return undefined
  const budget = historianTriggerBudget(
    input.contextWindow,
    deps.policy.historianAssumedWindow,
    deps.policy.historianMinBudgetTokens,
  )
  if (input.forcedRange === undefined && range.tokens < budget) {
    deps.logger.info(
      `magic-context historian: eligible span ${String(range.tokens)} tokens is below the ${String(budget)}-token trigger`,
    )
    return undefined
  }

  inFlight.add(input.sessionId)
  const now = deps.now?.() ?? Date.now()
  try {
    const draft = await callHistorian(deps, {
      sessionId: input.sessionId,
      session: input.session,
      nodes: range.nodes,
      trigger: 'automatic',
      // D1/D3: an oversized span digests in ~budget-token chunks with a merge
      // call; the run budget scales with the chunk count (capped 600s).
      chunkTokens: budget,
      ...input.route === undefined ? {} : { route: input.route },
      ...input.signal === undefined ? {} : { signal: input.signal },
      ...input.nodes.find(node => node.role === 'system')?.seq === undefined
        ? {}
        : { systemSeq: input.nodes.find(node => node.role === 'system')?.seq as number },
    })
    const baselineEpoch = deps.stores.baselineState(input.sessionId)?.epoch ?? 0
    const first = range.nodes[0] as SurfaceNode
    const last = range.nodes[range.nodes.length - 1] as SurfaceNode
    const compartment = deps.stores.allocateCompartment(input.sessionId, draft, {
      startSeq: first.seq,
      endSeq: last.seq,
      seqs: range.nodes.map(node => node.seq),
      tokens: range.tokens,
    }, baselineEpoch, now)
    deps.logger.info(
      `magic-context historian: compartment §C${String(compartment.compartmentId)}§ stored `
        + `(${String(range.nodes.length)} nodes, ~${String(range.tokens)} tokens, importance ${String(draft.importance)})`,
    )
    deps.journal?.info(
      'historian',
      `compartment §C${String(compartment.compartmentId)}§ stored (~${String(range.tokens)} tokens, importance ${String(draft.importance)})`,
      {
        phase: 'stored',
        compartmentId: compartment.compartmentId,
        nodes: range.nodes.length,
        tokens: range.tokens,
        importance: draft.importance,
        coveredStartSeq: first.seq,
        coveredEndSeq: last.seq,
      },
      input.sessionId,
    )
    return compartment
  } finally {
    inFlight.delete(input.sessionId)
  }
}

