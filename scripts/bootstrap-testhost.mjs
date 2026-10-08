#!/usr/bin/env node
/**
 * Create or repair the project-local DSH test host.
 *
 *   node scripts/bootstrap-testhost.mjs [--install]
 *
 * The host lives at `<tmp>/deepseek-harness-master` (gitignored).
 * This script is safe to re-run: it only fills in what is missing.
 *
 *   1. source tree  — extracted from `<tmp>/harness.tar.gz` when the
 *                     tree is absent;
 *   2. host-only files — `packages/test-support/mc-dsh-poc/src/*` and
 *                     `cordis.mc-poc.patch.yml`, which no upstream tarball and no
 *                     repository copy carries (restored from `mc-dsh-poc-local/`);
 *   3. spec mirror  — written by `sync-specs.mjs` from `packages/dsh-plugin/tests/`;
 *   4. dependencies — `pnpm install --frozen-lockfile --prefer-offline` (only
 *                     with `--install`, or automatically when node_modules is absent).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { LOCAL_HOST_FILES, PKG, PROJECT_HOST, SCRIPTS, SUITE_DIR } from './test-host.mjs'

const isWindows = process.platform === 'win32'
const run = (label, command, args, cwd) => {
  console.log(`\n=== ${label} ===`)
  const code = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows }).status ?? 1
  if (code !== 0) {
    console.error(`bootstrap-testhost: ${label} failed (exit ${code})`)
    process.exit(code)
  }
}

const archive = join(PROJECT_HOST, '..', 'harness.tar.gz')

if (!existsSync(PROJECT_HOST)) {
  if (!existsSync(archive)) {
    console.error(`bootstrap-testhost: no host at ${PROJECT_HOST} and no ${archive}`)
    console.error('  obtain the DSH source archive (or a checkout) and place it there, then re-run')
    process.exit(2)
  }
  mkdirSync(join(PROJECT_HOST, '..'), { recursive: true })
  run('extract harness.tar.gz', 'tar', ['-xzf', archive, '-C', join(PROJECT_HOST, '..')])
  console.log('  note: tar reports a handful of case-collision errors on docs/snapshots; they do not affect packages/')
}

const suite = join(PROJECT_HOST, SUITE_DIR)
if (!existsSync(LOCAL_HOST_FILES)) {
  console.error(`bootstrap-testhost: missing host-only files at ${LOCAL_HOST_FILES}`)
  process.exit(2)
}
mkdirSync(join(suite, 'src'), { recursive: true })
cpSync(join(LOCAL_HOST_FILES, 'src'), join(suite, 'src'), { recursive: true, force: true })
cpSync(join(LOCAL_HOST_FILES, 'cordis.mc-poc.patch.yml'), join(suite, 'cordis.mc-poc.patch.yml'), { force: true })
console.log(`\nrestored host-only files into ${join(suite, 'src')}`)

run('sync-specs', process.execPath, [join(SCRIPTS, 'sync-specs.mjs')], PKG)

const needInstall = process.argv.includes('--install') || !existsSync(join(PROJECT_HOST, 'node_modules', '.bin'))
if (needInstall) {
  run(
    'pnpm install',
    isWindows ? 'pnpm.cmd' : 'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline'],
    PROJECT_HOST,
  )
} else {
  console.log('\nnode_modules present; re-run with --install to force a reinstall')
}

const specCount = readdirSync(join(suite, 'tests')).filter((name) => name.endsWith('.spec.ts')).length
console.log(`\nbootstrap-testhost: ready — ${specCount} specs in ${suite}`)
console.log(`  next: node ${join(SCRIPTS, 'mc-test.mjs')} --quick`)
