/**
 * Classifying a historian failure by WHAT KIND of failure it is.
 *
 * Why this exists
 * ---------------
 * The report's health line said "historian 失败率 53.4%" for a window in which
 * the 47 failures were: 32 the account's 7-day quota being exhausted, 9
 * timeouts, 6 malformed model output. The arithmetic was right and the reading
 * was wrong — "the historian is failing half the time" when the pipeline was
 * fine and the account was out of budget. A number that cannot be acted on is
 * worse than no number, because it gets dismissed.
 *
 * So failures are split by the action they call for:
 *
 *   environment:quota   the account/provider is out of budget — nothing to fix
 *                       in the plugin, and memory ingestion is DOWN until it
 *                       resets (the message usually carries the reset time)
 *   pipeline:truncated  the digest did not fit the output cap, so the call came
 *                       back cut off. Not transient: retrying the same chunk
 *                       fails the same way. The fix is capacity (chunk size or
 *                       output cap), not a retry.
 *   pipeline:request-shape  the provider rejected the REQUEST (400
 *                       invalid_request_error, e.g. a malformed tool-message
 *                       block). Deterministic: retrying the identical request
 *                       fails identically, so the retry loop is pure waste —
 *                       this one needs a code fix, not more attempts.
 *   environment:network  transport trouble; retry later
 *   environment:provider the provider is overloaded (5xx); retry later
 *   environment:timeout  the call ran too long; a budget/model question
 *   pipeline:output      the model produced something unparseable
 *   other:<kind>         not yet classified; keep the kind visible rather than
 *                        burying it in a bucket called "other"
 *
 * Self-check, and why `truncated` is its own class: the first version of this
 * file matched `/stream-error/` as network trouble, and a live re-read of all 47
 * failures showed the 29 "network" ones were every one of them
 * "historian call truncated at the token cap (incomplete digest)" — a capacity
 * problem wearing a transport label. The lesson from this repo's own rules
 * applies: a classifier is a sentinel, so check it against the real corpus
 * before trusting its output.
 *
 * Kept in its own module, and out of mc-report.mjs, so the classifier itself is
 * unit-testable: a misclassification here silently re-labels production health.
 */

const QUOTA_PATTERNS = [
  /\b429\b/,
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /insufficient/i,
  /已达到\s*\d+\s*天使用上限/,
  /使用上限/,
  /超额/,
]

const TRUNCATED_PATTERNS = [
  /truncated/i,
  /token cap/i,
  /incomplete digest/i,
  /output cap/i,
  /截断/,
]

const TIMEOUT_PATTERNS = [/timeout/i, /timed out/i, /ETIMEDOUT/i, /超时/]

const REQUEST_SHAPE_PATTERNS = [
  /invalid_request_error/,
  /unexpected\s+`?[\w.*]+\.content\.\d/,
  /tool_use_id/,
]

const PROVIDER_PATTERNS = [/\b50[0-9]\b/, /cpu overloaded/i, /overloaded/i, /server error/i]

const NETWORK_PATTERNS = [
  /connection error/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /socket hang up/i,
  /\bterminated\b/i,
  /network/i,
]
const OUTPUT_PATTERNS = [
  /invalid JSON/i,
  /HistorianOutputError/,
  /invalid-output/,
  /output rejected/i,
  /must be an object/i,
  /JSON at position/i,
]

function matches(patterns, text) {
  return patterns.some(pattern => pattern.test(text))
}

/**
 * @param {string} kind   the failure `kind` field (e.g. stream-error, timeout)
 * @param {string} reason the failure `reason` text (carries the provider message)
 * @returns {string} the cause label
 */
export function classifyHistorianFailure(kind, reason) {
  const text = `${kind ?? ''} ${reason ?? ''}`
  // Quota first: a 429 arrives as a `stream-error`, and calling that a network
  // problem would send someone looking for a broken socket.
  if (matches(QUOTA_PATTERNS, text)) return 'environment:quota'
  if (matches(TRUNCATED_PATTERNS, text)) return 'pipeline:truncated'
  if (matches(REQUEST_SHAPE_PATTERNS, text)) return 'pipeline:request-shape'
  if (matches(TIMEOUT_PATTERNS, text)) return 'environment:timeout'
  if (matches(OUTPUT_PATTERNS, text)) return 'pipeline:output'
  if (matches(PROVIDER_PATTERNS, text)) return 'environment:provider'
  if (matches(NETWORK_PATTERNS, text)) return 'environment:network'
  const label = typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'unknown'
  return `other:${label}`
}

/**
 * Pull the provider's stated reset time out of a quota message, when it has one.
 * The live message reads "…2026-10-12 23:46:18 后可继续使用…", and that date is
 * the single most useful thing in the whole failure: it says when ingestion
 * comes back.
 */
export function extractQuotaReset(reason) {
  if (typeof reason !== 'string') return null
  const match = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(reason)
  return match === null ? null : match[1].replace('T', ' ')
}

/** Stable display order: what to act on first. */
export const CAUSE_ORDER = [
  'pipeline:truncated',
  'pipeline:request-shape',
  'pipeline:output',
  'environment:quota',
  'environment:timeout',
  'environment:provider',
  'environment:network',
]

/** Causal split the report needs: what a code change can fix vs what to wait out. */
export function splitByClass(byCause) {
  let pipeline = 0
  let environment = 0
  let other = 0
  for (const [cause, count] of Object.entries(byCause ?? {})) {
    const value = Number(count) || 0
    if (cause.startsWith('pipeline:')) pipeline += value
    else if (cause.startsWith('environment:')) environment += value
    else other += value
  }
  return { pipeline, environment, other }
}

/** Short labels for the compact cause line. */
const CAUSE_LABELS = {
  'pipeline:truncated': '截断',
  'pipeline:request-shape': '请求形状',
  'pipeline:output': '输出非法',
  'environment:quota': '配额',
  'environment:timeout': '超时',
  'environment:provider': '服务端',
  'environment:network': '网络',
}

/** Group headings, in the order the reader should care: fixable first. */
const CLASS_LABELS = {
  pipeline: '管道',
  environment: '环境',
  other: '其他',
}

function causeClass(cause) {
  const prefix = String(cause).split(':')[0]
  return prefix === 'pipeline' || prefix === 'environment' ? prefix : 'other'
}

/**
 * "管道（截断 29 · 输出非法 6）· 环境（配额 3 · 超时 9）" for a byCause map.
 *
 * Grouped by class rather than one flat sorted list, because the one thing the
 * reader has to take away is which side of the line the bulk sits on: `管道`
 * means a code or capacity change, `环境` means wait or retry.
 */
export function describeCauses(byCause) {
  const entries = Object.entries(byCause ?? {})
  if (entries.length === 0) return ''
  const rank = (cause) => {
    const index = CAUSE_ORDER.indexOf(cause)
    return index === -1 ? CAUSE_ORDER.length : index
  }
  const groups = new Map()
  for (const [cause, count] of entries) {
    const key = causeClass(cause)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push([cause, count])
  }
  return ['pipeline', 'environment', 'other']
    .filter(key => groups.has(key))
    .map((key) => {
      const parts = groups.get(key)
        .sort((left, right) => rank(left[0]) - rank(right[0]) || String(left[0]).localeCompare(String(right[0])))
        .map(([cause, count]) => {
          const key2 = String(cause)
          const label = CAUSE_LABELS[key2] ?? key2.slice(key2.indexOf(':') + 1)
          return `${label} ${String(count)}`
        })
        .join(' · ')
      return `${CLASS_LABELS[key]}（${parts}）`
    })
    .join(' · ')
}
