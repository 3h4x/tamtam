import { defineConfig } from 'vitest/config';
import path from 'path';

const isCi = process.env.CI === 'true';
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const isNode25OrNewer = Number.isFinite(nodeMajor) && nodeMajor >= 25;

function projectMaxWorkers(localDefault: number): number {
  if (isCi) return 4;

  // PGlite boots PostgreSQL inside WASM. On Node 25, restoring many snapshots
  // across forked Vitest workers can starve DB-backed beforeAll hooks long
  // enough to hit the 30s hook timeout even though each suite passes alone.
  if (isNode25OrNewer) return 4;

  return localDefault;
}

// The 29 test files below each take >=500ms wall-clock (DB boots, heavy mocks,
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
  '__tests__/lib/start-review.test.ts',
  '__tests__/lib/start-soak.test.ts',
  '__tests__/lib/workflows/release-orchestrator.test.ts',
  '__tests__/lib/agents/retrieval/pgvector-backend.test.ts',
];

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
          exclude: SLOW_FILES,
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
          include: SLOW_FILES,
          environment: 'node',
          globalSetup: ['./__tests__/global-setup.ts'],
          setupFiles: ['./__tests__/setup-db-guard.ts'],
          pool: 'forks',
          maxWorkers: projectMaxWorkers(8),
          sequence: { groupOrder: 1 },
        },
      },
    ],
    silent: 'passed-only',
    testTimeout: 30000,
    hookTimeout: isNode25OrNewer ? 60000 : 30000,
    teardownTimeout: 10000,
  },
});
