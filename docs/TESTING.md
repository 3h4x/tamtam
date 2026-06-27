# Testing

## Where tests live

- `__tests__/api/<route-name>.test.ts` mirrors `app/api/<route-name>/route.ts`.
- `__tests__/lib/` (or alongside the file) for lib logic.
- `e2e/` for Playwright UI tests; `e2e/pipeline/` for full pipeline chains where completion hooks must be exercised.

## What must be tested

- New API route handlers — happy path + error.
- New lib functions with branching logic or state mutations.
- Skip trivial passthroughs.

## Rules

- **Do not mock the database.** Use the PGlite helper at `__tests__/helpers/test-db.ts`:
  - `createTestPgDb()` — full production schema.
  - `createTestPgDbEmpty()` — raw per-test DDL (preferred for unit/API tests; build only the tables the test needs).
  Dispose via `await handle[Symbol.asyncDispose]()` in `afterEach`. Never import `@/lib/db` before mocks are installed.
- Mock only external side-effects: `lib/shared/shell.ts` `exec`, PM2, CLI spawning.
- **Don't rebuild identical subprocess fixtures per test.** When several cases share a base git repo (or similar process-built fixture), build it once in `beforeAll` and give each test an isolated copy via in-process `fs.cpSync` instead of re-running `git init/add/commit` (5 spawns) in `beforeEach` — see `__tests__/lib/incremental-review.test.ts`. Real `fork+exec` is the dominant cost in these files (~halved `worktree-line-delta.test.ts`). Files that shell out for real auto-route to the `slow` pool (see below) — you don't need to add them to `SLOW_FILES`.
- Use the package scripts, not raw Vitest (`pnpm test`, not `vitest`) — global setup at `__tests__/global-setup.ts` installs the test `DATABASE_URL` guard.
- Vitest retries failed tests up to two times (`retry: 2`) to absorb rare host contention flakes; fix any failure that remains red after those retries.
- **Match the nearby test style.** This repo mixes one-route-per-file tests with broader coverage files. Extend the nearest existing test when it already owns that behavior; don't introduce a shared test utility layer just to avoid duplication.
- For route handlers/server modules that read settings or other module-level singletons at import time: `vi.resetModules()`, register mocks with `vi.doMock()`, then `await import(...)` the subject inside `beforeEach`. Don't statically import first.
- For client-component tests: `jsdom`, stub `next/navigation` and `fetch` at module scope, use `vi.hoisted()` when a mock factory needs stable shared references.

## How `pnpm test` runs

`pnpm test` → `scripts/run-vitest-shards.mjs`, which runs the three Vitest
projects (`vitest.config.ts`): `fast`, `slow`, and `db`.

- `fast` and `slow` each run as **one `vitest` invocation** (parallelism comes
  from each project's own `maxWorkers`, not external sharding — sharding them only
  multiplied the per-process cold-start tax).
- `db` (every file that boots PGlite) uses **load-adaptive process concurrency**
  (`defaultDbConcurrency`): it fans out across processes only when the host has
  CPU headroom (`floor((cores − load1)/2)`, capped at `min(4, floor(cores/3))`),
  and falls back to a single sequential process under contention. This is the
  only configuration proven not to wedge V8's WASM trap handler on Node 24 /
  macOS arm64 when PGlite workers are CPU-starved (see `vitest.config.ts` and the
  `db` project's `maxWorkers: 1`).
- Result on a 12-core host: ~210s → ~87s idle / ~165s under load, all green.
- Knobs: `TAMTAM_VITEST_DB_CONCURRENCY` pins the db concurrency (`1` forces the
  proven-safe sequential path); `TAMTAM_VITEST_DB_SHARDS` controls the file split.
  An explicit argv (`pnpm test <file>`) bypasses the project plan for single-file
  runs.

### How a file is assigned to a project

Membership is computed in `vitest.config.ts` — mostly **structurally**, so new
tests land in the right pool without hand-editing lists:

- **`db`** — any file that (transitively) imports the PGlite `test-db` helper
  (`fileUsesTestDb` follows relative imports through shared fixtures). These
  **must** run in the serialized/low-concurrency `db` pool; PGlite's WASM trap
  handler wedges under CPU starvation otherwise.
- **`slow`** — the union of two sets, minus anything already in `db`:
  1. `SLOW_FILES`, a hand-curated list of files that are slow for reasons a
     static scan can't see (heavy module mocks, large prompt assembly). Re-measure
     periodically with `npx vitest run --reporter=json --outputFile=/tmp/v.json`
     and sort by `endTime − startTime`.
  2. **Auto-detected subprocess spawners** (`fileSpawnsSubprocess`): files that
     really fork OS processes — they import `child_process` and call
     `execFileSync`/`spawnSync`/`execSync`/`spawn`, **or** import
     `@/lib/shared/shell` (whose `exec` forks git/bash) — and do **not** mock
     that module. At the `fast` pool's high `maxWorkers`, dozens of concurrent
     `fork+exec` calls thrash the host scheduler and inflate wall time far beyond
     the work itself (a git-heavy file measured ~2s isolated but ~18s under
     `fast`-pool contention). Routing them to the lower-parallelism `slow` pool
     removes that thrash. **A test that shells out for real does not need a
     `SLOW_FILES` entry — it routes automatically.** A test that *mocks* its
     subprocess calls stays in `fast` (no real spawn).
- **`fast`** — everything not in `slow` or `db`.

A single failing test still fails the whole suite; the flaky-test detection in
the **release pipeline** (`lib/pipeline/flaky-tests.ts`) is separate — it retries
a specific failing test during a release's test phase and only treats a
fail-then-pass as flaky (operator-quarantined tests are skipped for gating).

## Pipeline e2e

- `pnpm test:e2e:pipeline` uses port 1338, temp DB at `/tmp/tamtam-e2e-pipeline/`, intercepts `git`/`gh` via shims in `e2e/pipeline/mocks/bin/`. Sequential workers.
- Never run pipeline e2e against the production server or DB.
- Write a pipeline e2e when you need to verify cross-step hook chaining or probe-sweep-driven follow-ons.

## Pre-push hook

`.husky/pre-push` runs `pnpm lint && pnpm type-check && pnpm test`. If it fails, fix the root cause — do not bypass with `--no-verify`.

## Synthetic PIDs

In tests, always use a high synthetic PID like `99999` for `createJob` — never a real or low PID. `lib/jobs/lifecycle.ts` enforces `pid > SAFE_PID_FLOOR` (100) before any SIGKILL because PID 1 on macOS is `launchd` (Finder, Dock, every user GUI app are its children).
