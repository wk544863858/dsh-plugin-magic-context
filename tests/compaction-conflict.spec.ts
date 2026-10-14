/**
 * The takeover conflict matrix (measured 2026-10-14, cordis service semantics):
 * `ctx.compaction` is FIRST-COME-FIRST-SERVED. There is no override and no
 * negotiation — the second provider's registration is rejected with
 * `service "compaction" has been registered`.
 *
 * What this means for `registerCompactionEngine`:
 *  - stock order (base bundle's compaction-basic mounts first): the adapter's
 *    engine registration is rejected INSIDE the reconcile catch → one warn log,
 *    `compaction_engine` meta records `unavailable: …`, the host's basic engine
 *    keeps compaction, and everything else about the adapter is unaffected.
 *    Default-on would therefore be a no-op on untouched stock profiles.
 *  - reverse order (adapter first): compaction-basic's OWN mount throws — its
 *    bundle fails loudly. A profile that wants the adapter's engine must not
 *    mount compaction-basic at all.
 *
 * These tests boot the REAL host stack (llm, sessions, projections, system
 * prompt, token meter, tools, agents, loop) so the semantics are pinned against
 * the genuine cordis provide path, not a stub. Every database lives under a
 * throwaway tmpdir dataDir; the memory lane is off — this file is only about
 * the seam.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import mcDshPlugin, { openStores } from '../src/index.ts'

const OURS = 'MagicContextCompactionEngine'
const THEIRS = 'BasicCompactionEngine'

const tempDirs: string[] = []
const contexts: Array<Context> = []

/** The engine mounts fire-and-forget (index.ts `void (async …)()`), so the
 *  owner must be read AFTER the async registration lands. A losing
 *  registration's rejection surfaces as an unhandled rejection when nothing
 *  catches it — the collector keeps the run clean and countable. */
const unhandled: string[] = []
const rejectionCollector = (reason: unknown): void => {
  unhandled.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
}
process.on('unhandledRejection', rejectionCollector)

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 25))
}

afterEach(async () => {
  await settle()
  const seen = unhandled.splice(0)
  expect(seen, 'no rejection may escape the guarded mount paths').toEqual([])
  for (const ctx of contexts.splice(0).reverse()) {
    try {
      await (ctx.fiber as unknown as { dispose(): Promise<void> }).dispose()
    } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
  }
})

interface MountOutcome {
  readonly ok: boolean
  readonly error?: string
}

async function boot(options: {
  basic?: boolean
  takeover?: boolean
}): Promise<{ dataDir: string; owner: string | undefined; ours?: MountOutcome; basic?: MountOutcome }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mc-conflict-'))
  tempDirs.push(dataDir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const attempt = async (mount: () => Promise<unknown>): Promise<MountOutcome> => {
    try {
      await mount()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const mountBasic = (): Promise<unknown> => ctx.plugin(BasicCompactionEngine)
  const mountOurs = (): Promise<unknown> => ctx.plugin(mcDshPlugin, {
    dataDir,
    registerCompactionEngine: options.takeover === true,
    memory: { enabled: false },
  } as never)
  let ours: MountOutcome | undefined
  let basic: MountOutcome | undefined
  // The stock composition loads the base bundle (compaction-basic) before any
  // plugin bundle, so basic-first is the real-world order.
  if (options.basic === true) basic = await attempt(mountBasic)
  if (options.takeover === true) ours = await attempt(mountOurs)
  if (options.basic === true && ours === undefined) basic = await attempt(mountBasic)
  await settle()
  const owner = (ctx as unknown as { compaction?: { constructor: { name: string } } }).compaction?.constructor?.name
  return { dataDir, owner, ours, basic }
}

function compactionMeta(dataDir: string): string | undefined {
  const stores = openStores(dataDir)
  try {
    return stores.getMeta('compaction_engine')
  } finally {
    stores.close()
  }
}

it('sanity: basic alone owns the seam under its own class name', async () => {
  const { owner } = await boot({ basic: true })
  expect(owner).toBe(THEIRS)
})

it('sanity: ours alone (takeover on) owns the seam', async () => {
  const { owner } = await boot({ takeover: true })
  expect(owner).toBe(OURS)
})

it('stock order: basic first wins; the adapter mount succeeds but the engine quietly stands down', async () => {
  const { dataDir, owner, ours } = await boot({ basic: true, takeover: true })
  expect(ours?.ok).toBe(true) // apply() itself never fails — the conflict is contained
  expect(owner).toBe(THEIRS)
  // The stand-down is observable, not silent: meta records it for the GUI.
  expect(compactionMeta(dataDir)?.startsWith('unavailable:')).toBe(true)
})

it('reverse order: the adapter mounts first and compaction-basic cannot mount at all', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mc-conflict-reverse-'))
  tempDirs.push(dataDir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(mcDshPlugin, {
    dataDir,
    registerCompactionEngine: true,
    memory: { enabled: false },
  } as never)
  let basicError: string | undefined
  let basicOk = false
  try {
    await ctx.plugin(BasicCompactionEngine)
    basicOk = true
  } catch (error) {
    basicError = error instanceof Error ? error.message : String(error)
  }
  await settle()
  const owner = (ctx as unknown as { compaction?: { constructor: { name: string } } }).compaction?.constructor?.name
  expect(owner).toBe(OURS)
  expect(basicOk).toBe(false)
  expect(basicError).toContain('service "compaction" has been registered')
})
