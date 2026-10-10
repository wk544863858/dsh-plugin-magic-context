/**
 * /ctx-status — the adapter's status surface (Magic Context's command of the
 * same name, MVP scope): live pressure, the pass decision it implies, and
 * the tag/reclaim ledger.
 */
import type { Context } from '@deepseek-ai/cordis'
import { decidePass, pressurePercent, pressureWindowTokens } from '../core/policy.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { enumerateSurfaceToolResults, requestContextOf } from './seams.ts'

export interface StatusDeps {
  readonly stores: AdapterStores
  /**
   * The pressure policy — a snapshot, or a LIVE resolver (the composition
   * passes `activePolicy`, so `/ctx-status` prints the thresholds the next
   * pass will actually use; the old mount-time snapshot kept printing stale
   * numbers after a settings-form edit until restart).
   */
  readonly policy: PressurePolicy | (() => PressurePolicy)
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
      const policy = typeof deps.policy === 'function' ? deps.policy() : deps.policy
      const latest = deps.stores.latestUsage(sessionId)
      const { contextWindow } = requestContextOf(invocation.agent.session as never)
      // The same denominator the pass decision uses, so the reported percent
      // and the decision printed below it can never disagree.
      const pressureWindow = pressureWindowTokens(contextWindow, policy)
      const pressure = pressurePercent(latest, pressureWindow)
      const decision = decidePass({ latest, pressure, now: Date.now(), policy })
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
          : `${pressure === undefined ? '?' : pressure.toFixed(1)}% of ${String(pressureWindow)} tokens`
            + `${contextWindow === undefined ? ' (assumed; the route discloses none)' : ''} `
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
        `- policy: execute ≥ ${String(policy.executeThreshold)}%, force ≥ ${String(policy.forceThreshold)}%, `
          + `ttl ${String(Math.round(policy.ttlMs / 1000))}s, protect newest ${String(policy.protectedToolResults)} `
          + `(+${String(policy.historianProtectedNodes)} from the historian), `
          + `assumed window ${String(policy.assumedContextWindow)} tokens`,
        journalLine,
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
