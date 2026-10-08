/**
 * The memory lane: everything between `config.memory` and the shared store —
 * the enabled gate, the read bridge, the writer, the search lane with its
 * shared-vector-space gate, the B4 backfill toggle, and the closures the
 * ctx_memory tool consumes. Moved verbatim out of index.ts; `apply` now calls
 * {@link openMemoryLane} once and threads the returned lane to the preStep,
 * the tools registration and the dispose list.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import { openMemoryBridge, DEFAULT_SHARE_CATEGORIES, defaultMemoryDbPath, resolveIdentitySpec } from '../core/memory-bridge.ts'
import { openMemoryWriter, type MemoryWriter } from '../core/memory-write.ts'
import { openMemorySearch, type MemorySearch, type MemorySearchHit } from '../core/memory-search.ts'
import { cosineSimilarity, defaultEmbeddingCacheDir, openLocalEmbedder } from '../core/embedding-local.ts'
import { defineCtxMemoryTool, type LocalDefineTool } from './tool-bridge.ts'
import type { MagicContextDshConfig, MagicContextDshConfigDefineTool } from './config.ts'
import { liveBoolean } from './volatile.ts'

/** The `ctx_memory` search closure's contract (tool-bridge's search seam). */
export interface MemoryToolSearch {
  (request: {
    query: string
    limit?: number
    identity: string
    visibleMemoryIds?: ReadonlySet<number>
  }): Promise<{ ok: true; text: string; hits: Array<{ id: number }> } | { ok: false; reason: string }>
}

/** What the composition root threads to the preStep, the tools and dispose. */
export interface MemoryLane {
  memoryEnabled: boolean
  /** The raw config reference — live reads go through it, never a copy. */
  memorySettings: MagicContextDshConfig['memory']
  memoryRecall: ReturnType<typeof openMemoryBridge> | undefined
  memoryWriter: MemoryWriter | undefined
  memorySearch: MemorySearch | undefined
  /** A2: per-session memory ids the injected block currently renders. */
  visibleMemoryIdsBySession: Map<string, Set<number>>
  memorySearchForTool: MemoryToolSearch | undefined
  /**
   * The auto-search hint lane's FTS-only search, keyed by session rather than by
   * tool exec. `undefined` when the memory lane is off.
   */
  searchForSession: ((session: unknown, query: string, limit: number) => Promise<readonly MemorySearchHit[]>) | undefined
  /** One wording for the writer's state (boot log + telemetry meta). */
  describeMemoryWrite(): string
  /** The `defineCtxMemoryTool` deps object (identity resolution + recall + search). */
  ctxMemoryRegistration(input: {
    activePolicy: () => PressurePolicy
    defineTool: MagicContextDshConfigDefineTool | undefined
    journal: Journal | undefined
  }): Parameters<typeof defineCtxMemoryTool>[0]
}

export function openMemoryLane(
  ctx: Context,
  config: MagicContextDshConfig,
  stores: AdapterStores,
): MemoryLane {
  const memorySettings = config.memory
  const memoryEnabled = memorySettings !== undefined && liveBoolean(memorySettings.enabled, true)
  const memoryRecall = !memoryEnabled
    ? undefined
    : openMemoryBridge({
      ...memorySettings?.dbPath === undefined ? {} : { dbPath: memorySettings.dbPath },
      logger: ctx.logger,
    })
  if (memoryRecall !== undefined) {
    ctx.logger.info(
      `magic-context dsh adapter: memory bridge at ${memoryRecall.dbPath} `
        + `(${memoryRecall.status.ok ? `schema v${String(memoryRecall.status.schemaVersion)}` : `unavailable: ${String(memoryRecall.status.detail)}`})`,
    )
  }
  // The writer opens alongside the reader so facts can become durable
  // memories. Magic Context's default is auto-promote ON; ours follows it,
  // and every write still passes the authority guard (module-managed projects
  // are never written directly).
  const memoryWriter: MemoryWriter | undefined =
    memoryRecall === undefined || (memorySettings?.autoPromote === false && memorySettings?.write === false)
      ? undefined
      : openMemoryWriter({
        // The writer has no default of its own (it must never guess a database
        // to write into), so the caller resolves the shared path here.
        dbPath: memorySettings?.dbPath ?? memoryRecall.dbPath ?? defaultMemoryDbPath(),
        logger: ctx.logger,
      })
  if (memoryWriter !== undefined) {
    const status = memoryWriter.status
    ctx.logger.info(
      `magic-context dsh adapter: memory writer at ${memoryWriter.dbPath} `
        + `(${status.ok ? (status.readOnly === true ? 'read-only' : 'read-write') : `unavailable: ${String(status.detail)}`})`,
    )
  }

  // ── The memory search lane (ctx_memory action `search`) ───────────────────
  // A read-only twin of MC ctx_search's memory half: FTS5 + stored-vector
  // cosine with MC's 0.7/0.3 fusion (memory-search.ts). The embedder loads
  // lazily on first use; any failure degrades the lane to FTS-only instead of
  // failing the tool call.
  const memorySearch: MemorySearch | undefined =
    memoryEnabled && memoryRecall?.status.ok === true
      ? openMemorySearch({ dbPath: memorySettings?.dbPath ?? memoryRecall.dbPath, logger: ctx.logger })
      : undefined
  if (memorySearch !== undefined) {
    ctx.logger.info('magic-context dsh adapter: memory search lane open (FTS + local MiniLM)')
  }
  // B4 gates only the BACKFILL lane below; the embedder itself stays available
  // for the query-side embedding that scores the STORED vectors.
  const embedBackfill = liveBoolean(config.memory?.embedBackfill, false)
  const embedder = memorySearch === undefined
    ? undefined
    : openLocalEmbedder({
      cacheDir: defaultEmbeddingCacheDir(stores.dbPath),
      logger: { info: (message) => ctx.logger.info(message), warn: (message) => ctx.logger.warn(message) },
    })

  /**
   * Shared-vector-space state, discovered once and memoized: the query-side
   * embedder must prove cosine parity against a stored vector before the lane
   * reads shared vectors. Magic Context fences vectors per model identity
   * (embedding-identity.ts) and the store's dominant identity is whichever
   * configuration produced most rows — parity is verified, never assumed.
   */
  let sharedSpacePromise: Promise<{ modelId: string | null }> | undefined
  const resolveSharedSpace = (): Promise<{ modelId: string | null }> => {
    if (memorySearch === undefined || embedder === undefined) return Promise.resolve({ modelId: null })
    if (sharedSpacePromise === undefined) {
      sharedSpacePromise = (async () => {
        const dominant = memorySearch.dominantEmbeddingModel()
        if (dominant === undefined || dominant.dims !== embedder.dims) return { modelId: null }
        const sample = memorySearch.paritySample(dominant.modelId)
        if (sample === undefined) return { modelId: dominant.modelId }
        try {
          const [vector] = await embedder.embed([sample.content])
          if (vector === undefined) return { modelId: null }
          const parity = cosineSimilarity(vector, sample.embedding)
          ctx.logger.info(
            `magic-context memory search: shared-space parity ${parity.toFixed(4)} `
              + `against ${dominant.modelId.slice(0, 48)}`,
          )
          return parity >= 0.99 ? { modelId: dominant.modelId } : { modelId: null }
        } catch {
          return { modelId: null }
        }
      })()
    }
    return sharedSpacePromise
  }

  /** A2: per-session memory ids the injected block currently renders
   *  (MC getVisibleMemoryIds, in-memory: absent = don't filter). */
  const visibleMemoryIdsBySession = new Map<string, Set<number>>()

  /** The ctx_memory `search` closure: bridge space + shared-space gate. */
  const memorySearchForTool: MemoryToolSearch | undefined = memorySearch === undefined
    ? undefined
    : async (request) => {
      const bridge = memoryRecall
      if (bridge === undefined) return { ok: false as const, reason: 'memory search is not available' }
      const space = bridge.searchSpace(request.identity)
      if (space === undefined) {
        return { ok: false as const, reason: 'no project identity could be resolved for this session' }
      }
      const { modelId } = await resolveSharedSpace()
      let queryEmbedding: Float32Array | null = null
      if (embedder !== undefined && modelId !== null) {
        try {
          const [vector] = await embedder.embed([request.query])
          queryEmbedding = vector ?? null
        } catch {
          queryEmbedding = null
        }
      }
      const outcome = await memorySearch.search({
        query: request.query,
        ...request.limit === undefined ? {} : { limit: request.limit },
        now: Date.now(),
        space: {
          ownIdentities: space.ownIdentities,
          foreignIdentities: space.foreignIdentities,
          shareCategories: space.shareCategories ?? [...DEFAULT_SHARE_CATEGORIES],
        },
        queryEmbedding,
        queryModelId: modelId,
        ...request.visibleMemoryIds === undefined ? {} : { visibleMemoryIds: request.visibleMemoryIds },
        // B4: the in-memory fill lane is off unless memory.embedBackfill —
        // scoring then uses only the store's persisted vectors.
        ...embedBackfill && embedder !== undefined ? {
          embedTexts: async (texts: readonly string[]) => {
            const vectors = await embedder.embed(texts)
            return vectors.length === texts.length ? vectors : null
          },
        } : {},
      })
      return outcome.ok
        ? { ok: true as const, text: outcome.text, hits: outcome.hits.map(hit => ({ id: hit.id })) }
        : { ok: false as const, reason: outcome.reason }
    }

  /**
   * One wording for the writer's state, used by both the boot log and the
   * `memory_write` meta the GUI (plugin page / telemetry badge) reads.
   * A contract-version fence keeps `status.ok === true` because reads still
   * work, so `readOnly` must be checked explicitly — otherwise a fully
   * read-only writer would advertise itself as `read-write` (measured on a
   * real-store copy whose schema_migrations was raised to v95).
   */
  const describeMemoryWrite = (): string => {
    const status = memoryWriter?.status
    if (status === undefined) {
      return memorySettings === undefined ? 'off' : memoryEnabled ? 'off' : 'disabled-by-config'
    }
    if (!status.ok) return `unavailable: ${String(status.detail)}`
    if (status.readOnly === true) {
      return `read-only: ${String(status.detail ?? 'contract version is newer than the adapter understands')}`
    }
    return `read-write${memorySettings?.autoPromote === false ? ' (promotion off)' : ' auto-promote'}`
  }

  /**
   * The auto-search hint lane's search (upstream `auto-search-runner`). Same space
   * and shared-space gate as the tool's `search`, but the identity comes from the
   * session — preStep has no tool exec — and the query runs FTS-only: the hint is
   * a nudge, and waiting for the local embedding model to load would delay the
   * turn it is meant to inform.
   * @param session - the session whose cwd/config resolves the identity.
   * @param query - the user's own words.
   * @param limit - how many hits to consider.
   * @returns ranked hits, or an empty list when the lane is unavailable.
   */
  const searchForSession: MemoryLane['searchForSession'] = memorySearch === undefined || memoryRecall === undefined
    ? undefined
    : async (session, query, limit) => {
      const spec = config.memory?.project ?? (session as { header?: { cwd?: string } }).header?.cwd
      if (spec === undefined) return []
      const space = memoryRecall.searchSpace(resolveIdentitySpec(spec))
      if (space === undefined) return []
      // FTS-only: no embedding request, so no model load on the turn path. The
      // stored-vector lane stays available to ctx_search, where the agent asked.
      const outcome = await memorySearch.search({
        query,
        limit,
        now: Date.now(),
        space: {
          ownIdentities: space.ownIdentities,
          foreignIdentities: space.foreignIdentities,
          shareCategories: space.shareCategories ?? [...DEFAULT_SHARE_CATEGORIES],
        },
        queryEmbedding: null,
        queryModelId: null,
      })
      return outcome.ok ? outcome.hits : []
    }

  return {
    memoryEnabled,
    memorySettings,
    memoryRecall,
    memoryWriter,
    memorySearch,
    visibleMemoryIdsBySession,
    memorySearchForTool,
    searchForSession,
    describeMemoryWrite,
    ctxMemoryRegistration: ({ activePolicy, defineTool, journal }) => {
      // The registration is only reached when the bridge opened (index.ts wires
      // it behind the same condition); narrowing here keeps the closures below
      // reading a defined bridge instead of re-testing it three times.
      if (memoryRecall === undefined) {
        throw new Error('ctx_memory registration without a memory bridge')
      }
      const bridge = memoryRecall
      return {
        ...defineTool === undefined ? {} : { defineTool: defineTool as LocalDefineTool },
        ...journal === undefined ? {} : { journal },
        ...memoryWriter === undefined || config.memory?.write === false ? {} : { writer: memoryWriter },
        ...memorySearchForTool === undefined ? {} : { search: memorySearchForTool },
        // A2: ctx_memory search suppresses rows this session's injected
        // block already renders (MC getVisibleMemoryIds).
        visibleMemoryIdsOf: exec => {
          const sessionId = exec?.agent?.session?.id
          return sessionId === undefined ? undefined : visibleMemoryIdsBySession.get(sessionId)
        },
        resolveIdentity: exec => {
          const spec = config.memory?.project ?? exec?.agent?.session.header?.cwd
          return spec === undefined ? undefined : resolveIdentitySpec(spec)
        },
        // The `project` argument's resolver: an explicit absolute path (another
        // project the model is working on) through the same normalizer. DSH has
        // no per-turn working directory, so the model naming the project is the
        // only cross-project scoping signal we have.
        resolveIdentityOf: spec => {
          try {
            return resolveIdentitySpec(spec)
          } catch {
            return undefined
          }
        },
        recall: (request, exec) => {
          // The read path must resolve the SAME identity the writes use. The
          // tool hands us the identity it already resolved (`request.identity`,
          // set by tool-bridge); otherwise fall back to the configured project
          // or this run's cwd, resolved through the same normalizer.
          //
          // This closure used to reference a free `exec` — and because `&&`
          // binds tighter than `?:`, `config.memory?.project === undefined &&
          // exec.agent...` evaluated the right-hand side in the DEFAULT
          // configuration, throwing `ReferenceError: exec is not defined` on
          // every ctx_memory call (measured live). Configuring memory.project
          // short-circuited it, which is why the tests never saw it.
          const spec = (request as { identity?: string }).identity
            ?? config.memory?.project
            ?? (exec === undefined ? undefined : exec.agent?.session.header?.cwd)
          const project = spec === undefined ? undefined : resolveIdentitySpec(spec)
          // A fenced/unreadable store must say so: `{ empty: true }` would read
          // as "this project has no memories", which is a different fact.
          if (!bridge.status.ok) {
            return { lines: [], digest: 'unavailable', reason: String(bridge.status.detail) }
          }
          const recalled = bridge.recall({
          ...project === undefined ? {} : { project },
          workspaceProjects: config.memory?.workspaceProjects,
          shareCategories: config.memory?.shareCategories,
          budgetTokens: activePolicy().memoryBudgetTokens,
          limit: request.limit ?? activePolicy().memoryLimit,
          now: Date.now(),
          ...request.query === undefined ? {} : { query: request.query },
        })
        if (recalled === undefined) return undefined
        // Explicit-retrieval telemetry (contract §9.1): hand back the ids the
        // agent actually received so the tool can bump `retrieval_count`.
        // The automatic m[0]/m[1] injection does NOT pass through here, so it
        // can never inflate the counter.
        return {
          lines: recalled.lines,
          digest: recalled.digest,
          ids: [...recalled.rows, ...recalled.newRows].map(row => row.id),
        }
      },
      }
    },
  }
}
