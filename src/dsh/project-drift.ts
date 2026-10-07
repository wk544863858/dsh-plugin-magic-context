/**
 * Cross-project drift detection (the DSH answer to a signal OpenCode has and
 * DSH does not: a per-turn working directory).
 *
 * OpenCode sessions carry a `directory` the host updates as work moves; Magic
 * Context keys its session→project binding on it. DSH sessions freeze `cwd`
 * at creation and never say where the work is happening now — an agent opened
 * in project1 that starts editing project2 produces facts with no host-side
 * scope signal at all. We cannot fix that at write time (the `project`
 * argument on `ctx_memory` is the model-scoped escape hatch), but we can
 * OBSERVE it: the turn's own text mentions the paths it is working on, and
 * each path resolves to a git root. Roots that differ from the session's own
 * root are drift — worth a warn-level journal row so the report can quantify
 * how often cross-project sessions actually happen.
 *
 * Cost discipline: the turn text is scanned once with one regex; only
 * directory prefixes not seen before in this process spawn one synchronous
 * `git rev-parse --show-toplevel` (3s timeout, cached forever — a project
 * does not change root while this process lives). Everything fails open:
 * any error means "no drift observed", never a thrown error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProjectDriftOutcome {
  /** The session cwd's git root, when it has one. */
  readonly sessionRoot?: string
  /** Git roots observed in the turn text that are NOT the session's own. */
  readonly foreignRoots: readonly string[]
}

const rootCache = new Map<string, string | null>()

/** At most this many unseen directories probe git per turn (noise guard). */
const MAX_PROBES_PER_TURN = 8

/** Absolute-path candidates: Windows drive/UNC, or POSIX absolute. */
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|;*?]{2,180}|\/(?:home|Users|mnt|data|srv|opt)[^\s"'`<>|;*?]{2,180})/g

/** `git rev-parse --show-toplevel` for a directory, cached for the process. */
function gitRootOf(dir: string): string | null {
  const key = dir.replace(/\\/g, '/').replace(/[/\\]+$/, '')
  const cached = rootCache.get(key)
  if (cached !== undefined) return cached
  // The mentioned path may be hypothetical (a file the text plans to create),
  // so its own directory may not exist — walk up to the nearest ancestor that
  // does and resolve from there; git itself finds the containing root.
  let probeDir: string | null = null
  let cursor = dir
  for (let hops = 0; hops < 8; hops += 1) {
    if (existsSync(cursor)) {
      probeDir = cursor
      break
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  let root: string | null = null
  if (probeDir !== null) {
    try {
      const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: probeDir,
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
      })
      const stdout = typeof probe.stdout === 'string' ? probe.stdout.trim() : ''
      if (probe.status === 0 && stdout !== '') root = stdout.replace(/\\/g, '/')
    } catch {
      root = null
    }
  }
  rootCache.set(key, root)
  return root
}

function isInside(candidate: string, root: string): boolean {
  const c = candidate.replace(/\\/g, '/').toLowerCase()
  const r = root.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return c === r || c.startsWith(r + '/')
}

/**
 * Scan one turn's text for absolute paths, resolve each one's git root
 * (cached), and report the roots foreign to the session's own. Returns
 * `undefined` when there is nothing to report: no paths, no session cwd,
 * or every observed root is the session's own.
 */
export function detectProjectDrift(text: string, sessionCwd: string | undefined): ProjectDriftOutcome | undefined {
  if (typeof text !== 'string' || text.length < 8) return undefined
  if (sessionCwd === undefined || sessionCwd === '') return undefined
  const sessionRoot = gitRootOf(sessionCwd)
  if (sessionRoot === null) return undefined
  let probes = 0
  const foreign = new Set<string>()
  for (const match of text.matchAll(PATH_RE)) {
    if (probes >= MAX_PROBES_PER_TURN) break
    const raw = match[0].replace(/[.,;:)\]]+$/, '')
    // Walk a couple of parents: the mention may be a file deep inside a repo
    // whose nearer directories are cached under another spelling anyway.
    const dir = raw.replace(/[\\/][^\\/]+$/, '')
    if (dir === '' || rootCache.has(dir.replace(/\\/g, '/'))) {
      // Already known: consult the cache without spending a probe.
      const known = rootCache.get(dir.replace(/\\/g, '/'))
      if (known !== null && known !== undefined && !isInside(known, sessionRoot) && !isInside(sessionRoot, known)) {
        foreign.add(known)
      }
      continue
    }
    probes += 1
    const root = gitRootOf(dir)
    if (root !== null && !isInside(root, sessionRoot) && !isInside(sessionRoot, root)) {
      foreign.add(root)
    }
  }
  if (foreign.size === 0) return undefined
  return { sessionRoot, foreignRoots: [...foreign].sort() }
}
