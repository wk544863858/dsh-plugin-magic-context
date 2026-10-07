/**
 * Copy the hand-written browser half into the build output.
 *
 * The client bundle needs no compilation: the official client build preset
 * (`@deepseek-ai/dsh-client-tsdown`) is not published, and our half is plain JS
 * wrapped in the module-loader shell the harness serves. Keeping it as a copy
 * (rather than teaching tsc about it) means `src/client/index.js` is exactly
 * what the browser executes, so a served file and the source can be compared
 * byte-for-byte.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const source = join(packageRoot, 'src', 'client', 'index.js')
const target = join(packageRoot, 'lib', 'client.js')

if (!existsSync(source)) {
  // The UI half is optional: without it the plugin still works, it just has no
  // settings card and no telemetry badge.
  console.log('copy-client: no src/client/index.js yet, skipping')
  process.exit(0)
}
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`copy-client: ${source} -> ${target}`)
