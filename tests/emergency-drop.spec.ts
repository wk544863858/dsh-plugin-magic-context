/**
 * Emergency reclaim — the P2-C1/C2 protection model.
 *
 * Pinned here (MC emergency-drop.ts / selection.rs:1185 parity):
 *  - the protection WINDOW is `clamp(contextWindow × 5%, 8k, 64k)` tokens of
 *    the NEWEST tagged results; unknown window falls back to the count floor;
 *  - the count floor (`policy.protectedToolResults`) shields the newest nodes
 *    even when a single huge result exceeds the window;
 *  - drop order is worst tier first (T3 misc → T2 edit/search → T1
 *    navigation), oldest first inside a tier — T1 tools (read/task) are the
 *    last to go even when they are the oldest;
 *  - `mcp_`-prefixed names normalize onto the core tier lists.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeToolName,
  protectionWindowTokens,
  reclaimForEmergency,
  resolveToolTier,
} from '<path>'
import {
  enumerateSurfaceToolResults,
} from '<path>'
import { DEFAULT_POLICY } from '<path>'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    } catch {
      /* best effort */
    }
  }
})

const silentLogger = { info: () => {}, warn: () => {} }
void silentLogger

interface NodeSpec {
  readonly seq: number
  readonly callId: string
  readonly name: string
  readonly text: string
  readonly tag?: number
}

/** A minimal session double: `tool/call` + `tool/result` events + surface. */
function fakeSession(nodes: readonly NodeSpec[]): {
  session: never
  resultSeqs: number[]
} {
  const events: Array<Record<string, unknown>> = []
  const resultSeqs: number[] = []
  for (const node of nodes) {
    events.push({
      seq: node.seq - 1,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: node.callId, name: node.name, arguments: '{}' },
    })
    events.push({
      seq: node.seq,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: node.callId, content: [{ type: 'text', text: node.text }] },
      },
    })
    resultSeqs.push(node.seq)
  }
  let nextSeq = nodes.reduce((max, node) => Math.max(max, node.seq), 0) + 10
  const session = {
    snapshotEvents: () => events,
    surface: { nodes: resultSeqs, replaceGeneration: 1 },
    append(_type: string, data: unknown): { seq: number } {
      const seq = nextSeq++
      events.push({ seq, type: 'tool/result', data })
      return { seq }
    },
  }
  return { session: session as never, resultSeqs }
}

const POLICY = { ...DEFAULT_POLICY }

describe('protection window is clamp(5% × window, 8k, 64k)', () => {
  it('clamps both ends and reports undefined without a window', () => {
    expect(protectionWindowTokens(100_000)).toBe(8_000)
    expect(protectionWindowTokens(200_000)).toBe(10_000)
    expect(protectionWindowTokens(1_000_000)).toBe(50_000)
    expect(protectionWindowTokens(4_000_000)).toBe(64_000)
    expect(protectionWindowTokens(undefined)).toBeUndefined()
    expect(protectionWindowTokens(0)).toBeUndefined()
  })
})

describe('tool tiers mirror MC emergency-drop.ts', () => {
  it('classifies T1 navigation / T2 edit-search / T3 default', () => {
    expect(resolveToolTier('read')).toBe(1)
    expect(resolveToolTier('task')).toBe(1)
    expect(resolveToolTier('edit')).toBe(2)
    expect(resolveToolTier('grep')).toBe(2)
    expect(resolveToolTier('bash')).toBe(3)
    expect(resolveToolTier('web_fetch')).toBe(3)
    expect(resolveToolTier(null)).toBe(3)
  })

  it('normalizes mcp_ prefixes onto the core lists', () => {
    expect(normalizeToolName('mcp_grep')).toBe('grep')
    expect(resolveToolTier('mcp_grep')).toBe(2)
  })
})

describe('the token window protects the newest results', () => {
  function nodes(count: number, text: string, name = 'bash'): NodeSpec[] {
    return Array.from({ length: count }, (_unused, index) => ({
      seq: index + 1,
      callId: `call-${String(index + 1)}`,
      name,
      text,
      tag: index + 1,
    }))
  }

  function enumerate(session: never, resultSeqs: number[]) {
    return enumerateSurfaceToolResults(session as never, callId => {
      const index = Number(callId.slice('call-'.length))
      return index
    }).filter(node => resultSeqs.includes(node.seq))
  }

  it('protects the newest tail inside the window and drops the rest', () => {
    // 8 nodes × 10,000 chars (≈2,500 tok); window 8,000 tok → newest 3 fit.
    // The floor is set to 2 so the THIRD protected node proves the window
    // (a floor-only pass would protect exactly 2).
    const specs = nodes(8, 'x'.repeat(10_000))
    const { session, resultSeqs } = fakeSession(specs)
    const enumerated = enumerate(session, resultSeqs)
    const policy = { ...POLICY, protectedToolResults: 2 }
    const result = reclaimForEmergency(session as never, enumerated, policy, 160_000)
    expect(result.protectedCount).toBe(3)
    expect(result.protectedTokens).toBe(7_500)
    expect(result.dropped.map(drop => drop.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the count floor when a single huge result exceeds the window', () => {
    // 10 nodes × 400,000 chars (≈100k tok each) — the window fits nothing,
    // but the newest `protectedToolResults` (8) stay protected regardless.
    const specs = nodes(10, 'x'.repeat(400_000))
    const { session, resultSeqs } = fakeSession(specs)
    const enumerated = enumerate(session, resultSeqs)
    const result = reclaimForEmergency(session as never, enumerated, POLICY, 160_000)
    expect(result.protectedCount).toBe(POLICY.protectedToolResults)
    expect(result.dropped.length).toBe(2)
    expect(result.dropped.map(drop => drop.seq)).toEqual([1, 2])
  })

  it('drops worst tier first: T1 navigation survives longer than older T3', () => {
    // 4 nodes, every one beyond any window (100k tok each): with the floor at
    // zero all four drop, so the TIER ORDER becomes observable — T3 oldest
    // first, then the T1 reads oldest first.
    const specs: NodeSpec[] = [
      { seq: 1, callId: 'call-1', name: 'read', text: 'y'.repeat(400_000) },
      { seq: 2, callId: 'call-2', name: 'bash', text: 'y'.repeat(400_000) },
      { seq: 3, callId: 'call-3', name: 'read', text: 'y'.repeat(400_000) },
      { seq: 4, callId: 'call-4', name: 'bash', text: 'y'.repeat(400_000) },
    ]
    const { session, resultSeqs } = fakeSession(specs)
    const enumerated = enumerate(session, resultSeqs)
    const tinyFloorPolicy = { ...POLICY, protectedToolResults: 0 }
    const result = reclaimForEmergency(session as never, enumerated, tinyFloorPolicy, 160_000)
    const droppedTexts = result.dropped.map(drop => {
      const spec = specs.find(candidate => candidate.seq === drop.seq)!
      return spec.name
    })
    expect(droppedTexts).toEqual(['bash', 'bash', 'read', 'read'])
  })

  it('falls back to count-floor-only behavior without a window', () => {
    const specs = nodes(10, 'x'.repeat(10_000))
    const { session, resultSeqs } = fakeSession(specs)
    const enumerated = enumerate(session, resultSeqs)
    const result = reclaimForEmergency(session as never, enumerated, POLICY)
    expect(result.protectedCount).toBe(POLICY.protectedToolResults)
    expect(result.dropped.length).toBe(10 - POLICY.protectedToolResults)
    expect(result.protectedTokens).toBeUndefined()
  })
})
