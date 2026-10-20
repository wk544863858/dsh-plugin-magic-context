import { defineConfig } from 'vitest/config'

/**
 * The suite runs in this repository, against this repository's `src/`.
 *
 * The specs used to execute from a DSH checkout, mirrored in by `sync-specs.mjs`
 * and addressed by absolute path, because a copy of the sources without
 * `node_modules` cannot resolve even the bare `vitest` specifier. Now that the
 * adapter is its own package, `npm install` gives the specs everything they
 * need — `vitest`, and the `@deepseek-ai/*` packages pinned to the release the
 * adapter is written against — so the suite is simply part of the repository.
 *
 * The `@deepseek-ai/*` versions in `devDependencies` are the *tested* baseline:
 * DSH publishes a coordinated dist-tag per release (`next` = `0.2.1-rc.1` at
 * the time of writing), which is what the pinned `0.2.1-rc.1` matches — the
 * same line the desktop host currently runs. Anything labelled `latest` on npm
 * is an older release line and is not what this adapter is written against.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // The specs drive real SQLite files on disk, and the historian specs wait
    // on their own short timeouts; give the slowest end-to-end spec headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
