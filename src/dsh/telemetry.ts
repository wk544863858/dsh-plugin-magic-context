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
   * sessionId so per-session panels answer for their own project; the
   * composition root decides the fallback (the configured project).
   */
  readonly memoryStats?: (sessionId?: string) => {
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
    let passes24h = 0
    let errors24h = 0
    let errorsSinceBoot = 0
    let drops24h = 0
    let compartments24h = 0
    let memoriesRecalled = 0
    let emergency24h = 0
    let promote24h = 0
    let reclaimed24h = 0
    let lastPressure: number | undefined
    let lastTokens: number | undefined
    let lastContextWindow: number | undefined
    let surfaceTokens: number | undefined
    let surfaceWindow: number | undefined
    try {
      for (const row of deps.stores.journalByKind(since, sessionId)) {
        if (row.kind === 'pass') passes24h += row.count
        if (row.level === 'error') errors24h += row.count
        if (row.kind === 'drop-landed') drops24h += row.count
        if (row.kind === 'compartment-published') compartments24h += row.count
        if (row.kind === 'emergency-reclaim') emergency24h += row.count
        if (row.kind === 'memory-promote') promote24h += row.count
      }
      for (const row of deps.stores.journalByKind(bootSince, sessionId)) {
        if (row.level === 'error') errorsSinceBoot += row.count
      }
      const rows = latestRecall(sessionId)?.data?.rows
      if (typeof rows === 'number') memoriesRecalled = rows
      // The pill's one number: the newest pressure reading, plus the 24h net
      // reclaim the execute band actually produced (sum of negative deltas).
      for (const entry of deps.stores.listJournal({ limit: 300, ...(sessionId === undefined ? {} : { sessionId }) })) {
        if (entry.kind === 'context-pressure' && entry.data !== undefined) {
          // The native meter's own numbers (contextPressure projection): the
          // projected occupancy answers the NEXT request, while the pass
          // ledger below only moves when a management pass runs. Preferred
          // whenever a reading exists — newest row wins by iteration order.
          const projected = entry.data.projectedTokens
          const window = entry.data.contextWindow
          if (lastTokens === undefined && typeof projected === 'number') lastTokens = projected
          if (lastContextWindow === undefined && typeof window === 'number') lastContextWindow = window
          if (lastPressure === undefined && typeof projected === 'number' && typeof window === 'number' && window > 0) {
            lastPressure = projected / window * 100
          }
          continue
        }
        if (entry.kind !== 'pass' || entry.data === undefined) continue
        const pressure = entry.data.pressure
        if (lastPressure === undefined && typeof pressure === 'number') lastPressure = pressure
        // Absolute context size for the panel: the newest pass's ledger
        // (tokensBefore) over the window it was measured against — the
        // post-compaction SURFACE account, kept separate from the projected
        // occupancy above because the two are different denominators of truth.
        if (typeof entry.data.tokensBefore === 'number' && entry.data.decision === 'execute') {
          if (surfaceTokens === undefined) surfaceTokens = entry.data.tokensBefore
          if (surfaceWindow === undefined && typeof entry.data.contextWindow === 'number') surfaceWindow = entry.data.contextWindow
        }
        if (lastTokens === undefined && typeof entry.data.tokensBefore === 'number') lastTokens = entry.data.tokensBefore
        if (lastContextWindow === undefined && typeof entry.data.contextWindow === 'number') lastContextWindow = entry.data.contextWindow
        if (entry.data.decision === 'execute') {
          const delta = entry.data.tokensDelta
          if (typeof delta === 'number' && delta < 0) reclaimed24h += -delta
        }
      }
    } catch {
      /* a locked or missing table must not break the UI */
    }
    let journalRows = 0
    let lastEventAt: number | undefined
    try {
      journalRows = sessionId === undefined
        ? deps.stores.journalBounds().rows
        : deps.stores.journalByKind(undefined, sessionId).reduce((total, row) => total + row.count, 0)
      lastEventAt = sessionId === undefined
        ? deps.stores.journalBounds().newest
        : newestOf(sessionId)?.at
    } catch {
      journalRows = 0
    }
    // Whole-store row count: kept alongside the scoped one for diagnosis.
    let journalRowsAll = 0
    try {
      journalRowsAll = deps.stores.journalBounds().rows
    } catch {
      journalRowsAll = journalRows
    }
    let memoryStats: Record<string, unknown> | undefined
    let maintenanceLast: Record<string, unknown> | undefined
    try {
      memoryStats = deps.memoryStats?.(sessionId) as Record<string, unknown> | undefined
      maintenanceLast = deps.maintenanceLast?.() as Record<string, unknown> | undefined
    } catch {
      /* stats are panel decoration; never let them break the summary */
    }
    return {
      journalRows,
      journalRowsAll,
      lastEventAt,
      passes24h,
      errors24h,
      errorsSinceBoot,
      drops24h,
      compartments24h,
      memoriesRecalled,
      emergency24h,
      promote24h,
      reclaimed24h,
      lastPressure,
      lastTokens,
      lastContextWindow,
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
