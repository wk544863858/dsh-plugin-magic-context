#!/usr/bin/env node
/**
 * Track the upstream project.
 *
 *   node scripts/dsh-track.mjs --check [--fetch] [--with-tests]
 *   node scripts/dsh-track.mjs --apply <tag>
 *
 * `dsh` carries the local adapter work; `dsh-base` marks the upstream commit it
 * was last replayed onto. The two refs exist because the local commits sit on an
 * upstream *master* that had already moved hundreds of commits past the newest
 * tag: replaying must target `--onto <new tag> dsh-base`, never `--onto <new
 * tag> <old tag>`.
 *
 * `--check` is read-only and offline unless `--fetch` is given. Exit codes:
 *   0  nothing to do
 *   1  the local delta left its allowed paths (see ALLOWED), or a test failed
 *   2  usage or precondition error
 *   3  a newer upstream release tag exists — run `--apply <tag>`
 *
 * `--apply` rewrites `dsh` onto the tag, moves `dsh-base`, runs the full gate and
 * prints the anchor-table values for `docs/dsh-plugin-upgrade-followup.md` §1.
 * It aborts and restores `dsh-base` if the replay conflicts.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PKG, REPO, SCRIPTS } from './test-host.mjs'

const LOCAL_BRANCH = 'dsh'
const BASE_REF = 'dsh-base'
/** Upstream release tags look like `v0.45.0`; dashboards and tooling have their own. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
/**
 * Paths the local delta may touch. Everything else in the repository belongs to
 * upstream, and a local commit that edits it is a merge conflict waiting to
 * happen on the next replay — which is what this assertion exists to catch.
 */
const ALLOWED = [
  { prefix: 'packages/dsh-plugin/' },
  { prefix: 'docs/dsh-' },
  { exact: '.gitignore' },
]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const positional = argv.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && argv[index - 1].startsWith('--')))

const apply = flag('--apply')
const check = flag('--check') || !apply

function fail(message, code = 2) {
  console.error(`dsh-track: ${message}`)
  process.exit(code)
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')}: ${stderr || stdout}`)
  return { ok: result.status === 0, out: stdout, err: stderr }
}

const allowedPath = (path) =>
  ALLOWED.some((rule) => (rule.exact !== undefined ? path === rule.exact : path.startsWith(rule.prefix)))

/** Release tags, newest first. */
function releaseTags() {
  return git(['tag', '--list', 'v*', '--sort=-creatordate'])
    .out.split('\n')
    .map((line) => line.trim())
    .filter((tag) => RELEASE_TAG.test(tag))
}

const count = (range) => Number(git(['rev-list', '--count', range], { allowFailure: true }).out || '0')

/** Newest release tag that is not already contained in `base`. */
function firstTagAfter(base) {
  for (const tag of releaseTags()) {
    if (count(`${base}..${tag}`) > 0) return tag
  }
  return undefined
}

function boundaryViolations(base, head) {
  return git(['diff', '--name-only', `${base}..${head}`])
    .out.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !allowedPath(line))
}

function describe(ref) {
  return git(['describe', '--tags', '--always', ref], { allowFailure: true }).out
}

function reportBoundary(base, head) {
  const violations = boundaryViolations(base, head)
  if (violations.length === 0) {
    const files = git(['diff', '--name-only', `${base}..${head}`]).out.split('\n').filter(Boolean)
    const groups = [...new Set(files.map((file) => (file.includes('/') ? `${file.split('/')[0]}/` : file)))].sort()
    console.log(`dsh-track: delta  = ${count(`${base}..${head}`)} commits, ${files.length} files, all inside the boundary (${groups.join(', ')})`)
    return true
  }
  console.error(`dsh-track: BOUNDARY VIOLATION — ${violations.length} path(s) outside the local delta:`)
  for (const path of violations) console.error(`  ! ${path}`)
  console.error('  allowed: packages/dsh-plugin/**, docs/dsh-*, .gitignore')
  console.error('  a local commit must not edit upstream-owned files; move the change or send it upstream')
  return false
}

function run(label, command, args, cwd) {
  console.log(`\n=== ${label} ===`)
  const code = spawnSync(command, args, { cwd, stdio: 'inherit' }).status ?? 1
  if (code !== 0) console.error(`dsh-track: ${label} failed (exit ${code})`)
  return code === 0
}

function readAnchorValues() {
  const read = (file) => {
    try {
      return readFileSync(join(PKG, file), 'utf8')
    } catch {
      return ''
    }
  }
  const schema = /MEMORY_SCHEMA_MAX_VERSION\s*=\s*(\d+)/.exec(read('src/core/memory-bridge.ts'))?.[1]
  const storeSchema = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(read('src/core/stores.ts'))?.[1]
  const adapter = /"version"\s*:\s*"([^"]+)"/.exec(read('package.json'))?.[1]
  return { schema, storeSchema, adapter }
}

function printAnchors(tag) {
  const { schema, storeSchema, adapter } = readAnchorValues()
  console.log('\n=== anchor updates for docs/dsh-plugin-upgrade-followup.md §1 ===')
  console.log(`  MC 版本      → ${tag}  (${describe(tag)})`)
  console.log(`  MC 存储契约  → schema v${schema ?? '?'}   (src/core/memory-bridge.ts)`)
  console.log(`  适配器自有库 → schema v${storeSchema ?? '?'}   (src/core/stores.ts); package version ${adapter ?? '?'}`)
  console.log('  DSH Desktop  → unchanged unless DSH moved (see §3)')
  console.log('  测试基线     → copy this run\'s counts from the mc-test summary above')
}

if (apply) {
  const tag = value('--apply') ?? positional[0]
  if (tag === undefined || tag.startsWith('--')) fail('--apply needs a tag: dsh-track.mjs --apply v0.46.0')
  if (!releaseTags().includes(tag)) fail(`not a known release tag: ${tag} (git fetch --tags origin first)`)

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  if (branch !== LOCAL_BRANCH) fail(`expected branch ${LOCAL_BRANCH}, found ${branch}: git switch ${LOCAL_BRANCH}`)
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).out
  if (dirty.length > 0) fail(`worktree has uncommitted changes:\n${dirty}`)

  const base = git(['rev-parse', BASE_REF], { allowFailure: true })
  if (!base.ok) fail(`${BASE_REF} is missing; it records the upstream commit the local work was replayed onto`)
  const baseOld = base.out
  const advance = count(`${BASE_REF}..${tag}`)
  if (advance === 0) fail(`${tag} is already contained in ${BASE_REF}; nothing to replay`)

  console.log(`dsh-track: applying ${tag} — ${advance} upstream commits onto ${BASE_REF} (${baseOld.slice(0, 9)})`)
  if (!reportBoundary(BASE_REF, LOCAL_BRANCH)) fail('boundary assertion failed; refusing to replay', 1)

  const before = git(['rev-parse', LOCAL_BRANCH]).out
  const replay = spawnSync('git', ['rebase', '--onto', tag, BASE_REF, LOCAL_BRANCH], { cwd: REPO, stdio: 'inherit' })
  if ((replay.status ?? 1) !== 0) {
    console.error('\ndsh-track: replay failed — aborting and restoring refs')
    spawnSync('git', ['rebase', '--abort'], { cwd: REPO, stdio: 'inherit' })
    git(['branch', '-f', BASE_REF, baseOld])
    console.error(`  ${LOCAL_BRANCH} back at ${before.slice(0, 9)}; ${BASE_REF} back at ${baseOld.slice(0, 9)}`)
    console.error('  conflicts are expected only in .gitignore — resolve by hand, then re-run --apply')
    process.exit(1)
  }
  git(['branch', '-f', BASE_REF, tag])
  console.log(`\ndsh-track: ${LOCAL_BRANCH} replayed onto ${tag}; ${BASE_REF} → ${tag}`)
  console.log('  the local commits were rewritten: a fork needs `git push --force-with-lease`')

  const gateOk = run('mc-test --full', process.execPath, [join(SCRIPTS, 'mc-test.mjs'), '--full'], PKG)
  printAnchors(tag)
  if (!gateOk) fail('gate failed after the replay; the branch is replayed but not verified', 1)
  console.log('\ndsh-track: done')
  process.exit(0)
}

// --check
if (check && flag('--fetch')) {
  console.log('dsh-track: fetching tags from origin …')
  const fetch = spawnSync('git', ['fetch', '--tags', 'origin'], { cwd: REPO, stdio: 'inherit' })
  if ((fetch.status ?? 1) !== 0) console.error('dsh-track: fetch failed; continuing with local tags')
}

const baseRef = value('--base') ?? BASE_REF
const headRef = value('--head') ?? LOCAL_BRANCH
if (!git(['rev-parse', '--verify', baseRef], { allowFailure: true }).ok) fail(`${baseRef} is missing (no local work tracked yet?)`)
if (!git(['rev-parse', '--verify', headRef], { allowFailure: true }).ok) fail(`${headRef} is missing`)

const tags = releaseTags()
const newest = tags[0]
const next = firstTagAfter(baseRef)

console.log(`dsh-track: base   = ${baseRef} (${git(['rev-parse', '--short', baseRef]).out})  ${describe(baseRef)}`)
console.log(`dsh-track: branch = ${headRef} (${count(`${baseRef}..${headRef}`)} local commits)`)
console.log(`dsh-track: tags   = ${tags.length} local release tags (newest ${newest ?? 'none'})`)
console.log(
  next === undefined
    ? `dsh-track: new    = none — ${baseRef} already contains ${newest ?? 'every known release'}`
    : `dsh-track: new    = ${next} (${(git(['log', '-1', '--format=%cs', next], { allowFailure: true }).out)}) — ${count(`${baseRef}..${next}`)} upstream commits to replay`,
)

const boundaryOk = reportBoundary(baseRef, headRef)

if (next !== undefined) {
  const aheadOfTag = git(['rev-list', '--count', `${next}..origin/master`], { allowFailure: true }).out
  if (Number(aheadOfTag || '0') > 0) {
    console.log(`dsh-track: note   = origin/master is ${aheadOfTag} commits past ${next} (fixes not in the tag; cherry-pick deliberately)`)
  }
}

if (flag('--with-tests')) {
  const ok = run('mc-test --quick', process.execPath, [join(SCRIPTS, 'mc-test.mjs'), '--quick'], PKG)
  if (!ok) process.exit(1)
}

if (!boundaryOk) process.exit(1)
process.exit(next === undefined ? 0 : 3)
