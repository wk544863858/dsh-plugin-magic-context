/**
 * Where the runnable suite lives.
 *
 * The adapter's specs need a DSH checkout with `node_modules` (vitest plus the
 * `@deepseek-ai/dsh-*` packages); this repository has none, so vitest always
 * runs inside a test host. Resolution order, first existing root wins:
 *
 *   1. `MC_DSH_CHECKOUT` / `DSH_TESTHOST` — explicit override
 *   2. `<repo>/<tmp>/deepseek-harness-master` — project-local snapshot
 *      (gitignored through the repository's `.tmp-*​/` rule; the default)
 *   3. `<temp>/dsh-src/deepseek-harness-master` — legacy scratch checkout
 *
 * The project-local host is created or repaired by `bootstrap-testhost.mjs`;
 * nothing here writes to it.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/dsh-plugin/scripts` */
export const SCRIPTS = dirname(fileURLToPath(import.meta.url))
/** `packages/dsh-plugin` */
export const PKG = resolve(SCRIPTS, '..')
/** repository root */
export const REPO = resolve(PKG, '..', '..')

/** Relative to a test host root. */
export const SUITE_DIR = join('packages', 'test-support', 'mc-dsh-poc')
export const SUITE_TESTS = join(SUITE_DIR, 'tests')
/** Host-only files kept inside the repository (see bootstrap-testhost.mjs). */
export const LOCAL_HOST_FILES = join(REPO, '<tmp>', 'mc-dsh-poc-local')

export const PROJECT_HOST = join(REPO, '<tmp>', 'deepseek-harness-master')
export const LEGACY_HOST = join(tmpdir(), 'dsh-src', 'deepseek-harness-master')

/** Every candidate root, in precedence order, as `{ source, root }`. */
export function hostCandidates() {
  const out = []
  for (const [source, value] of [
    ['MC_DSH_CHECKOUT', process.env.MC_DSH_CHECKOUT],
    ['DSH_TESTHOST', process.env.DSH_TESTHOST],
  ]) {
    if (value) out.push({ source, root: resolve(value) })
  }
  out.push({ source: 'project snapshot', root: PROJECT_HOST })
  out.push({ source: 'legacy temp checkout', root: LEGACY_HOST })
  return out
}

/**
 * The test host this run should use: `{ source, root, installed, suite }`.
 * Throws `NO_TEST_HOST` when no candidate exists.
 */
export function resolveTestHost() {
  for (const candidate of hostCandidates()) {
    if (!existsSync(candidate.root)) continue
    return {
      ...candidate,
      installed: existsSync(join(candidate.root, 'node_modules', '.bin')),
      suite: existsSync(join(candidate.root, SUITE_TESTS)),
    }
  }
  const tried = hostCandidates().map((c) => `  - ${c.root}  (${c.source})`).join('\n')
  const error = new Error(
    `no DSH test host found; tried:\n${tried}\n` +
      '  fix: node packages/dsh-plugin/scripts/bootstrap-testhost.mjs',
  )
  error.code = 'NO_TEST_HOST'
  throw error
}
