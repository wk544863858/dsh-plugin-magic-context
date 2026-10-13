# The adapter's test suite

72 specs plus the shared fixtures under `helpers/`. They run in this repository,
against this repository's `src/`:

```bash
npm install
npm test               # vitest run
npm run gate           # --full: typecheck + suite + build + acceptance + audit + records
```

## How the suite is wired

The specs are ordinary vitest files. `vitest.config.ts` includes
`tests/**/*.spec.ts`, and each spec addresses the sources relatively
(`../src/...`) — nothing depends on where the repository sits on disk.

`@deepseek-ai/*` resolves from `node_modules`, pinned in `devDependencies` to the
release the adapter is written against. DSH publishes a coordinated dist-tag per
release (npm's `latest` on those packages is an *older* line), so the pins are
exact rather than ranged. `NOTICE` records the revision.

`tests/helpers/mock-adapter.ts` is vendored from the DSH test tree, so no DSH
checkout is needed. Nothing else in the suite reaches outside this repository.

## Editing rules

1. `npm test` must pass before a change is considered done; `npm run gate` adds
   the typecheck, the build and the acceptance checks.
2. A test double must enforce the shape of the interface it replaces. Fakes that
   accept anything, or that invent fields the real event does not have, are how
   two real defects stayed invisible here (`content` as a bare string instead of
   a block array; `user/message` events stubbed with a `data.message` wrapper
   that no live session produces). When a defect is found through a fake, fix
   the fake in the same change.
3. The Magic Context store DDL has a single source: `helpers/memory-db.ts`.
   Never inline a `CREATE TABLE memories` (or the mutation-log / authority /
   workspaces blocks) in a spec — eleven specs used to carry near-identical
   copies and three had already lost the `mural_cue` columns. The fixture's DDL
   is the contract-pinned shape validated byte-for-byte against a real v94
   store; scenario-specific variants (e.g. memory-search's minimal FTS) stay
   local to the spec that needs them, on purpose.
4. Specs that touch the live adapter database take a path or a fixture; none of
   them read `~/.local/share/cortexkit` on their own.

## History

The suite used to execute inside a DSH checkout, mirrored there by
`scripts/sync-specs.mjs` and addressed by absolute path, because these sources
had no `node_modules` of their own to resolve even the bare `vitest` specifier.
Extraction to a standalone package removed that reason: the suite now runs where
it lives, and the mirror, the host resolver and the bootstrap script are gone.
