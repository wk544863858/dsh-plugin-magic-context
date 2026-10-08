# The DSH adapter's runnable suite

These 28 specs (plus the shared fixtures under `helpers/`) are the **canonical**
copy of the only executable test suite for `packages/dsh-plugin`. They are
committed here so the suite cannot be lost with a temporary directory.

## Why the canonical copy is not the one vitest runs

vitest executes them from a **DSH test host**
(`<host>/packages/test-support/mc-dsh-poc/tests`), because this repository has no
`node_modules` and therefore cannot resolve the bare `vitest` specifier. The specs
address this repository's sources by absolute path
(`<path>`), and
`historian-terminal.spec.ts` imports the host's mock adapter relatively — a path
that only resolves where vitest runs. That is why the two copies are
byte-identical rather than rebased.

The host root is resolved by `scripts/lib/test-host.mjs`, first hit wins:

1. `MC_DSH_CHECKOUT` / `DSH_TESTHOST`;
2. `<repo>/<tmp>/deepseek-harness-master` — the project-local snapshot
   (gitignored through the repository's `.tmp-*/` rule);
3. `%TEMP%/dsh-src/deepseek-harness-master` — the legacy scratch checkout.

## Commands

```bash
node scripts/mc-test.mjs           # --quick: spec parity + the vitest suite
node scripts/mc-test.mjs --full    # + build, acceptance, memory audit, records
node scripts/bootstrap-testhost.mjs [--install]   # create/repair the local host
```

`npm test` and `npm run test:full` are aliases for the first two. The host must
have `node_modules` (vitest and the `@deepseek-ai/dsh-*` packages): a host without
it is reported, never guessed at.

Spec mirror only:

```bash
node scripts/sync-specs.mjs            # repo -> host (writes)
node scripts/sync-specs.mjs --check    # verify equality; exit 1 on drift
```

## What the project-local host is made of

`<tmp>/` holds four things, none of them committed:

| Path | Role |
|---|---|
| `deepseek-harness-master/` | the host source tree and its installed `node_modules` |
| `harness.tar.gz` | upstream source archive, used only to (re)create the tree |
| `mc-dsh-poc-local/` | `mc-dsh-poc/src/*` plus `cordis.mc-poc.patch.yml` — host-only files that no upstream archive and no repository copy carries (7 files, ~26 KB) |
| `pnpm-install.log` | transcript of the last dependency install |

`bootstrap-testhost.mjs` re-creates the host from those pieces: extract, restore
the host-only files, write the spec mirror, then `pnpm install
--frozen-lockfile --prefer-offline` against the local pnpm store.

## Editing rules

1. Edit the file here (or in the host — both are the same bytes), then run
   `node scripts/sync-specs.mjs` so the two copies agree.
2. `node scripts/mc-test.mjs --quick` must pass before a change is considered
   done; `--check` also fails on specs that exist only in the host.
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
