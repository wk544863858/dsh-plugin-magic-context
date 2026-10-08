/**
 * The telemetry surface the browser half consumes.
 *
 * The route is the only supported way for a third-party bundle to push live
 * state into the UI (the Remote event whitelist is compile-time), so its
 * payload shape and its privacy properties are contract: counts and one-line
 * summaries only, and a locked/missing store must degrade instead of throwing.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '<path>'
import { createTelemetryService } from '<path>'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(): { stores: ReturnType<typeof openStores>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mc-telemetry-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
  const stores = openStores(dir)
  cleanups.push(() => stores.close())
  const now = Date.now()
  stores.appendJournal({ at: now - 2_000, level: 'info', kind: 'boot', summary: 'adapter booted' })
  stores.appendJournal({
    at: now - 1_000, level: 'info', kind: 'pass', summary: 'execute at 71%',
    data: { decision: 'execute', tokensBefore: 91_000, tokensAfter: 74_500 },
  })
  stores.appendJournal({
    at: now - 500, level: 'info', kind: 'memory-recall', summary: 'recalled 40 memories',
    data: { rows: 40 },
  })
  stores.appendJournal({ at: now - 100, level: 'error', kind: 'error', summary: 'historian failed' })
  return { stores, dir }
}

/** A minimal ServerResponse stand-in that records what was written. */
function fakeResponse(): {
  status?: number
  headers?: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  write(chunk: string): void
  end(chunk?: string): void
  on(): void
} {
  const res = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res.status = status
      res.headers = headers
    },
    write(chunk: string) {
      res.body += chunk
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.body += chunk
    },
    on() {
      /* no close event in the fake */
    },
  }
  return res
}

describe('telemetry service', () => {
  it('summarises adapter state, health and the recent tail', () => {
    const { stores } = fixture()
    const service = createTelemetryService({
      stores,
      meta: () => ({ engine: 'disabled-by-config', memory: 'ok schema v94', toolsMode: 'dynamic-import' }),
      startedAt: Date.now() - 60_000,
    })
    cleanups.push(() => service.close())

    const summary = service.summary() as {
      adapter: Record<string, unknown>
      health: Record<string, number>
      recent: Array<{ kind: string }>
    }
    expect(summary.adapter.engine).toBe('disabled-by-config')
    expect(summary.adapter.toolsMode).toBe('dynamic-import')
    expect(summary.health.journalRows).toBe(4)
    expect(summary.health.passes24h).toBe(1)
    expect(summary.health.errors24h).toBe(1)
    expect(summary.health.memoriesRecalled).toBe(40)
    expect(summary.recent.map(entry => entry.kind)).toEqual(['boot', 'pass', 'memory-recall', 'error'])
    // Privacy: no message content, no file paths in the payload.
    expect(JSON.stringify(summary)).not.toContain('C:\\')
  })

  it('serves JSON on /summary and 404s unknown routes', () => {
    const { stores } = fixture()
    const service = createTelemetryService({ stores, meta: () => ({}) })
    cleanups.push(() => service.close())

    const ok = fakeResponse()
    service.handle({ url: '/mc-telemetry/summary', method: 'GET' }, ok)
    expect(ok.status).toBe(200)
    expect(ok.headers?.['content-type']).toContain('application/json')
    expect(JSON.parse(ok.body)).toHaveProperty('health')

    const missing = fakeResponse()
    service.handle({ url: '/mc-telemetry/nope', method: 'GET' }, missing)
    expect(missing.status).toBe(404)
  })

  it('streams a snapshot then new journal entries as SSE frames', async () => {
    const { stores } = fixture()
    const service = createTelemetryService({ stores, meta: () => ({}), pollMs: 20 })
    cleanups.push(() => service.close())

    const res = fakeResponse()
    service.handle({ url: '/mc-telemetry/events', method: 'GET' }, res)
    expect(res.headers?.['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('event: snapshot')
    expect(service.openStreams).toBe(1)

    // A new event reaches the stream, and only once.
    stores.appendJournal({ at: Date.now(), level: 'info', kind: 'memory-promote', summary: 'promoted 2 facts' })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(res.body).toContain('event: journal')
    expect(res.body).toContain('memory-promote')
    expect(res.body.match(/memory-promote/g)?.length).toBe(1)
  })
})
