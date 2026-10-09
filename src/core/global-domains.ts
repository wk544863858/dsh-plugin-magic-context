/**
 * Global-domain candidates: what may become org/machine knowledge, and why.
 *
 * The plan's original source was a recurrence scan — "the same normalized hash
 * seen in two different projects". Measured against the live store on
 * 2026-10-10 that source is EMPTY, and not because of a bug:
 *
 *   active rows 1292 · distinct projects 33 · hashes shared by 2+ projects 0
 *   content identical across projects 0 · even the first 60 characters 0
 *
 * Historian facts are project-bound (file paths, decisions, incident details),
 * so exact-normalized recurrence does not happen at this corpus size and has no
 * reason to start. Building the lane on that gate would produce an
 * always-empty pool while looking implemented — the "feed it a source we know
 * is inaccurate" failure this project explicitly rejects.
 *
 * So the scan stays here as a MEASUREMENT (it answers "is recurrence a thing
 * yet?" and is cheap to re-run), and the actual source is a human promotion:
 * someone who recognises a project memory as organisation-level knowledge. That
 * is also the only source consistent with the design rule that global memories
 * are human-confirmed and never auto-promoted.
 *
 * Both paths write ONLY the adapter's own `global_candidates` table. Publishing
 * into the shared store under a domain identity is a separate, deliberately
 * unimplemented step (it writes the frozen contract).
 */
import { DatabaseSync } from 'node:sqlite'
import type { AdapterStores, GlobalCandidateRow } from './stores.ts'

/** The provider identity that owns organisation-scoped memories. */
export const ORG_DOMAIN_ID = 'dir:global:org'

/**
 * Credential shapes that must never cross a project boundary.
 *
 * The design rule is "global memories store only POINTERS to secrets, never
 * credential bodies" — a project-local note may legitimately contain a
 * credential, but promoting it to a shared domain would leak it to every member
 * project.
 *
 * Deliberately conservative: long hex/base64 runs are NOT flagged, because this
 * corpus is full of commit ids and digests (40-hex sha1s everywhere) and a rule
 * that fires on those would block almost every candidate. Only contextual
 * assignments, URL userinfo, private-key headers and known credential prefixes
 * count.
 */
const CREDENTIAL_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  // The leading boundary is `[^A-Za-z0-9]` rather than `\b`, because the shapes
  // that matter most are SCREAMING_SNAKE env names (`DB_PASSWORD=…`), and `_` is
  // a word character — `\bpassword` never matches there.
  { rule: 'assign:password', pattern: /(?:^|[^A-Za-z0-9])(pass(word|wd|phrase)?|pwd)\s*[:=]\s*\S/i },
  { rule: 'assign:secret', pattern: /(?:^|[^A-Za-z0-9])(client[_-]?secret|secret[_-]?key|secret)\s*[:=]\s*\S/i },
  { rule: 'assign:api-key', pattern: /(?:^|[^A-Za-z0-9])(api[_-]?key|apikey|access[_-]?key|auth[_-]?token)\s*[:=]\s*\S/i },
  { rule: 'assign:token', pattern: /(?:^|[^A-Za-z0-9])(token|credential|private[_-]?key)\s*[:=]\s*\S/i },
  { rule: 'header:bearer', pattern: /authorization\s*[:=]\s*bearer\s+\S/i },
  { rule: 'url-userinfo', pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { rule: 'pem:private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'prefix:openai', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { rule: 'prefix:github', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { rule: 'prefix:aws', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'prefix:slack', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'prefix:google', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
]

/** Which credential rules a piece of text trips (empty = safe to share). */
export function scanForCredentials(content: string): string[] {
  return CREDENTIAL_RULES.filter(rule => rule.pattern.test(content)).map(rule => rule.rule)
}

export interface RecurrenceSample {
  readonly hash: string
  readonly projects: number
  readonly newestMemoryId: number
  readonly content: string
}

export interface RecurrenceScan {
  /** How many hashes satisfied the recurrence gate at all. */
  readonly hashes: number
  /** How many became candidates (credential-shaped ones are skipped, not stored). */
  readonly upserted: number
  /** How many were skipped because they carry a credential body. */
  readonly blocked: number
  readonly samples: readonly RecurrenceSample[]
}

/**
 * The recurrence scan. Today this is a measurement: see the module comment.
 * Returns the counts AND a sample of what it found, so a report can state the
 * number instead of implying the lane works.
 */
export function detectGlobalCandidates(
  store: AdapterStores,
  options: { contractDbPath: string; domainId?: string; now: number; limit?: number },
): RecurrenceScan {
  const domainId = options.domainId ?? ORG_DOMAIN_ID
  const limit = options.limit ?? 25
  const db = new DatabaseSync(options.contractDbPath, { readOnly: true })
  try {
    const groups = db.prepare(
      `SELECT normalized_hash AS hash, COUNT(DISTINCT project_path) AS projects, MAX(id) AS newest
         FROM memories
        WHERE status = 'active' AND normalized_hash IS NOT NULL AND normalized_hash <> ''
          AND project_path NOT LIKE 'dir:global:%' AND project_path NOT LIKE 'git:global:%'
        GROUP BY normalized_hash
       HAVING COUNT(DISTINCT project_path) >= 2
        ORDER BY projects DESC, newest DESC
        LIMIT ?`,
    ).all(limit) as unknown as Array<{ hash: string; projects: number; newest: number }>

    const samples: RecurrenceSample[] = []
    let upserted = 0
    let blocked = 0

    for (const group of groups) {
      const members = db.prepare(
        `SELECT id, project_path, content, category FROM memories
          WHERE status = 'active' AND normalized_hash = ? ORDER BY id`,
      ).all(group.hash) as unknown as Array<{ id: number; project_path: string; content: string; category: string }>
      const representative = members[members.length - 1]
      if (representative === undefined) continue

      if (scanForCredentials(representative.content).length > 0) {
        blocked += 1
        continue
      }
      const candidate = store.upsertGlobalCandidate(
        {
          domainId,
          content: representative.content,
          normalizedHash: group.hash,
          firstIdentity: representative.project_path,
          category: representative.category,
          sourceMemoryId: representative.id,
        },
        options.now,
      )
      for (const member of members) {
        // `memory:<id>` marks an observation that came from a stored memory
        // rather than a live session.
        store.recordCandidateObservation(
          { candidateId: candidate.id, identity: member.project_path, sessionId: `memory:${String(member.id)}` },
          options.now,
        )
      }
      upserted += 1
      samples.push({
        hash: group.hash,
        projects: group.projects,
        newestMemoryId: group.newest,
        content: representative.content.slice(0, 120),
      })
    }

    return { hashes: groups.length, upserted, blocked, samples }
  } finally {
    db.close()
  }
}

export interface ContractMemory {
  readonly id: number
  readonly projectPath: string
  readonly category: string
  readonly content: string
  readonly normalizedHash: string
  readonly status: string
}

/** Read one memory from the contract (read-only) for a promotion decision. */
export function readContractMemory(contractDbPath: string, memoryId: number): ContractMemory | undefined {
  const db = new DatabaseSync(contractDbPath, { readOnly: true })
  try {
    const row = db.prepare(
      'SELECT id, project_path AS projectPath, category, content, normalized_hash AS normalizedHash, status '
        + 'FROM memories WHERE id = ?',
    ).get(memoryId) as unknown as ContractMemory | undefined
    return row
  } finally {
    db.close()
  }
}

export type PromotionResult =
  | { readonly ok: true; readonly candidate: GlobalCandidateRow; readonly memory: ContractMemory }
  | { readonly ok: false; readonly error: string }

/**
 * Promote one project memory into a domain's candidate pool — the human-
 * initiated source. Writes only the adapter's own table; publishing is a
 * separate step.
 *
 * Eligibility is checked HERE rather than at publish time so the reviewer never
 * sees a candidate that could not be published: the memory must exist, be
 * active, live in a real project (not already a domain identity), and carry no
 * credential body.
 */
export function promoteMemoryToCandidate(
  store: AdapterStores,
  options: { contractDbPath: string; memoryId: number; domainId?: string; now: number },
): PromotionResult {
  const domainId = options.domainId ?? ORG_DOMAIN_ID
  if (store.getDomain(domainId) === undefined) {
    return { ok: false, error: `unknown domain '${domainId}' — define it before promoting into it` }
  }
  const memory = readContractMemory(options.contractDbPath, options.memoryId)
  if (memory === undefined) return { ok: false, error: `no memory #${String(options.memoryId)} in the shared store` }
  if (memory.status !== 'active') {
    return { ok: false, error: `memory #${String(memory.id)} is ${memory.status}, not active` }
  }
  if (memory.projectPath.startsWith('dir:global:') || memory.projectPath.startsWith('git:global:')) {
    return { ok: false, error: `memory #${String(memory.id)} already lives in a global domain` }
  }
  const credentials = scanForCredentials(memory.content)
  if (credentials.length > 0) {
    return {
      ok: false,
      error: `memory #${String(memory.id)} trips ${credentials.join(', ')} — global memories carry POINTERS to secrets, `
        + 'never credential bodies. Rewrite it as a reference and promote that.',
    }
  }
  const candidate = store.upsertGlobalCandidate(
    {
      domainId,
      content: memory.content,
      normalizedHash: memory.normalizedHash,
      firstIdentity: memory.projectPath,
      category: memory.category,
      sourceMemoryId: memory.id,
    },
    options.now,
  )
  store.recordCandidateObservation(
    { candidateId: candidate.id, identity: memory.projectPath, sessionId: `memory:${String(memory.id)}` },
    options.now,
  )
  // Re-read: the upsert deliberately writes zeroed counters and lets the
  // observation rows define the weight, so the inserted snapshot is already
  // stale by the time it is returned.
  const refreshed = store.getGlobalCandidate(candidate.id) ?? candidate
  return { ok: true, candidate: refreshed, memory }
}

/**
 * Whether a candidate may be approved.
 *
 * The recurrence gate exists to stop a MACHINE-detected one-off from becoming
 * organisation-wide truth. A human promotion is a different signal: someone
 * already judged it org-level, and approving it is a second human act — so the
 * gate that applies is the publish pre-check (credentials, category), not the
 * count.
 */
export function approvalGate(
  store: AdapterStores,
  candidate: GlobalCandidateRow,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (candidate.state !== 'pending') {
    return { ok: false, error: `candidate #${String(candidate.id)} is ${candidate.state}, not pending` }
  }
  const credentials = scanForCredentials(candidate.content)
  if (credentials.length > 0) {
    return { ok: false, error: `candidate #${String(candidate.id)} trips ${credentials.join(', ')}` }
  }
  const domain = store.getDomain(candidate.domainId)
  if (domain === undefined) return { ok: false, error: `unknown domain '${candidate.domainId}'` }
  // A published row needs a category (the contract has it NOT NULL and the
  // reader filters on the allowlist) — refuse here rather than letting the
  // INSERT fail with a constraint error the reviewer cannot act on.
  if (candidate.category === undefined || candidate.category === '') {
    return {
      ok: false,
      error: `candidate #${String(candidate.id)} carries no category; a published memory needs one `
        + `(one of: ${domain.shareCategories.join(', ') || 'the domain allowlist'})`,
    }
  }
  if (!domain.shareCategories.includes(candidate.category)) {
    // Publishing under a category outside the allowlist succeeds and is then
    // invisible forever — a silent failure, so it is refused up front.
    return {
      ok: false,
      error: `category ${candidate.category} is outside ${candidate.domainId}'s allowlist `
        + `(${domain.shareCategories.join(', ') || 'nothing'}) — publishing it would be invisible`,
    }
  }
  if (candidate.sourceMemoryId !== undefined) return { ok: true }
  if (candidate.distinctIdentities < 2) {
    return {
      ok: false,
      error: `candidate #${String(candidate.id)} was observed by only ${String(candidate.distinctIdentities)} project(s); `
        + 'a machine-detected promotion needs independent recurrence in at least two',
    }
  }
  return { ok: true }
}

/**
 * The write port a publish needs. Satisfied structurally by the adapter's memory
 * writer, so this module never opens a write connection of its own.
 */
export interface DomainWritePort {
  publishDomainMemory(input: {
    readonly identity: string
    readonly category: string
    readonly content: string
    readonly importance?: number
  }): { readonly ok: true; readonly id: number; readonly created: boolean } | { readonly ok: false; readonly detail: string }
}

export type DomainPublishResult =
  | {
    readonly ok: true
    readonly memoryId: number
    readonly created: boolean
    /** The domain identity the row was published under — a peer project. */
    readonly identity: string
    readonly category: string
  }
  | { readonly ok: false; readonly error: string }

/**
 * Publish an approved candidate into the shared store, under its domain
 * identity. This is the step that makes organisation knowledge real: the domain
 * identity IS a peer project, so the existing peer lane carries the row with no
 * second pool, no second watermark and no second digest.
 *
 * Order is load-bearing and deliberate:
 *
 *   1. the approval gate (credentials, category allowlist, recurrence) — a
 *      refusal here must cost nothing;
 *   2. the write;
 *   3. the state transition, LAST.
 *
 * A candidate whose write failed therefore stays `pending` and can be retried,
 * instead of being marked approved with an empty store behind it.
 */
export function publishGlobalCandidate(
  store: AdapterStores,
  options: {
    readonly candidateId: number
    readonly writer: DomainWritePort
    readonly now: number
    readonly importance?: number
  },
): DomainPublishResult {
  const candidate = store.getGlobalCandidate(options.candidateId)
  if (candidate === undefined) {
    return { ok: false, error: `no candidate #${String(options.candidateId)}` }
  }
  // The gate is the single implementation of every publish prerequisite, so the
  // command surface, the tests and this function can never disagree about what
  // is publishable.
  const gate = approvalGate(store, candidate)
  if (!gate.ok) return { ok: false, error: gate.error }
  const domain = store.getDomain(candidate.domainId)
  if (domain === undefined) return { ok: false, error: `unknown domain '${candidate.domainId}'` }
  // The gate guarantees these; re-reading narrows the optional fields for the
  // writer without a non-null assertion.
  const category = candidate.category
  if (category === undefined || category === '') {
    return { ok: false, error: `candidate #${String(candidate.id)} carries no category` }
  }

  const written = options.writer.publishDomainMemory({
    identity: candidate.domainId,
    category,
    content: candidate.content,
    ...options.importance === undefined ? {} : { importance: options.importance },
  })
  if (!written.ok) return { ok: false, error: `publish refused: ${written.detail}` }

  store.setGlobalCandidateState(candidate.id, 'approved', options.now)
  return {
    ok: true,
    memoryId: written.id,
    created: written.created,
    identity: candidate.domainId,
    category,
  }
}
