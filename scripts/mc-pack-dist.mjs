/**
 * Build the hand-out bundle: the packed tarball plus the installer next to it.
 *
 * `dsh plugin --profile <name> add <file>.tgz` records the tarball's ABSOLUTE
 * PATH in the profile manifest, so that file has to stay where the install found
 * it or every later plugin operation fails with ENOENT (measured 2026-10-13).
 * tools/install-magic-context.bat exists to move the recorded path into a stable
 * archive directory on the recipient's machine, which is why the two artifacts
 * are only useful together - this script always emits them as one directory.
 *
 * Every child process inherits stdio on purpose: capturing a child's output
 * through a pipe is not available in every host this runs in, and `npm pack`
 * says nothing worth parsing.
 *
 * Usage: npm run pack:dist [-- --no-build] [--out <dir>]
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const installer = join(root, 'tools', 'install-magic-context.bat')
const entry = join(root, 'lib', 'index.js')
const cache = join(root, '.tmp-pack-cache')

const argv = process.argv.slice(2)
const skipBuild = argv.includes('--no-build')
const outFlag = argv.indexOf('--out')
const outDir = resolve(root, outFlag === -1 ? 'dist' : argv[outFlag + 1] ?? '')

/** npm is a shell script on POSIX and a .cmd on Windows; the shell resolves either. */
const npmRun = (line) => execSync(`npm ${line}`, { cwd: root, stdio: 'inherit' })

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const fail = (message) => {
  console.error(`pack-dist: ${message}`)
  process.exit(1)
}

if (!existsSync(installer)) fail(`missing ${installer}`)
if (!skipBuild) {
  console.log('pack-dist: npm run build')
  npmRun('run build')
}
// `lib/` is gitignored, so a pack from an unbuilt checkout would ship an empty
// plugin; the entry point is the cheapest proof that a build produced it.
if (!existsSync(entry)) fail(`missing ${entry} - run without --no-build on a buildable tree`)

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expected = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`

mkdirSync(outDir, { recursive: true })
rmSync(cache, { recursive: true, force: true })
try {
  npmRun(`pack --pack-destination="${outDir}" --cache="${cache}"`)
} finally {
  rmSync(cache, { recursive: true, force: true })
}

const tarball = join(outDir, expected)
if (!existsSync(tarball)) {
  const found = readdirSync(outDir).filter((file) => file.endsWith('.tgz'))
  fail(`expected ${expected}, found ${found.length === 0 ? 'no tarball' : found.join(', ')}`)
}

copyFileSync(installer, join(outDir, 'install-magic-context.bat'))
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')

console.log(`
hand-out bundle: ${outDir}
  ${expected}
    ${mb(statSync(tarball).size)} packed
    sha256 ${sha256}
  install-magic-context.bat
    copies the tarball into %USERPROFILE%\\dsh-plugins and installs from that copy

Send both files together. The recipient quits DeepSeek Harness, double-clicks
install-magic-context.bat, then starts DeepSeek Harness again.`)
