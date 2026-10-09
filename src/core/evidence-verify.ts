/**
 * The evidence pass — stage 2 of the verify lane. The IDEA is mon3stera's
 * (dsh-magic-context's Dreamer verifies memories AGAINST the codebase, not
 * against their own text — our stage-1 verify is explicitly text-only); the
 * SHAPE is deliberately different: instead of a read-only tool loop, the CODE
 * builds a bounded evidence pack — deterministic case-insensitive greps for
 * the memory's own terms, size-capped excerpts — and ONE text-only auxiliary
 * call judges the flagged rows against it.
 *
 * Why not the tool loop: this repo's auxiliary-call discipline is the
 * historian's — model-free I/O, one JSON contract, no tool seam to verify —
 * and a deterministic pack bounds the cost to exactly one call.
 *
 * The verdicts are PROPOSALS: the caller applies them through the writer
 * contract (updateMemory/archiveMemory/markVerified), so the mutation log and
 * the authority guard stay authoritative — LLM marks, code disposes.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { Journal } from './journal.ts'
import type { MaintenanceLlm } from './maintenance.ts'

const MAX_READ_CHARS = 65_536
const MAX_GREP_MATCHES = 200
const MAX_LINE_CHARS = 240
/** Same ceiling reasoning as the verify lane's VERIFY_MAX_TOKENS. */
const MAX_OUTPUT_TOKENS = 32_768

export interface EvidenceRowInput {
  readonly id: number
  readonly category: string
  readonly content: string
  /** The stage-1 (text-only) flag this pass is checking. */
  readonly verdict: 'stale' | 'wrong'
  /** Stage-1's proposed correction ('stale'). */
  readonly proposedContent?: string
  /** Stage-1's stated reason. */
  readonly stageReason?: string
}

export type EvidenceVerdict = 'confirmed' | 'overturned' | 'uncertain'

export interface EvidenceRowVerdict {
  readonly id: number
  readonly verdict: EvidenceVerdict
  /** The corrected content for a confirmed 'stale' row. */
  readonly content?: string
  readonly reason?: string
}

export interface EvidenceOutcome {
  readonly verdicts: ReadonlyMap<number, EvidenceRowVerdict>
  /** Grep hits the pack found per row — 0 is an honest "no evidence". */
  readonly evidenceCounts: ReadonlyMap<number, number>
  readonly packChars: number
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'must', 'when', 'then', 'than', 'into', 'only', 'also',
  'should', 'would', 'been', 'they', 'them', 'were', 'more', 'some', 'such', 'each', 'make',
  'made', 'using', 'used', 'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'its', 'can',
  'will', 'may', 'per', 'via', 'etc',
])

/** The memory's own concrete terms — paths, identifiers and numbers first. */
export function evidenceTerms(content: string, maxTerms = 4): string[] {
  const tokens = content.match(/[\p{L}\p{N}_.:/\\-]{4,}/gu) ?? []
  const seen = new Set<string>()
  const scored: Array<{ token: string; score: number }> = []
  for (const raw of tokens) {
    const token = raw.replace(/^[.\-/\\:]+|[.\-/\\:]+$/g, '')
    const key = token.toLowerCase()
    if (token.length < 4 || seen.has(key)) continue
    seen.add(key)
    const isWord = /^\p{L}+$/u.test(token)
    if (isWord && STOP_WORDS.has(key)) continue
    const hasPath = /[/\\]/.test(token) || /\.[\p{L}\d]{1,5}$/u.test(token)
    const hasDigit = /\d/.test(token)
    scored.push({
      token,
      score: (hasPath ? 3 : 0) + (hasDigit ? 2 : 0) + (isWord ? 0 : 1) + Math.min(2, token.length / 16),
    })
  }
  return scored.sort((left, right) => right.score - left.score).slice(0, maxTerms).map(entry => entry.token)
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function insideRoot(root: string, path: string): string {
  const resolved = resolve(root, path)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes the workspace root: ${path}`)
  }
  return resolved
}

async function grepTree(root: string, term: string, maxMatches: number): Promise<string[]> {
  const needle = new RegExp(escapeRegExp(term), 'i')
  const matches: string[] = []
  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxMatches) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= maxMatches) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (info.size > MAX_READ_CHARS * 4) continue
        const text = await readFile(full, 'utf8')
        const lines = text.split('\n')
        for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
          const line = lines[index]
          if (line === undefined) continue
          if (needle.test(line)) {
            matches.push(
              `${relative(root, full).replaceAll('\\', '/')}:${String(index + 1)}: ${line.slice(0, MAX_LINE_CHARS)}`,
            )
          }
        }
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  await walk(root)
  return matches
}

export interface EvidencePack {
  readonly sections: readonly string[]
  readonly evidenceCounts: ReadonlyMap<number, number>
  readonly packChars: number
}

/** The deterministic half: grep each row's own terms, cap the excerpts. */
export async function buildEvidencePack(
  root: string,
  rows: readonly EvidenceRowInput[],
  options?: { readonly maxTerms?: number; readonly matchesPerTerm?: number; readonly maxCharsPerRow?: number },
): Promise<EvidencePack> {
  const maxTerms = options?.maxTerms ?? 4
  const matchesPerTerm = options?.matchesPerTerm ?? 6
  const maxCharsPerRow = options?.maxCharsPerRow ?? 2_400
  const sections: string[] = []
  const evidenceCounts = new Map<number, number>()
  let packChars = 0
  for (const row of rows) {
    const terms = evidenceTerms(row.content, maxTerms)
    const lines: string[] = []
    let count = 0
    for (const term of terms) {
      try {
        const found = await grepTree(root, term, matchesPerTerm)
        count += found.length
        lines.push(...found)
      } catch {
        /* an escaped root or unreadable tree: the term contributes nothing */
      }
    }
    evidenceCounts.set(row.id, count)
    const header = `Memory #${String(row.id)} [${row.category}] — ${String(count)} grep hit(s) for [${terms.join(', ') || 'no terms'}]:`
    const body = lines.slice(0, 24).join('\n')
    const section = `${header}\n${body.length > 0 ? body : '(no matches in the workspace)'}`.slice(0, maxCharsPerRow)
    packChars += section.length
    sections.push(section)
  }
  return { sections, evidenceCounts, packChars }
}

const EVIDENCE_INSTRUCTION = [
  'You are auditing project memories against REAL code excerpts grepped from the workspace.',
  'Each memory below carries a stage-1 flag ("stale" = outdated, with a proposed correction; "wrong" = harmful, with a reason) and the excerpts found for its own terms.',
  'For every memory decide, citing ONLY what the excerpts show:',
  '- "confirmed": the evidence supports the flag — for a stale memory you MUST provide the corrected "content" (same style, self-contained).',
  '- "overturned": the evidence contradicts the flag — the memory is fine as written.',
  '- "uncertain": the excerpts are insufficient. Never invent provenance; a memory that records an explicit user instruction stays unless the evidence is conclusive.',
  'Reply with ONLY one JSON object: {"verdicts":[{"id":<number>,"verdict":"confirmed"|"overturned"|"uncertain","content"?:string,"reason"?:string}]}',
].join('\n')

/** Salvage complete `{...}` objects from a truncated verdict array (the same
 *  discipline as the verify lane: a reasoning model cut off mid-array still
 *  banks its leading verdicts). Duplicated on purpose so the two lanes share
 *  no runtime import cycle — the vocabularies differ anyway. */
function salvageObjects(inner: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(inner.slice(start, index + 1)))
        } catch {
          /* skip malformed object */
        }
        start = -1
      }
    }
  }
  return out
}

interface ParsedEvidenceVerdict {
  readonly id: number
  readonly verdict: EvidenceVerdict
  readonly content?: string
  readonly reason?: string
}

function parseEvidenceVerdicts(text: string): ParsedEvidenceVerdict[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  const slice = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    const arrayStart = slice.indexOf('[')
    if (arrayStart < 0) return []
    parsed = { verdicts: salvageObjects(slice.slice(arrayStart + 1)) }
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts
  if (!Array.isArray(verdicts)) return []
  const out: ParsedEvidenceVerdict[] = []
  for (const item of verdicts) {
    const row = item as { id?: unknown; verdict?: unknown; content?: unknown; reason?: unknown }
    if (typeof row.id !== 'number') continue
    if (row.verdict !== 'confirmed' && row.verdict !== 'overturned' && row.verdict !== 'uncertain') continue
    out.push({
      id: row.id,
      verdict: row.verdict,
      ...(typeof row.content === 'string' && row.content.trim().length > 0 ? { content: row.content.trim() } : {}),
      ...(typeof row.reason === 'string' && row.reason.trim().length > 0 ? { reason: row.reason.trim() } : {}),
    })
  }
  return out
}

/**
 * Run one evidence pass over the flagged rows. Throws only for call
 * failures — the caller's fail-open handling decides what stage-1 outcome
 * stands. Hallucinated ids are dropped; truncated output banks its verdicts.
 */
export async function runEvidenceVerify(
  deps: {
    readonly llm: MaintenanceLlm
    readonly route: { readonly provider: string; readonly model: string }
    readonly journal: Journal
    readonly sessionId?: string
  },
  root: string,
  rows: readonly EvidenceRowInput[],
): Promise<EvidenceOutcome> {
  const pack = await buildEvidencePack(root, rows)
  const brief = rows
    .map((row, index) => {
      const flag = row.verdict === 'stale'
        ? `stage-1 flag: stale${row.proposedContent !== undefined ? ` (proposed: ${row.proposedContent.slice(0, 200)})` : ''}`
        : `stage-1 flag: wrong${row.stageReason !== undefined ? ` (${row.stageReason.slice(0, 200)})` : ''}`
      return [`#${String(row.id)} [${row.category}] ${flag}`, `current: ${row.content.slice(0, 400)}`, pack.sections[index] ?? ''].join('\n')
    })
    .join('\n\n')
  const prompt = `${EVIDENCE_INSTRUCTION}\n\n${brief}`
  const byIndex = new Map<number, string>()
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let truncated = false
  const chunks = deps.llm.stream({
    provider: deps.route.provider,
    model: deps.route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: MAX_OUTPUT_TOKENS,
    sessionId: deps.sessionId ?? 'mc-maintenance',
    purpose: 'compaction',
  })
  for await (const raw of chunks) {
    const chunk = raw as
      | { type: 'text-delta'; index: number; text: string }
      | { type: 'usage'; usage: Record<string, unknown> }
      | { type: 'finish'; reason: { kind: string; failure?: { message?: string } } }
      | { type: string }
    if (chunk.type === 'text-delta') {
      const delta = chunk as { index: number; text: string }
      byIndex.set(delta.index, (byIndex.get(delta.index) ?? '') + delta.text)
    } else if (chunk.type === 'usage') {
      const numeric: Record<string, number> = {}
      for (const [key, value] of Object.entries((chunk as { usage: Record<string, unknown> }).usage ?? {})) {
        if (typeof value === 'number') numeric[key] = value
      }
      usage = { inputTokens: numeric.inputTokens ?? 0, outputTokens: numeric.outputTokens ?? 0 }
    } else if (chunk.type === 'finish') {
      const reason = (chunk as { reason: { kind: string; failure?: { message?: string } } }).reason
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new Error(`evidence call failed: ${reason.failure?.message ?? reason.kind}`)
      }
      if (reason.kind === 'max-tokens') truncated = true
    }
  }
  const text = [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('')
  if (text.trim().length === 0) {
    throw new Error(truncated ? 'evidence call hit max-tokens with no text' : 'evidence call produced no text')
  }
  const verdicts = new Map<number, EvidenceRowVerdict>()
  for (const parsed of parseEvidenceVerdicts(text)) {
    // A verdict for an id the pack never carried is a hallucination: drop it.
    if (!pack.evidenceCounts.has(parsed.id)) continue
    verdicts.set(parsed.id, parsed)
  }
  deps.journal.info(
    'evidence-verify',
    `evidence pass: ${String(verdicts.size)} verdict(s) over ${String(rows.length)} flagged row(s), pack ${String(pack.packChars)} chars`,
    {
      rows: rows.length,
      packChars: pack.packChars,
      evidenceCounts: [...pack.evidenceCounts].map(([id, count]) => ({ id, count })),
      ...(usage === undefined ? {} : { usage }),
      ...(truncated ? { truncated: true } : {}),
      route: `${deps.route.provider}/${deps.route.model}`,
    },
    deps.sessionId,
  )
  return {
    verdicts,
    evidenceCounts: pack.evidenceCounts,
    packChars: pack.packChars,
    ...usage === undefined ? {} : { usage },
  }
}
