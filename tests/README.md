# The DSH adapter's runnable suite

These 25 specs (plus the shared fixtures under `helpers/`) are the **canonical**
copy of the only executable test suite for `packages/dsh-plugin`. They are
committed here so the suite cannot be lost with a temporary directory.

## Why the canonical copy is not the one vitest runs

vitest executes them from the DSH checkout
(`<checkout>/packages/test-support/mc-dsh-poc/tests`), because this repository
has no `node_modules` and therefore cannot resolve the bare `vitest` specifier.
The specs address this repository's sources by absolute path
(`<path>`), and
`historian-terminal.spec.ts` imports the checkout's mock adapter relatively — a
path that only resolves where vitest runs. That is why the two copies are
byte-identical rather than rebased.

## Commands

```bash
node scripts/sync-specs.mjs            # repo -> checkout (writes)
node scripts/sync-specs.mjs --check    # verify equality; exit 1 on drift
```

`MC_DSH_CHECKOUT` overrides the checkout root (default:
`<path>`).

Run the suite itself from the checkout:

```powershell
Set-Location $env:MC_DSH_CHECKOUT   # or the default path above
.\node_modules\.bin\vitest.CMD run packages/test-support/mc-dsh-poc/tests --coverage.enabled=false
```

## Editing rules

1. Edit the file here (or in the checkout — both are the same bytes), then run
   `node scripts/sync-specs.mjs` so the two copies agree.
2. `node scripts/sync-specs.mjs --check` must pass before a change is
   considered done; it also fails on specs that exist only in the checkout.
3. A test double must enforce the shape of the interface it replaces. Fakes
   that accept anything, or that invent fields the real event does not have,
   are how two real defects stayed invisible here (`content` as a bare string
   instead of a block array; `user/message` events stubbed with a
   `data.message` wrapper that no live session produces). When a defect is
   found through a fake, fix the fake in the same change.
4. The Magic Context store DDL has a single source:
   `helpers/memory-db.ts`. Never inline a `CREATE TABLE memories` (or the
   mutation-log / authority / workspaces blocks) in a spec — eleven specs used
   to carry near-identical copies and three had already lost the `mural_cue`
   columns. The fixture's DDL is the contract-pinned shape validated
   byte-for-byte against a real v94 store; scenario-specific variants (e.g.
   memory-search's minimal FTS) stay local to the spec that needs them, on
   purpose.
