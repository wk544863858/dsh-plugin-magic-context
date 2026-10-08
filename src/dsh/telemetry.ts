/**
 * The validation-period telemetry surface for the browser half.
 *
 * Why a host route instead of the Remote layer: the server→client event
 * whitelist is a compile-time constant in the harness, so a third-party bundle
 * cannot subscribe to arbitrary plugin events; `ctx.webServer.register` is the
 * supported seam (verified end-to-end by the UI-telemetry contract). The client
 * half consumes `/mc-telemetry/summary` once and `/mc-telemetry/events` (SSE)
 * for the live tail, and renders it in the composer status bar.
 *
 * Scope: the badge belongs to the Session it is shown in, so both routes accept
 * `?session=<sessionId>` and then count only that Session's journal rows
 * (`journal` carries `session_id`) and report that Session's project identity
 * from its newest `memory-recall` row. Process-level facts — adapter version,
 * engine, memory bridge, tool mode, journal configuration — stay global, and a
 * request without `?session=` keeps the original whole-store aggregation, so
 * diagnostic callers (`/ctx-status`-style rollups) are unaffected.
 *
 * Privacy and safety: this route has no auth beyond loopback (measured), so it
 * exposes COUNTS and one-line summaries only — never message content, never
 * file paths, never credentials. Everything here already lives in the journal,
 * which stores no message text by construction.
 */
import type { Journal, JournalLevel } from '../core/journal.ts'
import type { AdapterStores } from '../core/stores.ts'
import { SCHEMA_VERSION } from '../core/stores.ts'

/** The slice of the harness request/response we use (structural, no imports). */
export interface TelemetryRequest {
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string | string[] | undefined>
}
export interface TelemetryResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  write?(chunk: string): unknown
  end(chunk?: string): unknown
  readonly writableEnded?: boolean
  on?(event: string, listener: () => void): unknown
}

export interface TelemetryDeps {
  readonly stores: AdapterStores
  readonly journal?: Journal
  /** Live adapter state for the summary header. */
  readonly meta: () => {
    readonly engine?: string
    readonly memory?: string
    readonly memoryWrite?: string
    readonly toolsMode?: string
  }
  readonly startedAt?: number
  readonly now?: () => number
  /** Stream poll interval; tests shrink it. */
  readonly pollMs?: number
  /**
   * Dreamer-slice KPIs for the panel: the session's project verification
   * coverage and the newest maintenance tick's tally. Receives the summary's
   * sessionId AND the identity the header resolved for this scope (the newest
   * recall of the scope) so the KPI can never count a different project than
   * `project.identity` reports; the composition root decides the fallback when
   * no identity was resolved.
   */
  readonly memoryStats?: (sessionId?: string, identity?: string) => {
    readonly total?: number
    readonly verified?: number
    readonly unverified?: number
  } | undefined
  readonly maintenanceLast?: () => {
    readonly at?: number
    readonly expired?: number
    readonly verified?: number
    readonly updated?: number
    readonly archived?: number
  } | undefined
}

export interface TelemetryService {
  handle(req: TelemetryRequest, res: TelemetryResponse): void
  /** The summary payload (also used by tests); `sessionId` narrows it to one Session. */
  summary(sessionId?: string): Record<string, unknown>
  /** Number of open SSE streams (for the shutdown path). */
  readonly openStreams: number
  close(): void
}

const DAY_MS = 24 * 60 * 60_000

/**
 * Normalize the `?session=` query value.
 * @param raw - the request URL's first `session` parameter.
 * @returns the Session id, or undefined for absent/empty (whole-store scope).
 */
export function sessionOf(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined
  const value = raw.trim()
  return value === '' ? undefined : value
}

export function createTelemetryService(deps: TelemetryDeps): TelemetryService {
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? 2_000
  const streams = new Set<{ stop(): void }>()
  /**
   * Browser halves that ever attached, and when the newest one did.
   *
   * `sseClients` in the summary is the only machine-readable proof that a
   * browser half is actually connected and receiving journal rows — without it
   * "is the UI showing anything?" can only be answered by looking at the screen.
   */
  let attachedTotal = 0
  let lastAttachedAt: number | undefined

  /** The newest journal row of a scope, or undefined. */
  const newestOf = (sessionId?: string): { at: number } | undefined => {
    try {
      return deps.stores.listJournal({
        limit: 1,
        ...sessionId === undefined ? {} : { sessionId },
      })[0]
    } catch {
      return undefined
    }
  }

  /** The newest `memory-recall` row of a scope, or undefined. */
  const latestRecall = (sessionId?: string): { data?: Record<string, unknown> } | undefined => {
    try {
      return deps.stores.listJournal({
        kinds: ['memory-recall'],
        limit: 1,
        ...sessionId === undefined ? {} : { sessionId },
      })[0]
    } catch {
      return undefined
    }
  }

  /**
   * The project this scope is working on, read from the newest recall: the
   * Session's own when one is named, the most recent one overall otherwise.
   */
  const project = (sessionId?: string): Record<string, unknown> => {
    const recall = latestRecall(sessionId)
    const identity = recall?.data?.identity
    const memories = recall?.data?.rows
    return {
      ...typeof identity === 'string' ? { identity } : {},
      ...typeof memories === 'number' ? { memories } : {},
    }
  }

  const health = (sessionId?: string): Record<string, unknown> => {
    const since = now() - DAY_MS
    // Errors reported by the RUNNING process, not by the last day. The pill is a
    // live health badge: after a restart it must not keep flagging failures that
    // the current build already fixed (the historian token-cap failures stayed
    // red for a day until this existed).
    const bootSince = deps.startedAt === undefined ? since : Math.max(deps.startedAt, since)
    /** First-wins capture: journal rows iterate newest-first, so the newest
     * reading for a field simply arrives first. */
    const firstNum = (current: number | undefined, value: unknown): number | undefined =>
      current === undefined && typeof value === 'number' ? value : current
    // 24h counters: kind → aggregate field (single scan; error level handled inline).
    const KIND_COUNTS: Record<string, 'passes24h' | 'drops24h' | 'compartments24h' | 'emergency24h' | 'promote24h'> = {
      pass: 'passes24h',
      'drop-landed': 'drops24h',
      'compartment-published': 'compartments24h',
      'emergency-reclaim': 'emergency24h',
      'memory-promote': 'promote24h',
    }
    const h: Record<string, number> = { passes24h: 0, drops24h: 0, compartments24h: 0, emergency24h: 0, promote24h: 0 }
    let errors24h = 0
    let errorsSinceBoot = 0
    let reclaimed24h = 0
    let lastPressure: number | undefined
    let lastTokens: number | undefined
    let lastContextWindow: number | undefined
    let surfaceTokens: number | undefined
    let surfaceWindow: number | undefined
    try {
      for (const row of deps.stores.journalByKind(since, sessionId)) {
        if (row.level === 'error') errors24h += row.count
        const field = KIND_COUNTS[row.kind]
        if (field !== undefined) h[field] = (h[field] ?? 0) + row.count
      }
      for (const row of deps.stores.journalByKind(bootSince, sessionId)) {
        if (row.level === 'error') errorsSinceBoot += row.count
      }
      // The pill's one number: the newest pressure reading, plus the 24h net
      // reclaim the execute band actually produced (sum of negative deltas).
      for (const entry of deps.stores.listJournal({ limit: 300, ...(sessionId === undefined ? {} : { sessionId }) })) {
        if (entry.kind === 'context-pressure' && entry.data !== undefined) {
          // The native meter's own numbers (contextPressure projection): the
          // projected occupancy answers the NEXT request, while the pass
          // ledger below only moves when a management pass runs. Preferred
          // whenever a reading exists — newest row wins by iteration order.
          lastTokens = firstNum(lastTokens, entry.data.projectedTokens)
          lastContextWindow = firstNum(lastContextWindow, entry.data.contextWindow)
          if (lastPressure === undefined && typeof entry.data.projectedTokens === 'number' && typeof entry.data.contextWindow === 'number' && entry.data.contextWindow > 0) {
            lastPressure = entry.data.projectedTokens / entry.data.contextWindow * 100
          }
          continue
        }
        if (entry.kind !== 'pass' || entry.data === undefined) continue
        lastPressure = firstNum(lastPressure, entry.data.pressure)
        // The post-compaction SURFACE account (execute passes only), separate
        // from the projected occupancy above: different denominators of truth.
        if (entry.data.decision === 'execute') {
          surfaceTokens = firstNum(surfaceTokens, entry.data.tokensBefore)
          surfaceWindow = firstNum(surfaceWindow, entry.data.contextWindow)
          const delta = entry.data.tokensDelta
          if (typeof delta === 'number' && delta < 0) reclaimed24h += -delta
        }
        lastTokens = firstNum(lastTokens, entry.data.tokensBefore)
        lastContextWindow = firstNum(lastContextWindow, entry.data.contextWindow)
      }
    } catch {
      /* a locked or missing table must not break the UI */
    }
    // Bounds are global-store facts: read once, serve both the scoped and the
    // whole-store fields (a failed read leaves them at zero — diagnostic only).
    let boundsRows = 0
    let boundsNewest: number | undefined
    try {
      const bounds = deps.stores.journalBounds()
      boundsRows = bounds.rows
      boundsNewest = bounds.newest
    } catch {
      /* diagnostic fields degrade to zero */
    }
    const journalRows = sessionId === undefined
      ? boundsRows
      : (() => {
        try {
          return deps.stores.journalByKind(undefined, sessionId).reduce((total, row) => total + row.count, 0)
        } catch {
          return 0
        }
      })()
    const lastEventAt = sessionId === undefined ? boundsNewest : newestOf(sessionId)?.at
    let memoryStats: Record<string, unknown> | undefined
    let maintenanceLast: Record<string, unknown> | undefined
    try {
      // The KPI must count the SAME project the header reports, or a global
      // summary shows one project's identity above another project's totals
      // (measured: identity git:93eea8… with 101 rows that belonged to
      // git:a81f6372…, because the fallback picked the first-seen identity of a
      // process serving several sessions). `project()` resolves it from the
      // newest recall of this scope — the same source as `project.identity`.
      const scopeIdentity = project(sessionId).identity
      memoryStats = deps.memoryStats?.(
        sessionId,
        typeof scopeIdentity === 'string' ? scopeIdentity : undefined,
      ) as Record<string, unknown> | undefined
      maintenanceLast = deps.maintenanceLast?.() as Record<string, unknown> | undefined
    } catch {
      /* stats are panel decoration; never let them break the summary */
    }
    return {
      journalRows,
      journalRowsAll: boundsRows,
      lastEventAt,
      passes24h: h.passes24h,
      errors24h,
      errorsSinceBoot,
      drops24h: h.drops24h,
      compartments24h: h.compartments24h,
      emergency24h: h.emergency24h,
      promote24h: h.promote24h,
      reclaimed24h,
      lastPressure,
      lastTokens,
      lastContextWindow,
      // Frozen summary shape (telemetry.spec asserts it): same value as
      // project.memories, kept for JSON-consumer compatibility.
      memoriesRecalled: typeof latestRecall(sessionId)?.data?.rows === 'number'
        ? latestRecall(sessionId)?.data?.rows
        : 0,
      // The post-compaction SURFACE account (newest execute pass), separate
      // from the projected occupancy: the panel labels the two explicitly.
      ...(surfaceTokens !== undefined ? { surfaceLedger: { tokens: surfaceTokens, ...(surfaceWindow !== undefined ? { window: surfaceWindow } : {}) } } : {}),
      ...(memoryStats !== undefined ? { memoryStats } : {}),
      ...(maintenanceLast !== undefined ? { maintenanceLast } : {}),
    }
  }

  const recent = (limit: number, sessionId?: string): Array<Record<string, unknown>> => {
    try {
      // Newest-first from the store; the UI wants chronological order.
      return deps.stores.listJournal({
        limit,
        ...sessionId === undefined ? {} : { sessionId },
      })
        .map(entry => ({
          at: entry.at,
          level: entry.level,
          kind: entry.kind,
          summary: entry.summary,
          ...entry.sessionId === undefined ? {} : { sessionId: entry.sessionId },
          // The record model reads numbers off `data` (inserted/ms/pressure);
          // without it the snapshot strip falls back to the raw English
          // summary while the live stream renders properly.
          ...entry.data === undefined ? {} : { data: entry.data },
        }))
        .reverse()
    } catch {
      return []
    }
  }

  const summary = (sessionId?: string): Record<string, unknown> => ({
    scope: sessionId === undefined ? 'global' : 'session',
    ...sessionId === undefined ? {} : { sessionId },
    adapter: {
      schemaVersion: SCHEMA_VERSION,
      uptimeMs: deps.startedAt === undefined ? undefined : now() - deps.startedAt,
      sseClients: streams.size,
      sseAttachedTotal: attachedTotal,
      ...lastAttachedAt === undefined ? {} : { sseLastAttachedAt: lastAttachedAt },
      ...deps.meta(),
    },
    project: project(sessionId),
    health: health(sessionId),
    recent: recent(20, sessionId),
  })

  const sendJson = (res: TelemetryResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  }

  const openStream = (res: TelemetryResponse, sessionId?: string): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const write = (chunk: string): void => {
      try {
        res.write?.(chunk)
      } catch {
        /* the client went away */
      }
    }
    write(`event: snapshot\ndata: ${JSON.stringify(summary(sessionId))}\n\n`)

    // Poll the journal rather than holding a query open: reads are cheap, the
    // writer is a different connection, and a restart of the store is invisible.
    // The cursor starts at this scope's newest row, so a Session stream never
    // replays another Session's history.
    let lastSeen = 0
    try {
      lastSeen = Number((sessionId === undefined
        ? deps.stores.journalBounds().newest
        : newestOf(sessionId)?.at) ?? 0)
    } catch {
      lastSeen = 0
    }
    const timer = setInterval(() => {
      try {
        const fresh = deps.stores.listJournal({
          since: lastSeen + 1,
          limit: 20,
          ...sessionId === undefined ? {} : { sessionId },
        })
        for (const entry of [...fresh].reverse()) {
          lastSeen = Math.max(lastSeen, entry.at)
          write(`event: journal\ndata: ${JSON.stringify({
            at: entry.at,
            level: entry.level as JournalLevel,
            kind: entry.kind,
            summary: entry.summary,
            ...entry.sessionId === undefined ? {} : { sessionId: entry.sessionId },
            data: entry.data,
          })}\n\n`)
        }
      } catch {
        /* keep the stream alive on a transient read failure */
      }
    }, pollMs)
    const keepAlive = setInterval(() => write(': keep-alive\n\n'), 15_000)
    const stop = (): void => {
      clearInterval(timer)
      clearInterval(keepAlive)
      streams.delete(stream)
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
    const stream = { stop }
    streams.add(stream)
    attachedTotal += 1
    lastAttachedAt = now()
    res.on?.('close', stop)
  }

  return {
    get openStreams() {
      return streams.size
    },
    summary,
    handle: (req, res) => {
      const base = '/mc-telemetry'
      // A throwaway base keeps `new URL` total for an origin-form request target.
      const requestUrl = new URL(req.url ?? '/', 'http://telemetry.invalid')
      const url = requestUrl.pathname
      const path = url.startsWith(base) ? url.slice(base.length) || '/' : url
      const sessionId = sessionOf(requestUrl.searchParams.get('session'))
      if (path === '/summary' || path === '/' || path === '') {
        sendJson(res, 200, summary(sessionId))
        return
      }
      if (path === '/events') {
        openStream(res, sessionId)
        return
      }
      sendJson(res, 404, { error: 'unknown telemetry route', routes: ['/summary', '/events'] })
    },
    close: () => {
      for (const stream of [...streams]) stream.stop()
    },
  }
}
