/**
 * /ctx-status — the adapter's status surface (Magic Context's command of the
 * same name, MVP scope): live pressure, the pass decision it implies, and
 * the tag/reclaim ledger.
 */
import type { Context } from '@deepseek-ai/cordis'
import { decidePass, pressurePercent } from '../core/policy.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { enumerateSurfaceToolResults, requestContextOf } from './seams.ts'

export interface StatusDeps {
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
}

/** Narrowed registration surface (keeps the package typecheck standalone). */
type CommandRegistrar = {
  register(definition: {
    name: string
    description: string
    handler: (invocation: { readonly agent: { readonly session: {
      id: string
      snapshotEvents(): unknown[]
      surface: { nodes: readonly number[] }
    } } }) => { kind: 'success'; text?: string } | { kind: 'error'; text: string }
  }): unknown
}

export function registerCtxStatusCommand(ctx: Context, deps: StatusDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-status unavailable')
    return
  }
  commands.register({
    name: 'ctx-status',
    description: 'Magic Context: pressure, reclaim ledger, and pass state for this session.',
    handler: (invocation) => {
      const sessionId = invocation.agent.session.id
      const latest = deps.stores.latestUsage(sessionId)
      const { contextWindow } = requestContextOf(invocation.agent.session as never)
      const pressure = pressurePercent(latest, contextWindow)
      const decision = decidePass({ latest, pressure, now: Date.now(), policy: deps.policy })
      const nodes = enumerateSurfaceToolResults(invocation.agent.session as never, callId =>
        deps.stores.getTag(sessionId, { kind: 'tool-result', callId }))
      const tagged = nodes.filter(node => node.tagNumber !== undefined)
      const dropped = tagged.filter(node => node.isPlaceholder)
      const pending = deps.stores.listPendingDrops(sessionId)
      const compartments = deps.stores.listCompartments(sessionId)
      const unlanded = deps.stores.listUnlandedCompartments(sessionId)
      const baseline = deps.stores.baselineState(sessionId)
      const coveredTokens = compartments.reduce((total, compartment) => total + compartment.coveredTokens, 0)
      // Journal health: the validation-period at-a-glance check (the full
      // review lives in scripts/mc-report.mjs).
      let journalLine = '- journal: unavailable'
      try {
        const bounds = deps.stores.journalBounds()
        const dayAgo = Date.now() - 24 * 60 * 60_000
        const recent = deps.stores.journalByKind(dayAgo)
        const errors = recent.filter(row => row.level === 'error').reduce((total, row) => total + row.count, 0)
        const passes = recent.filter(row => row.kind === 'pass').reduce((total, row) => total + row.count, 0)
        journalLine = `- journal: ${String(bounds.rows)} entries`
          + `${bounds.newest === undefined ? '' : `, latest ${new Date(bounds.newest).toISOString()}`}`
          + `; last 24h: ${String(passes)} pass event(s), ${String(errors)} error(s)`
          + `${bounds.rows === 0 ? ' (audit layer empty: was this build reloaded?)' : ''}`
      } catch (error) {
        journalLine = `- journal: read failed (${error instanceof Error ? error.message : String(error)})`
      }
      const lines = [
        'Magic Context (dsh adapter) — status',
        `- usage: ${latest === undefined
          ? 'no response recorded yet'
          : `${pressure === undefined ? '?' : pressure.toFixed(1)}% of ${String(contextWindow ?? '?')} tokens `
            + `(last input ${String(latest.inputTokens ?? 0)} + cache `
            + `${String((latest.cacheReadTokens ?? 0) + (latest.cacheWriteTokens ?? 0))}, `
            + `at ${new Date(latest.recordedAt).toISOString()})`}`,
        `- pass: ${decision.kind} (${decision.reason})`,
        `- tool outputs: ${String(tagged.length)} tagged, ${String(dropped.length)} dropped as placeholders`,
        `- reclaim queue: ${pending.length === 0 ? 'empty' : pending.map(tag => `§${String(tag)}§`).join(', ')}`,
        `- historian: ${String(compartments.length)} compartment(s), ~${String(coveredTokens)} tokens digested`
          + `${unlanded.length === 0 ? '' : `, ${String(unlanded.length)} awaiting publication`}`,
        `- baseline: ${baseline === undefined
          ? 'not built yet'
          : `epoch ${String(baseline.epoch)}, node ${String(baseline.nodeSeq ?? '?')}, `
            + `frozen ${new Date(baseline.frozenAt).toISOString()}`
            + `${baseline.memoriesDigest === undefined ? '' : ', memories injected'}`}`,
        `- policy: execute ≥ ${String(deps.policy.executeThreshold)}%, force ≥ ${String(deps.policy.forceThreshold)}%, `
          + `ttl ${String(Math.round(deps.policy.ttlMs / 1000))}s, protect newest ${String(deps.policy.protectedToolResults)} `
          + `(+${String(deps.policy.historianProtectedNodes)} from the historian)`,
        journalLine,
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
