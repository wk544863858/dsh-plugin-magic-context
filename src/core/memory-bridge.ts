/**
 * The project-memory bridge — Magic Context's shared `context.db`, read by the
 * DSH adapter.
 *
 * Facts this module is built on (verified against Magic Context's storage
 * layer; the contract is duplicated here on purpose, so the adapter can ship
 * without importing Magic Context's TypeScript):
 *  - `memories` has NO `harness` column: project memories are shared across
 *    hosts (OpenCode, Pi, DSH) — that is the whole point of reading them;
 *  - `project_path` stores an IDENTITY (`git:<root-commit-sha>` or
 *    `dir:<hash>`), not a path; legacy rows may still hold raw paths, so the
 *    bridge matches the identity and the normalized path;
 *  - the schema version lives in `schema_migrations` (lane `< 10000`);
 *    Magic Context's LATEST_SUPPORTED_VERSION is 94 — a newer database is
 *    fail-closed (read nothing) rather than guessed at;
 *  - injectable rows are `status IN ('active','permanent')` and not expired;
 *    workspace-shared rows additionally need `shareable = 1`,
 *    `scope IN ('project','ecosystem','universe')` and a category in the
 *    workspace's `share_categories` whitelist;
 *  - selection priority is permanent → importance → max(last_seen_at,
 *    verified_at) → id, trimmed to a token budget.
 *
 * WRITES ARE DELIBERATELY ABSENT: inserting memories also means computing
 * Magic Context's normalized hash, bumping `project_state.project_memory_epoch`
 * only when the injectable set changes, appending `memory_mutation_log`, and
 * honoring the authority guard — invariants owned by Magic Context's storage
 * layer. The adapter recalls; it does not fork the memory store.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { estimateTokens, MEMORY_VISIBILITY_SENTINEL, type MemoryMutationType, type MemoryUpdateLine } from './compartments.ts'
import { memoryCategoryOrder } from './memory-categories.ts'
import { scoreMemory, type MemoryRecallScoring } from './memory-scoring.ts'
import { errText } from './types.ts'

/** The corpus schema ceiling this build understands. Own lineage: the shape
 * was inherited verbatim from upstream MC's v95 store at the 2026-10-13
 * cutover (the adapter stopped sharing `context.db`; see corpus-store.ts),
 * and every future `schema_migrations` row is OURS — a version above this
 * ceiling can only mean the corpus is newer than this build, which must
 * fence to read-only exactly as before. */
export const MEMORY_SCHEMA_MAX_VERSION = 95

/** MC's terminal mutation types (`storage-memory-mutation-log.ts:9-15`): an
 * `update` queued after one of these must not resurrect the memory. */
export const TERMINAL_MUTATION_TYPES: ReadonlySet<MemoryMutationType> =
  new Set<MemoryMutationType>(['archive', 'delete', 'superseded'])

/** MC's `MAX_MEMORY_REPLACEMENT_DEPTH` — the supersede-chain walk cap. */
export const MAX_MEMORY_REPLACEMENT_DEPTH = 8

/** Default page size for one cursor read (the real log holds hundreds of rows). */
export const DEFAULT_MUTATION_PAGE_LIMIT = 1_000

/** The default workspace sharing whitelist when `share_categories` is absent. */
export const DEFAULT_SHARE_CATEGORIES = ['CONSTRAINTS'] as const

/** The plugin's OWN corpus, next to the adapter store in its own data dir
 * (cutover 2026-10-13: no more sharing upstream MC's `context.db`). */
export function defaultMemoryDbPath(): string {
  return join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'memories.db')
}

export interface MemoryRow {
  readonly id: number
  readonly projectPath: string
  readonly category: string
  readonly content: string
  readonly importance: number
  readonly shareable: boolean
  readonly permanent: boolean
  readonly updatedAt: number
  readonly lastSeenAt: number
  readonly verifiedAt?: number
}

export interface MemoryRecallRequest {
  /** Identity (`git:<sha>` / `dir:<hash>`) or a directory to match loosely. */
  readonly project?: string
  /** Workspace-shared identities. */
  readonly workspaceProjects?: readonly string[]
  readonly shareCategories?: readonly string[]
  readonly budgetTokens: number
  readonly limit: number
  readonly now: number
  /**
   * Magic Context's additive watermark. Rows with `id > maxMemoryId` are the
   * in-session additions: they are returned separately (`newRows`) and never
   * enter the digest, so writing a memory cannot rebuild the cached prefix.
   */
  readonly maxMemoryId?: number
  /** Keyword filter (the ctx_memory tool); absent recalls the highest-priority set. */
  readonly query?: string
  /**
   * S(t) decay scoring (schema v7 sidecar): when given and `config.enabled`,
   * rows whose score fell under `archiveThreshold` (or that the adapter
   * retired locally) are excluded from injection but stay in `eligibleIds`
   * (searchable, mutation pointers intact), and the budget picker prefers
   * hotter rows. Absent or disabled: MC's priority order, unchanged.
   */
  readonly scoring?: MemoryRecallScoring
}

export interface MemoryRecallResult {
  /** The m[0] pool: rows at or below the watermark (all rows when unset). */
  readonly rows: readonly MemoryRow[]
  readonly lines: readonly string[]
  /** Identity of the injected pool set: a change forces a HARD baseline rebuild. */
  readonly digest: string
  /** The m[1] additions: rows above the watermark. */
  readonly newRows: readonly MemoryRow[]
  readonly newLines: readonly string[]
  /** Highest memory id visible to this project (and its workspace peers). */
  readonly currentMaxMemoryId: number
  /**
   * B1/A1: every currently-visible row id (pre-budget) — MC's
   * `eligibleMemoryIds`, the authority for `<memory-updates>` forced rows.
   */
  readonly eligibleIds: readonly number[]
  /** The visible rows themselves (pre-budget), for forced-line rendering. */
  readonly eligibleRows: readonly MemoryRow[]
  /** The identity the recall resolved (recorded in the activity journal). */
  readonly identity?: string
  /** The workspace whose members contributed, when one was found. */
  readonly workspace?: string
  /** Member identities whose shared rows were considered. */
  readonly members?: readonly string[]
}

export interface MemoryBridge {
  readonly dbPath: string
  recall(request: MemoryRecallRequest): MemoryRecallResult | undefined
  /**
   * The identity/workspace expansion the search lane shares with recall: one
   * resolution for `git:`/`dir:`/directory specs, the workspace's member list
   * and its normalized category allowlist (memory-search.ts consumes this).
   */
  searchSpace(project?: string): {
    /** First resolved candidate — the own identity (§3.1). */
    readonly identity: string
    readonly ownIdentities: readonly string[]
    readonly foreignIdentities: readonly string[]
    readonly members: readonly string[]
    readonly workspace?: string
    readonly shareCategories?: readonly string[]
  } | undefined
  /**
   * The additive watermark for a project (its own rows plus its workspace
   * peers'). Frozen at every HARD rebuild so later writes land in m[1].
   */
  maxMemoryId(project?: string): number
  /**
   * Read the non-additive change lane: `memory_mutation_log` rows above a
   * per-session cursor, coalesced one-per-target and ordered by `id`.
   * READ-ONLY: the shared database is opened `readOnly`, and nothing here
   * writes to it (the adapter never owns Magic Context's storage).
   */
  mutations(request: MemoryMutationRequest): MemoryMutationResult | undefined
  /**
   * `MAX(memory_mutation_log.id)` for the project (and its workspace peers) —
   * the value a HARD rebuild freezes as `maxMemoryMutationId`.
   */
  maxMemoryMutationId(project?: string): number
  /**
   * The `project_state.project_memory_epoch` fingerprint the baseline was
   * built against. Any change means an external writer moved the epoch, so
   * the m[0] snapshot and the mutation cursor must be rebuilt, not reused.
   */
  projectMemoryEpochFingerprint(project?: string): string
  /**
   * WP8: the user profile (`user_memories`) — the one global lane that needs no
   * activation rule, because it is about the person, not about a project. Read
   * only; `undefined` when the store predates the table or the profile is empty.
   */
  profileRecall(request: ProfileRecallRequest): ProfileRecallResult | undefined
  /** The bridge's own health, for /ctx-status and the logs. */
  readonly status: {
    readonly ok: boolean
    readonly schemaVersion?: number
    readonly detail?: string
  }
  close(): void
}

/** One raw `memory_mutation_log` row (contract §6.1). */
export interface MemoryMutationRow {
  /** `memory_mutation_log.id` — AUTOINCREMENT, globally monotonic (§0.11). */
  readonly id: number
  readonly projectPath: string
  readonly mutationType: MemoryMutationType
  readonly targetMemoryId: number
  readonly supersededById?: number
  readonly category?: string
  readonly newContent?: string
  readonly queuedAt: number
}

export interface MemoryMutationRequest {
  /** Identity (`git:<sha>` / `dir:<hash>`) or a directory to match loosely. */
  readonly project?: string
  /** Workspace-shared identities (defaults to the database's membership). */
  readonly workspaceProjects?: readonly string[]
  readonly shareCategories?: readonly string[]
  /** The persisted per-session cursor: read rows with `id > afterId`. */
  readonly afterId: number
  readonly limit?: number
  readonly now: number
}

export interface MemoryMutationResult {
  /** Coalesced, ordered (`id` ASC), render-ready change lines. */
  readonly updates: readonly MemoryUpdateLine[]
  /** The raw coalesced rows behind {@link updates} (journal/diagnostics). */
  readonly rows: readonly MemoryMutationRow[]
  /** Read cursor to persist for the next read: never moves backwards. */
  readonly cursor: number
  /** `MAX(id)` right now — what a HARD rebuild freezes (§7.5). */
  readonly currentCursor: number
  /** Epoch fingerprint over the project and its workspace peers. */
  readonly projectEpochFingerprint: string
  /** The project's own `project_memory_epoch` (journaling). */
  readonly projectEpoch: number
  /** True when the page hit the limit: more rows await the next read. */
  readonly hasMore: boolean
  readonly identity?: string
  readonly members?: readonly string[]
}

export interface MemoryBridgeLogger {
  info(message: string): void
  warn(message: string): void
}

/**
 * WP8: one active profile row. `user_memories` carries no category, no
 * shareable flag and no project — that absence IS the domain: the profile is
 * global to the person, which is why it needs no activation rule where `org`
 * and `machine` do.
 */
export interface ProfileRow {
  readonly id: number
  readonly content: string
  readonly promotedAt: number
  readonly updatedAt: number
}

export interface ProfileRecallRequest {
  readonly now: number
  /** m[0] budget for the profile block; the delta gets 25% of it. */
  readonly budgetTokens?: number
  /**
   * The frozen watermark. Rows with `id` above it are the in-session additions
   * and render in `<new-user-profile>`; `undefined` means "nothing frozen yet",
   * which puts the whole profile in m[0].
   */
  readonly maxId?: number
}

export interface ProfileRecallResult {
  readonly rows: readonly ProfileRow[]
  readonly lines: readonly string[]
  /**
   * `sha1(id:updated_at…)` over the pool the WATERMARK defines (every active
   * row at or below it) — not over the budget selection. The budget moves with
   * unrelated configuration, and a config change must not look like a data
   * change; the bytes that actually render are covered by the fold instead.
   */
  readonly digest: string
  /**
   * The same digest over EVERY active row: what a HARD fold freezes, because
   * the fold renders the whole profile and the next pass's pool is exactly the
   * full active set. Freezing {@link digest} there would rebuild a second time.
   */
  readonly foldDigest: string
  readonly newRows: readonly ProfileRow[]
  readonly newLines: readonly string[]
  /** `MAX(id)` over the ACTIVE rows: what a HARD rebuild freezes. */
  readonly currentMaxId: number
}

/** Default m[0] budget for `<user-profile>` (Magic Context's own number). */
export const PROFILE_M0_BUDGET_TOKENS = 4000

interface MemoryBridgeOptions {
  readonly dbPath?: string
  readonly logger: MemoryBridgeLogger
  /**
   * WP3 — the ONE activation source for global domains. Supplied by the
   * composition root from the adapter's own store; when absent (tests,
   * embedded use) the bridge resolves NO peers — cross-project sharing is
   * exclusively domain-driven since the 2026-10-13 corpus cutover.
   *
   * Every consumer — recall, the visibility watermark, the search space, the
   * mutation lane and the epoch fingerprint — resolves peers through the same
   * call. Two different answers is the phantom-`<new-memories>` failure: rows
   * the session cannot see still advance its watermark, and later visible rows
   * land below it and are swallowed silently.
   */
  readonly domainResolver?: (identity: string) => readonly ActivePeerDomain[] | undefined
}

/** One activated global domain, as the bridge needs it. */
export interface ActivePeerDomain {
  /** The provider identity (`project_path`) whose rows are shared. */
  readonly identity: string
  /** The allowlist those rows are filtered by (contract convention). */
  readonly shareCategories: readonly string[]
  /** `user` | `org` | `machine` — for journaling and telemetry. */
  readonly kind?: string
}

interface MemoryTableRow {
  id: number
  project_path: string
  category: string | null
  content: string
  importance: number | null
  shareable: number | null
  status: string
  expires_at: number | null
  updated_at: number
  last_seen_at: number | null
  verified_at: number | null
}

const SELECT_COLUMNS = 'id, project_path, category, content, importance, shareable, status, expires_at, updated_at, last_seen_at, verified_at'

/** Magic Context's normalized-hash whitespace set, for stable digests only. */
export function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Directory identity, byte-for-byte compatible with Magic Context's
 * `directoryFallback` (`project-identity.ts`): MD5 of `path.resolve(directory)`
 * truncated to 12 hex characters.
 *
 * Do NOT normalize separators here: Magic Context hashes the resolved path
 * verbatim, so on Windows the digest contains the backslashes. A
 * forward-slash canonicalisation silently orphans every memory of a non-git
 * project (measured: `dir:1afbff92eb86` vs a wrong `dir:931289036571` for the
 * same directory).
 */
export function directoryIdentity(directory: string): string {
  const canonical = resolve(directory)
  return `dir:${createHash('md5').update(canonical, 'utf8').digest('hex').slice(0, 12)}`
}

/** Cache of git identities, since a directory's root commit cannot change. */
const gitIdentityCache = new Map<string, string | undefined>()

/**
 * `git:<root commit sha>` for a directory inside a git repository, matching
 * Magic Context's primary identity. Best effort by design: a missing git, a
 * non-repository, or an empty history yields undefined and the caller falls
 * back to {@link directoryIdentity}. Magic Context itself retries git with a
 * cooldown; the adapter instead caches the verdict for the process lifetime.
 */
export function gitProjectIdentity(directory: string, timeoutMs = 3_000): string | undefined {
  const key = resolve(directory)
  const cached = gitIdentityCache.get(key)
  if (cached !== undefined || gitIdentityCache.has(key)) return cached
  let identity: string | undefined
  try {
    const result = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: key,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    // Multi-root histories: pick the lexicographically smallest root sha so the
    // identity is a pure function of the root-commit set (MC project-identity.ts).
    const first = result.status === 0
      ? (result.stdout ?? '').split('\n').map(line => line.trim().slice(0, 64)).filter(line => /^[0-9a-f]{7,64}$/.test(line)).sort()[0]
      : undefined
    identity = first === undefined ? undefined : `git:${first}`
  } catch {
    identity = undefined
  }
  gitIdentityCache.set(key, identity)
  return identity
}

/** The identity Magic Context would use for a directory: git when possible. */
export function resolveProjectIdentity(directory: string): string {
  return gitProjectIdentity(directory) ?? directoryIdentity(directory)
}

/** The one identity normalizer: `git:`/`dir:` identities pass through, any
 * other string resolves as a directory. Every caller (session scope, the
 * `ctx_memory` `project` argument, recall scoping) shares this spelling. */
export function resolveIdentitySpec(spec: string): string | undefined {
  if (spec.startsWith('git:') || spec.startsWith('dir:')) return spec
  return resolveProjectIdentity(spec)
}

function identityCandidates(project: string | undefined): string[] {
  if (project === undefined || project.length === 0) return []
  if (project.startsWith('git:') || project.startsWith('dir:')) return [project]
  // A directory: resolve it the way Magic Context would (git root commit, then
  // the dir hash), and keep the raw normalized path as a legacy candidate for
  // rows written before identities replaced paths.
  const primary = resolveProjectIdentity(project)
  const legacy = normalize(project).replace(/\\/g, '/')
  return primary === legacy ? [primary] : [primary, legacy]
}

function priorityOf(row: MemoryRow): [number, number, number, number] {
  return [
    row.permanent ? 1 : 0,
    row.importance,
    Math.max(row.lastSeenAt, row.verifiedAt ?? 0),
    row.id,
  ]
}

function comparePriority(left: MemoryRow, right: MemoryRow): number {
  const a = priorityOf(left)
  const b = priorityOf(right)
  for (let index = 0; index < a.length; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function categoryRank(category: string): number {
  return memoryCategoryOrder(category)
}

/** Render one memory as a baseline line (category-tagged, MC render order). */
export function renderMemoryLine(row: MemoryRow): string {
  const badge = row.permanent ? ', permanent' : ''
  return `- [${row.category || 'MEMORY'}${badge}] ${row.content.replace(/\s+/g, ' ').trim()}`
}

/** Render one profile row as a baseline line. */
export function renderProfileLine(row: ProfileRow): string {
  return `- ${row.content.replace(/\s+/g, ' ').trim()}`
}

/**
 * Open the shared memory database read-only. Any incompatibility (missing
 * file, unknown schema version, missing table) disables recall with a loud
 * warning — never an exception into the turn, never a write.
 */
export function openMemoryBridge(options: MemoryBridgeOptions): MemoryBridge {
  const dbPath = options.dbPath ?? defaultMemoryDbPath()
  const unavailable = (detail: string): MemoryBridge => {
    options.logger.warn(`magic-context memory bridge disabled: ${detail} (${dbPath})`)
    return {
      dbPath,
      status: { ok: false, detail },
      recall: () => undefined,
      // No space resolution without a store: recall is off, and so is every
      // workspace-scoped read that would have used this.
      searchSpace: () => undefined,
      maxMemoryId: () => 0,
      mutations: () => undefined,
      maxMemoryMutationId: () => 0,
      projectMemoryEpochFingerprint: () => '',
      profileRecall: () => undefined,
      close: () => undefined,
    }
  }
  if (!existsSync(dbPath)) return unavailable('database not found')

  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return unavailable(`cannot open (${errText(error)})`)
  }

  try {
    const versionRow = db.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations WHERE version < 10000',
    ).get() as { version: number | null } | undefined
    const schemaVersion = versionRow?.version ?? undefined
    if (schemaVersion === undefined || schemaVersion === null) {
      db.close()
      return unavailable('schema_migrations carries no recognized version')
    }
    if (schemaVersion > MEMORY_SCHEMA_MAX_VERSION) {
      db.close()
      return unavailable(
        `schema v${String(schemaVersion)} is newer than the adapter understands (v${String(MEMORY_SCHEMA_MAX_VERSION)})`,
      )
    }
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()
    if (table === undefined) {
      db.close()
      return unavailable('memories table missing')
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(row => row.name),
    )
    for (const required of ['id', 'project_path', 'category', 'content', 'status', 'updated_at']) {
      if (!columns.has(required)) {
        db.close()
        return unavailable(`memories.${required} missing (older schema than expected)`)
      }
    }

    const selfStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM memories
       WHERE project_path = ?
         AND status IN ('active','permanent')
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    const foreignStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM memories
       WHERE project_path = ?
         AND status IN ('active','permanent')
         AND (expires_at IS NULL OR expires_at > ?)
         AND shareable = 1
         AND scope IN ('project','ecosystem','universe')`,
    )

    // B1: the watermark is the VISIBILITY-qualified max — expired/archived
    // rows and non-shared peer rows must never force a HARD rebuild when they
    // land above it (MC freezes the max over the visible pool, not the table).
    const maxIdStatement = db.prepare(
      `SELECT MAX(id) AS id FROM memories WHERE project_path = ?`
      + ` AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)`,
    )

    /** WP3: THE activation function (see MemoryBridgeOptions.domainResolver). */
    const peersFor = (identities: readonly string[]): {
      workspace?: string
      members: string[]
      shareCategories?: string[]
      domains: readonly ActivePeerDomain[]
    } => {
      const resolve = options.domainResolver
      if (resolve === undefined) return { members: [], domains: [] }
      const domains: ActivePeerDomain[] = []
      let answered = false
      for (const identity of identities) {
        const answer = resolve(identity)
        if (answer === undefined) continue
        answered = true
        for (const domain of answer) {
          if (!domains.some(existing => existing.identity === domain.identity)) domains.push(domain)
        }
      }
      // No domain has this identity yet: no peers. The old fallback to the
      // shared store's `workspaces` membership died with the 2026-10-13
      // corpus cutover — the own corpus carries no workspace tables, and
      // cross-project sharing is exclusively domain-driven.
      if (!answered) return { members: [], domains: [] }
      const members = domains.map(domain => domain.identity).filter(identity => !identities.includes(identity))
      if (members.length === 0) return { members: [], domains: [] }
      // The SQL filter is a single `category IN (...)`, so the effective
      // allowlist is the union of the activated domains'. That cannot widen what
      // a domain is allowed to share because publishing pre-checks the category
      // against ITS OWN allowlist (core/global-domains).
      const categories = [...new Set(domains.flatMap(domain => [...domain.shareCategories]))]
        .sort((left, right) => left.localeCompare(right))
      return {
        workspace: members.join('+'),
        members,
        shareCategories: categories,
        domains,
      }
    }

    // WP8: the user profile. `user_memories` is optional (older contracts lack
    // it) and its stamp columns are probed rather than assumed, so a schema
    // drift degrades to "no profile" instead of taking the recall path down.
    let profileStatement: ReturnType<typeof db.prepare> | undefined
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_memories'").get() !== undefined) {
      const profileColumns = new Set(
        (db.prepare('PRAGMA table_info(user_memories)').all() as Array<{ name: string }>).map(row => row.name),
      )
      if (profileColumns.has('id') && profileColumns.has('content') && profileColumns.has('status')) {
        const promoted = profileColumns.has('promoted_at')
          ? 'promoted_at'
          : profileColumns.has('created_at') ? 'created_at' : 'id'
        const updated = profileColumns.has('updated_at') ? 'updated_at' : promoted
        profileStatement = db.prepare(
          'SELECT id, content, ' + promoted + ' AS promoted_at, ' + updated + ' AS updated_at '
            + "FROM user_memories WHERE status = 'active' ORDER BY " + promoted + ' ASC, id ASC',
        )
      }
    }

    const toRow = (row: MemoryTableRow): MemoryRow => ({      id: row.id,
      projectPath: row.project_path,
      category: row.category ?? '',
      content: row.content,
      importance: row.importance ?? 50,
      shareable: row.shareable === 1,
      permanent: row.status === 'permanent',
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at ?? row.updated_at,
      ...row.verified_at === null ? {} : { verifiedAt: row.verified_at },
    })

    const maxFor = (identities: readonly string[], now: number): number => {
      let highest = 0
      for (const identity of identities) {
        const row = maxIdStatement.get(identity, now) as { id: number | null } | undefined
        if (row?.id != null && row.id > highest) highest = row.id
      }
      return highest
    }

    /** B1: the peer-side max carries the share filter (shareable + scope +
     *  category allowlist) — a hidden peer row above the watermark is not
     *  "visible", so freezing it would only produce a phantom m[1] line. */
    const maxForeignId = (
      peerIdentities: readonly string[],
      categories: readonly string[],
      now: number,
    ): number => {
      if (peerIdentities.length === 0 || categories.length === 0) return 0
      const placeholders = peerIdentities.map(() => '?').join(', ')
      const categoryPlaceholders = categories.map(() => '?').join(', ')
      const row = db.prepare(
        `SELECT MAX(id) AS id FROM memories WHERE project_path IN (${placeholders})`
        + ` AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)`
        + ` AND shareable = 1 AND scope IN ('project','ecosystem','universe')`
        + ` AND category IN (${categoryPlaceholders})`,
      ).get(...peerIdentities, now, ...categories) as { id: number | null } | undefined
      return row?.id ?? 0
    }

    /** The watermark max over the visible pool: own rows (eligible) plus peer
     *  rows (eligible AND shared). */
    const maxVisibleId = (
      ownIdentities: readonly string[],
      peerIdentities: readonly string[],
      categories: readonly string[],
      now: number,
    ): number => Math.max(maxFor(ownIdentities, now), maxForeignId(peerIdentities, categories, now))

    // ── The non-additive change lane (`memory_mutation_log`, contract §6) ────
    // Everything below is strictly read-only. Both tables are probed, because
    // an older schema (or a synthetic fixture) may lack them: a missing table
    // means "no deltas", never a failure. The same applies to the optional
    // `memories` columns — the lane must never take the recall path down.
    const memoryColumnNames = new Set(
      (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(row => row.name),
    )
    const memoryColumn = (name: string): string => memoryColumnNames.has(name) ? name : `NULL AS ${name}`
    let hasMutationLog = false
    let mutationStatement: ReturnType<typeof db.prepare> | undefined
    let mutationMaxStatement: ReturnType<typeof db.prepare> | undefined
    let epochStatement: ReturnType<typeof db.prepare> | undefined
    let mutationMemoryStatement: ReturnType<typeof db.prepare> | undefined
    try {
      hasMutationLog = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_mutation_log'",
      ).get() !== undefined
      const hasProjectState = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_state'",
      ).get() !== undefined
      const MUTATION_COLUMNS =
        'id, project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at'
      mutationStatement = hasMutationLog
        ? db.prepare(
          `SELECT ${MUTATION_COLUMNS} FROM memory_mutation_log
            WHERE project_path = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        )
        : undefined
      mutationMaxStatement = hasMutationLog
        ? db.prepare('SELECT MAX(id) AS id FROM memory_mutation_log WHERE project_path = ?')
        : undefined
      epochStatement = hasProjectState
        ? db.prepare('SELECT project_memory_epoch AS epoch FROM project_state WHERE project_path = ?')
        : undefined
      // The mutation payload is resolved against the *live* memory row: MC
      // re-reads the target for `update` (a later write is the truth) and walks
      // `superseded_by_memory_id` to the terminal replacement (§6.3-§6.4).
      mutationMemoryStatement = db.prepare(
        `SELECT id, project_path, category, content, ${memoryColumn('scope')}, ${memoryColumn('shareable')}, `
          + `status, ${memoryColumn('expires_at')}, ${memoryColumn('superseded_by_memory_id')} `
          + 'FROM memories WHERE id = ?',
      )
    } catch (error) {
      mutationStatement = undefined
      mutationMaxStatement = undefined
      epochStatement = undefined
      mutationMemoryStatement = undefined
      options.logger.warn(
        'magic-context memory mutation lane disabled: '
          + `${errText(error)} (${dbPath})`,
      )
    }
    interface MutationMemoryRow {
      id: number; project_path: string; category: string | null; content: string
      scope: string | null; shareable: number | null; status: string
      expires_at: number | null; superseded_by_memory_id: number | null
    }

    const epochOf = (identity: string): number => {
      if (epochStatement === undefined) return 0
      const row = epochStatement.get(identity) as { epoch: number | null } | undefined
      return row?.epoch ?? 0
    }
    /**
     * The epoch identity of a baseline. A bare epoch integer is not enough:
     * workspace membership changes move the epoch of a *peer*, and MC compares
     * a fingerprint that hashes every member's epoch (`workspaces.ts:312-334`).
     */
    const epochFingerprint = (identities: readonly string[]): string => {
      const pairs = [...new Set(identities)].sort().map(identity => `${identity}:${String(epochOf(identity))}`)
      return createHash('sha1').update(pairs.join('|')).digest('hex').slice(0, 16)
    }

    const maxMutationFor = (identities: readonly string[]): number => {
      if (mutationMaxStatement === undefined) return 0
      let highest = 0
      for (const identity of identities) {
        const row = mutationMaxStatement.get(identity) as { id: number | null } | undefined
        if (row?.id != null && row.id > highest) highest = row.id
      }
      return highest
    }

    /**
     * MC's `coalesceMutations` (`storage-memory-mutation-log.ts:144-229`): one
     * row per target memory, and a terminal state beats a later non-terminal
     * one so an `update` queued after an `archive`/`delete`/`superseded`
     * cannot resurrect the memory. Input arrives oldest-first.
     */
    const coalesceMutations = (rows: readonly MemoryMutationRow[]): MemoryMutationRow[] => {
      const byTarget = new Map<number, MemoryMutationRow>()
      for (const row of rows) {
        const selected = byTarget.get(row.targetMemoryId)
        if (selected === undefined) {
          byTarget.set(row.targetMemoryId, row)
          continue
        }
        if (TERMINAL_MUTATION_TYPES.has(selected.mutationType)
          && !TERMINAL_MUTATION_TYPES.has(row.mutationType)) continue
        byTarget.set(row.targetMemoryId, row)
      }
      return [...byTarget.values()].sort((left, right) => left.id - right.id)
    }

    const eligibleRow = (row: MutationMemoryRow, now: number): boolean =>
      (row.status === 'active' || row.status === 'permanent')
      && (row.expires_at === null || row.expires_at > now)

    /** Own rows are always ours; a peer's row only while it is shared here. */
    const visibleRow = (
      row: MutationMemoryRow,
      identities: readonly string[],
      shared: ReadonlySet<string>,
    ): boolean => identities.includes(row.project_path)
      || (row.shareable === 1
        && row.scope !== null
        && ['project', 'ecosystem', 'universe'].includes(row.scope)
        && row.category !== null
        && shared.has(row.category))

    /**
     * Walk `superseded_by_memory_id` to the terminal replacement (§6.3 step 4),
     * bounded by MC's depth cap. Returns undefined when the chain is broken,
     * cyclic, too deep, or the replacement is not currently eligible/visible —
     * the caller then degrades `<superseded .../>` to `<removed .../>`.
     */
    const resolveReplacement = (
      startId: number | undefined,
      identities: readonly string[],
      shared: ReadonlySet<string>,
      now: number,
    ): MutationMemoryRow | undefined => {
      let current = startId
      const visited = new Set<number>()
      for (let depth = 0; depth < MAX_MEMORY_REPLACEMENT_DEPTH; depth += 1) {
        if (current === undefined || visited.has(current) || mutationMemoryStatement === undefined) return undefined
        visited.add(current)
        const row = mutationMemoryStatement.get(current) as MutationMemoryRow | undefined
        if (row === undefined) return undefined
        if (!eligibleRow(row, now) || !visibleRow(row, identities, shared)) return undefined
        const next = row.superseded_by_memory_id
        if (next === null || next === undefined) return row
        current = next
      }
      return undefined
    }

    const toMutationRow = (raw: {
      id: number; project_path: string; mutation_type: string; target_memory_id: number
      superseded_by_id: number | null; category: string | null; new_content: string | null; queued_at: number
    }): MemoryMutationRow => ({
      id: raw.id,
      projectPath: raw.project_path,
      mutationType: raw.mutation_type as MemoryMutationType,
      targetMemoryId: raw.target_memory_id,
      ...raw.superseded_by_id === null ? {} : { supersededById: raw.superseded_by_id },
      ...raw.category === null ? {} : { category: raw.category },
      ...raw.new_content === null ? {} : { newContent: raw.new_content },
      queuedAt: raw.queued_at,
    })

    /** Fold a coalesced row into the value object `<memory-updates>` renders. */
    const toUpdateLine = (
      row: MemoryMutationRow,
      identities: readonly string[],
      shared: ReadonlySet<string>,
      now: number,
    ): MemoryUpdateLine | undefined => {
      const target = mutationMemoryStatement?.get(row.targetMemoryId) as MutationMemoryRow | undefined
      const realCategory = row.category !== undefined && row.category.length > 0
        && row.category !== MEMORY_VISIBILITY_SENTINEL
        ? row.category
        : target?.category ?? undefined
      // A peer's change is only rendered when its category is shared with us.
      if (!identities.includes(row.projectPath)
        && !(realCategory !== undefined && shared.has(realCategory))) return undefined
      const base = {
        id: row.id,
        targetMemoryId: row.targetMemoryId,
        mutationType: row.mutationType,
        ...realCategory === undefined ? {} : { category: realCategory },
      }
      if (row.mutationType === 'superseded') {
        const replacement = resolveReplacement(row.supersededById, identities, shared, now)
        return {
          ...base,
          ...row.supersededById === undefined ? {} : { supersededById: row.supersededById },
          replacementResolvable: replacement !== undefined,
        }
      }
      if (row.mutationType !== 'update') return base
      // MC re-reads the live row for the update payload; `new_content` is the
      // queued snapshot and the fallback when the row is already gone.
      const content = target?.content ?? row.newContent
      if (content === undefined || content.length === 0) return base
      return { ...base, content }
    }

    const readMutations = (request: MemoryMutationRequest): MemoryMutationResult | undefined => {
      try {
        const identities = identityCandidates(request.project)
        const auto = peersFor(identities)
        const peers = request.workspaceProjects ?? auto.members
        const peerIdentities = peers.flatMap(candidate => identityCandidates(candidate))
        const allIdentities = [...identities, ...peerIdentities]
        const shared = new Set(request.shareCategories ?? auto.shareCategories ?? DEFAULT_SHARE_CATEGORIES)
        const limit = Math.max(1, Math.floor(request.limit ?? DEFAULT_MUTATION_PAGE_LIMIT))
        const fingerprint = epochFingerprint(allIdentities)

        const raw: MemoryMutationRow[] = []
        const seenIds = new Set<number>()
        for (const identity of allIdentities) {
          if (mutationStatement === undefined) break
          // `limit + 1` so a truncated page is detectable rather than guessed.
          const page = mutationStatement.all(identity, request.afterId, limit + 1) as unknown as Array<{
            id: number; project_path: string; mutation_type: string; target_memory_id: number
            superseded_by_id: number | null; category: string | null; new_content: string | null; queued_at: number
          }>
          for (const item of page) {
            if (seenIds.has(item.id)) continue
            seenIds.add(item.id)
            raw.push(toMutationRow(item))
          }
        }
        const ordered = raw.sort((left, right) => left.id - right.id)
        const hasMore = ordered.length > limit
        const page = hasMore ? ordered.slice(0, limit) : ordered
        const cursor = page.length === 0
          ? request.afterId
          : Math.max(request.afterId, page[page.length - 1]!.id)
        const coalesced = coalesceMutations(page)
        const updates = coalesced
          .map(row => toUpdateLine(row, identities, shared, request.now))
          .filter((line): line is MemoryUpdateLine => line !== undefined)
        return {
          updates,
          rows: coalesced,
          cursor,
          currentCursor: maxMutationFor(allIdentities),
          projectEpochFingerprint: fingerprint,
          projectEpoch: identities[0] === undefined ? 0 : epochOf(identities[0]),
          hasMore,
          ...identities[0] === undefined ? {} : { identity: identities[0] },
          members: peers,
        }
      } catch (error) {
        options.logger.warn(
          `magic-context memory mutation read failed (continuing without deltas): `
            + `${errText(error)}`,
        )
        return undefined
      }
    }

    return {
      dbPath,
      status: { ok: true, schemaVersion },
      searchSpace: (project) => {
        try {
          const identities = identityCandidates(project)
          if (identities.length === 0) return undefined
          const auto = peersFor(identities)
          const foreignIdentities = auto.members.flatMap(candidate => identityCandidates(candidate))
          return {
            identity: identities[0]!,
            ownIdentities: identities,
            foreignIdentities,
            members: auto.members,
            ...auto.workspace === undefined ? {} : { workspace: auto.workspace },
            ...auto.shareCategories === undefined ? {} : { shareCategories: auto.shareCategories },
          }
        } catch {
          return undefined
        }
      },
      maxMemoryId: (project) => {
        try {
          const identities = identityCandidates(project)
          const auto = peersFor(identities)
          const peerIdentities = auto.members.flatMap(candidate => identityCandidates(candidate))
          return maxVisibleId(
            identities,
            peerIdentities,
            auto.shareCategories ?? DEFAULT_SHARE_CATEGORIES,
            Date.now(),
          )
        } catch {
          return 0
        }
      },
      maxMemoryMutationId: (project) => {
        try {
          const identities = identityCandidates(project)
          const peers = peersFor(identities).members.flatMap(candidate => identityCandidates(candidate))
          return maxMutationFor([...identities, ...peers])
        } catch {
          return 0
        }
      },
      projectMemoryEpochFingerprint: (project) => {
        try {
          const identities = identityCandidates(project)
          const peers = peersFor(identities).members.flatMap(candidate => identityCandidates(candidate))
          return epochFingerprint([...identities, ...peers])
        } catch {
          return ''
        }
      },
      mutations: readMutations,
      profileRecall: (request) => {
        try {
          if (profileStatement === undefined) return undefined
          const rows = (profileStatement.all() as unknown as Array<{
            id: number; content: string; promoted_at: number | null; updated_at: number | null
          }>).map(row => ({
            id: row.id,
            content: row.content,
            promotedAt: row.promoted_at ?? row.id,
            updatedAt: row.updated_at ?? row.promoted_at ?? row.id,
          }))
          if (rows.length === 0) return undefined
          const budget = request.budgetTokens ?? PROFILE_M0_BUDGET_TOKENS
          const watermark = request.maxId
          const pool = watermark === undefined ? rows : rows.filter(row => row.id <= watermark)
          const additions = watermark === undefined ? [] : rows.filter(row => row.id > watermark)
          const pick = (candidates: readonly ProfileRow[], tokens: number): ProfileRow[] => {
            const selected: ProfileRow[] = []
            let used = 0
            for (const row of candidates) {
              const cost = estimateTokens(renderProfileLine(row))
              // `continue`, not `break`: one expensive entry must not hide the
              // cheaper ones behind it (the same rule the memory picker keeps).
              if (used + cost > tokens) continue
              used += cost
              selected.push(row)
            }
            return selected
          }
          const selectedPool = pick(pool, budget)
          const selectedDelta = pick(additions, Math.max(1, Math.floor(budget * 0.25)))
          if (selectedPool.length === 0 && selectedDelta.length === 0 && rows.length === 0) return undefined
          const digestOf = (list: readonly ProfileRow[]): string =>
            createHash('sha1').update(list.map(row => `${String(row.id)}:${String(row.updatedAt)}`).join('|')).digest('hex')
          return {
            rows: selectedPool,
            lines: selectedPool.map(renderProfileLine),
            digest: digestOf(pool),
            foldDigest: digestOf(rows),
            newRows: selectedDelta,
            newLines: selectedDelta.map(renderProfileLine),
            currentMaxId: rows.reduce((max, row) => Math.max(max, row.id), 0),
          }
        } catch (error) {
          options.logger.warn(`magic-context profile read failed (continuing without it): ${errText(error)}`)
          return undefined
        }
      },
      recall: (request) => {
        try {
          // B3 (MC single_store_reads): one deferred read transaction so the
          // pool query, the max and the watermark observe ONE snapshot — a
          // concurrent writer between statements must not tear the digest.
          db.exec('BEGIN')
          try {
            const identities = identityCandidates(request.project)
            const auto = peersFor(identities)
            const rows: MemoryRow[] = []
            const seen = new Set<number>()
            for (const identity of identities) {
              for (const raw of selfStatement.all(identity, request.now) as unknown as MemoryTableRow[]) {
                const row = toRow(raw)
                if (!seen.has(row.id)) {
                  seen.add(row.id)
                  rows.push(row)
                }
              }
            }
            const shared = new Set(request.shareCategories ?? auto.shareCategories ?? DEFAULT_SHARE_CATEGORIES)
            const peers = request.workspaceProjects ?? auto.members
            const peerIdentities = peers.flatMap(candidate => identityCandidates(candidate))
            for (const identity of peerIdentities) {
              for (const raw of foreignStatement.all(identity, request.now) as unknown as MemoryTableRow[]) {
                const row = toRow(raw)
                if (seen.has(row.id)) continue
                if (identities.includes(row.projectPath)) continue
                if (!shared.has(row.category)) continue
                seen.add(row.id)
                rows.push(row)
              }
            }
            const context = {
              ...identities[0] === undefined ? {} : { identity: identities[0] },
              ...auto.workspace === undefined ? {} : { workspace: auto.workspace },
              members: peers,
            }
            if (rows.length === 0) return undefined
          const needle = request.query?.trim().toLowerCase()
          const filtered = needle === undefined || needle.length === 0
            ? rows
            : rows.filter(row =>
              row.content.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle))
          if (filtered.length === 0) return undefined

          // S(t) decay scoring (schema v7): retired rows drop out of the
          // injection pool but stay in eligibleIds — searchable, and
          // `<memory-updates>` pointers for them stay resolvable. The picker
          // prefers hotter rows (score desc, MC priority as the tiebreak);
          // the RENDER order below stays MC's category order, so the injected
          // block still reads like the OpenCode/Pi block.
          const scoring = request.scoring
          const scoringActive = scoring !== undefined && scoring.config.enabled
          const retiredIds = new Set<number>()
          const scoreOf = (row: MemoryRow): number => {
            if (scoring === undefined) return 0
            const stat = scoring.statsById.get(row.id)
            return scoreMemory(
              {
                importance: row.importance,
                category: row.category,
                hits: stat?.hits ?? 0,
                ...stat?.lastHitAt === undefined ? {} : { lastHitAt: stat.lastHitAt },
              },
              scoring.config,
              request.now,
            )
          }
          if (scoringActive && scoring !== undefined) {
            for (const row of filtered) {
              const stat = scoring.statsById.get(row.id)
              if (stat?.localArchived === true || scoreOf(row) < scoring.config.archiveThreshold) {
                retiredIds.add(row.id)
              }
            }
          }

          // The additive lane: rows above the stored watermark are in-session
          // additions and render in m[1], so they never disturb the m[0] pool
          // digest below (Magic Context's maxMemoryId contract).
          const watermark = request.maxMemoryId
          const pool = watermark === undefined ? filtered : filtered.filter(row => row.id <= watermark)
          const additions = watermark === undefined ? [] : filtered.filter(row => row.id > watermark)
          const pick = (
            candidates: readonly MemoryRow[],
            budgetTokens: number,
          ): MemoryRow[] => {
            // Priority order picks the budget (S(t) score desc first when the
            // decay scoring is on, MC priority as the tiebreak); the render
            // order is MC's category order, so the injected block reads like
            // the OpenCode/Pi block.
            const usable = scoringActive
              ? candidates.filter(row => !retiredIds.has(row.id))
              : candidates
            const selected: MemoryRow[] = []
            let used = 0
            const ranked = scoringActive
              ? [...usable].sort((left, right) => scoreOf(right) - scoreOf(left) || comparePriority(left, right))
              : [...usable].sort(comparePriority)
            for (const row of ranked) {
              if (selected.length >= request.limit) break
              const cost = estimateTokens(renderMemoryLine(row))
              if (used + cost > budgetTokens) continue
              used += cost
              selected.push(row)
            }
            return selected
          }
          const poolSelected = pick(pool, request.budgetTokens)
          // MC budgets the additions at 25% of the memory injection budget.
          const deltaSelected = pick(additions, Math.max(1, Math.floor(request.budgetTokens * 0.25)))
          if (poolSelected.length === 0 && deltaSelected.length === 0) return undefined
          const order = (selected: readonly MemoryRow[]): MemoryRow[] => [...selected].sort((left, right) =>
            categoryRank(left.category) - categoryRank(right.category) || right.updatedAt - left.updatedAt)
          const orderedPool = order(poolSelected)
          const orderedAdditions = order(deltaSelected)
          // Digest covers the m[0] pool ONLY: a new memory may not bust the cache.
          const digest = createHash('sha1')
            .update(orderedPool.map(row => `${String(row.id)}:${String(row.updatedAt)}`).join('|'))
            .digest('hex')
          // B1: visibility-qualified max (own eligible + peers eligible AND shared).
          const currentMaxMemoryId = maxVisibleId(identities, peerIdentities, [...shared], request.now)
          return {
            rows: orderedPool,
            lines: orderedPool.map(renderMemoryLine),
            digest,
            newRows: orderedAdditions,
            newLines: orderedAdditions.map(renderMemoryLine),
            currentMaxMemoryId,
            eligibleIds: rows.map(row => row.id),
            eligibleRows: rows,
            ...context,
          }
          } finally {
            // COMMIT ends the read snapshot; a failed body leaves the tx
            // aborted and the END is a no-op (readonly — nothing to roll back).
            try {
              db.exec('COMMIT')
            } catch {
              /* aborted transaction */
            }
          }
        } catch (error) {
          options.logger.warn(
            `magic-context memory recall failed (continuing without memories): ${errText(error)}`,
          )
          return undefined
        }
      },
      close: () => db.close(),
    }
  } catch (error) {
    try {
      db.close()
    } catch {
      /* best effort */
    }
    return unavailable(`probe failed (${errText(error)})`)
  }
}
