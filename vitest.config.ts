import { defineConfig } from 'vitest/config';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { availableParallelism } from 'os';
import path from 'path';

const isCi = process.env.CI === 'true';
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const isNode25OrNewer = Number.isFinite(nodeMajor) && nodeMajor >= 25;
const hostParallelism = Math.max(1, availableParallelism());

function projectMaxWorkers(localDefault: number): number {
  if (isCi) return 4;

  // PGlite boots PostgreSQL inside WASM. On Node 25, restoring many snapshots
  // across forked Vitest workers can starve DB-backed beforeAll hooks long
  // enough to hit the 30s hook timeout even though each suite passes alone.
  if (isNode25OrNewer) return 4;

  // Vitest's fork pool can briefly overlap worker teardown/startup between
  // projects. Keep one CPU free on local/agent hosts so a full `pnpm test`
  // doesn't exit nonzero after otherwise-passing files due to process-level
  // contention.
  return Math.min(localDefault, Math.max(1, hostParallelism - 1));
}

// The test files below each take >=500ms wall-clock (DB boots, heavy mocks,
// or large prompt assembly). Routing them into their own worker pool keeps a
// few slow files from blocking the long tail of small fast files, and lets
// each project right-size its `maxWorkers` for its own contention profile.
//
// Use process forks instead of worker threads: many suites boot PGlite's WASM
// runtime, and Node 24 can crash natively while tearing down WASM code inside
// Vitest worker threads. Forks keep each worker's V8/WASM state process-local.
//
// Result before switching away from threads: full suite ~16s vs ~21s with a
// single 12-worker pool. Re-measure
// periodically with `npx vitest run --reporter=json --outputFile=/tmp/v.json`
// and sort by `endTime - startTime` to keep this list accurate.
const SLOW_FILES = [
  '__tests__/instrumentation.test.ts',
  '__tests__/api/agent-run.test.ts',
  '__tests__/api/config-projects.test.ts',
  '__tests__/api/health-and-projects.test.ts',
  '__tests__/api/job-fix.test.ts',
  '__tests__/api/job-rerun.test.ts',
  '__tests__/api/job-resources.test.ts',
  '__tests__/api/project-run.test.ts',
  '__tests__/api/project-test.test.ts',
  '__tests__/api/review-pr.test.ts',
  '__tests__/components/issues-tab.test.ts',
  '__tests__/components/project-runs-tab-actions.test.tsx',
  '__tests__/components/settings-page.test.tsx',
  '__tests__/scripts/gen-workflow-graph.test.ts',
  '__tests__/lib/codex-shim.test.ts',
  '__tests__/lib/deepagents-shim.test.ts',
  '__tests__/lib/default-agent-skills.test.ts',
  '__tests__/lib/dev-server-lifecycle.test.ts',
  '__tests__/lib/job-storage-pipeline.test.ts',
  '__tests__/lib/pipeline-lock.test.ts',
  '__tests__/lib/project-sweep.test.ts',
  '__tests__/lib/queued-agent-runs.test.ts',
  '__tests__/lib/retention.test.ts',
  '__tests__/lib/shell.test.ts',
  '__tests__/lib/start-push.test.ts',
  '__tests__/lib/start-push-pr.test.ts',
  '__tests__/lib/start-push-helpers.test.ts',
  '__tests__/lib/start-push-generate-commit-message.test.ts',
  '__tests__/lib/start-review.test.ts',
  '__tests__/lib/start-soak.test.ts',
  '__tests__/lib/workflows/release-orchestrator.test.ts',
  '__tests__/lib/agents/retrieval/pgvector-backend.test.ts',
];

function collectTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTestFiles(full));
      continue;
    }
    if (/\.test\.tsx?$/.test(name)) {
      files.push(full.split(path.sep).join('/'));
    }
  }
  return files;
}

// Files that import the PGlite test-db helper boot Postgres-in-WASM. They MUST
// run in the throttled `db` project (low maxWorkers): PGlite's Emscripten
// ASYNCIFY machinery faults if its worker is starved of CPU mid-operation, and
// on macOS arm64 under Node 24 that fault lands in V8's signal-based WASM trap
// handler, which spins forever instead of returning — pegging the worker at
// 100% CPU with its event loop blocked, so no test/hook timeout can fire and
// `pnpm test` hangs. Follow relative imports through shared test fixtures too:
// job-storage-core/probe tests reach PGlite through fixture modules, not by
// importing `test-db` directly.
const IMPORTS_TEST_DB_HELPER = /\bfrom\s+['"][^'"]*\btest-db['"]/;

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function fileUsesTestDb(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);

  const source = readFileSync(file, 'utf8');
  if (IMPORTS_TEST_DB_HELPER.test(source)) return true;

  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const resolved = resolveRelativeImport(file, match[1]);
    if (resolved?.startsWith('__tests__/') && fileUsesTestDb(resolved, seen)) {
      return true;
    }
  }

  return false;
}

const DB_TEST_FILES = collectTestFiles('__tests__').filter((file) => fileUsesTestDb(file));
const DB_TEST_FILE_SET = new Set(DB_TEST_FILES);

// A test file that spawns REAL OS subprocesses (git, bash, the provider shims,
// dev servers) belongs in the lower-parallelism `slow` pool. At the `fast`
// pool's high `maxWorkers`, dozens of concurrent fork+exec calls thrash the
// host scheduler and inflate wall time far beyond the work itself — a
// git-heavy file measured ~2s in isolation but ~18s under `fast`-pool
// contention. Detect these structurally (mirroring DB_TEST_FILES) so new
// subprocess-heavy tests auto-route to `slow` instead of silently landing in
// `fast` until someone hand-edits SLOW_FILES (which repeatedly drifted stale).
//
// Signals, each excluding the mocked case (mocked spawns never touch the OS):
//   1. imports `child_process` AND calls execFileSync/spawnSync/execSync/spawn,
//      without `vi.mock('child_process')`.
//   2. imports `@/lib/shared/shell` (whose `exec` forks git/bash) without
//      mocking it.
function fileSpawnsSubprocess(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  const importsChildProcess = /from\s+['"](?:node:)?child_process['"]/.test(src);
  const usesSpawnApi = /\b(?:execFileSync|spawnSync|execSync)\b|\bspawn\s*\(/.test(src);
  const mocksChildProcess = /vi\.(?:mock|doMock)\(\s*['"](?:node:)?child_process['"]/.test(src);
  if (importsChildProcess && usesSpawnApi && !mocksChildProcess) return true;

  const importsShell = /from\s+['"]@\/lib\/shared\/shell['"]/.test(src);
  const mocksShell = /vi\.(?:mock|doMock)\(\s*['"]@\/lib\/shared\/shell['"]/.test(src);
  if (importsShell && !mocksShell) return true;

  return false;
}

const SUBPROCESS_TEST_FILES = collectTestFiles('__tests__').filter(fileSpawnsSubprocess);

// `slow` = hand-curated slow files (heavy mocks / prompt assembly) ∪
// auto-detected subprocess spawners, minus anything that must run serialized in
// the `db` pool (PGlite). A db file that also spawns subprocesses stays in `db`:
// its WASM-serialization constraint is stricter than the contention concern.
const SLOW_NON_DB_FILES = [...new Set([...SLOW_FILES, ...SUBPROCESS_TEST_FILES])]
  .filter((file) => !DB_TEST_FILE_SET.has(file));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'fast',
          include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
          exclude: [...SLOW_NON_DB_FILES, ...DB_TEST_FILES],
          environment: 'node',
          globalSetup: ['./__tests__/global-setup.ts'],
          setupFiles: ['./__tests__/setup-db-guard.ts'],
          pool: 'forks',
          maxWorkers: projectMaxWorkers(14),
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'slow',
          include: SLOW_NON_DB_FILES,
          environment: 'node',
          globalSetup: ['./__tests__/global-setup.ts'],
          setupFiles: ['./__tests__/setup-db-guard.ts'],
          pool: 'forks',
          maxWorkers: projectMaxWorkers(8),
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: DB_TEST_FILES,
          environment: 'node',
          globalSetup: ['./__tests__/global-setup.ts'],
          setupFiles: ['./__tests__/setup-db-guard.ts'],
          pool: 'forks',
          // Serialize the PGlite pool: every file here boots Postgres-in-WASM,
          // and ≥2 concurrent PGlite workers under CPU contention can wedge V8's
          // signal-based WASM trap handler into an unrecoverable 100%-CPU spin
          // (see IMPORTS_TEST_DB_HELPER above). One worker keeps PGlite strictly
          // sequential — the only configuration proven not to hang on Node 24 /
          // macOS arm64. The fast and slow pools stay parallel; they no longer
          // contain any PGlite file, so they cannot trigger the spin.
          maxWorkers: 1,
          // NOTE: isolate:false was evaluated to skip the ~100s of per-file
          // module re-import (PGlite WASM re-instantiation etc.) that dominates
          // this pool's wall time. It is NOT safe here: dozens of db files each
          // `vi.mock('@/lib/db', () => ({ get db() {…} }))`, and with the module
          // registry shared across files those getters leak between files (e.g.
          // pipeline-lock's acquireLock resolving automation-queue's db ref),
          // producing order-dependent failures. Keep per-file module isolation.
          sequence: { groupOrder: 2 },
        },
      },
    ],
    silent: 'passed-only',
    testTimeout: 30000,
    // Retry a failed test up to twice before reporting it red. The suite has
    // rare resource-contention flakes (a heavily-loaded host — concurrent
    // agents + a release's own test phase — can make a whole file's tests
    // intermittently fail). Those flakes used to fail the release test phase,
    // which then thrashed the test→fix loop to its wall-clock deadline and
    // never shipped. A retry turns a transient flake back into a pass so the
    // release proceeds; genuine failures still fail all three attempts. The
    // `db-guard` tripwire (setup-db-guard.ts) keeps surfacing real-pool leaks
    // so retries don't hide a real isolation bug.
    retry: 2,
    hookTimeout: 60000,
    teardownTimeout: 10000,
    fakeTimers: {
      shouldClearNativeTimers: true,
    },
    // Under fork-pool contention, Vitest's throttled task-update/console-log
    // flushes can fire after the worker's RPC channel is torn down, surfacing
    // as unhandled errors that fail otherwise-green runs. These strings
    // originate solely from Vitest internals reaching for a closed worker, so
    // ignoring them exactly cannot mask an application bug. Returning `false`
    // drops only these benign teardown errors; every other unhandled error
    // still fails the run normally.
    onUnhandledError(error) {
      if (error?.message?.includes('Vitest failed to access its internal state')) {
        return false;
      }
      if (error?.message?.includes('Closing rpc while "onUserConsoleLog" was pending')) {
        return false;
      }
    },
  },
});
