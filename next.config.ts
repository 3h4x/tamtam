import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve this file's directory in an ESM-safe way so `outputFileTracingRoot`
// is anchored to the project root regardless of where `next build` is invoked
// from. Stricter than relying on Next's default (which walks up looking for
// the nearest package.json and can pick up the monorepo parent).
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

// Workflow runtime durability. `@workflow/next` defaults the local-world
// data dir to `.next/workflow-data` when WORKFLOW_TARGET_WORLD is unset,
// and `.next/` is wiped on every `pnpm rebuild`. That orphans in-flight
// workflow runs — the test phase finishes, calls back into the
// orchestrator, but the runs/steps/events rows have just been deleted,
// so the next phase never spawns and the release meta-job sits until
// probe marks it exit -1. Pin the data dir to `data/workflow-data/`
// (gitignored, never wiped by builds). Set before `withWorkflow()` so
// the package's `if (!env)` default doesn't shadow this.
// Always force the data dir (PM2 caches env across restarts, so a one-shot
// `if (!set)` guard wouldn't displace a stale `.next/workflow-data` value
// snapshotted on an earlier launch). WORKFLOW_TARGET_WORLD we only set
// when missing so an explicit override (Vercel, CI) still wins.
if (!process.env.WORKFLOW_TARGET_WORLD) {
  process.env.WORKFLOW_TARGET_WORLD = 'local';
}
if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
  process.env.WORKFLOW_LOCAL_DATA_DIR = 'data/workflow-data';
}

const nextConfig: NextConfig = {
  // Mark big server-only packages as external so Turbopack doesn't walk
  // and compile their sources for every route bundle. At runtime they're
  // resolved through standard `require` from node_modules (TamTam is
  // self-hosted, node_modules is present in the deploy). Without this,
  // a 148s Turbopack compile re-processes ~1 GB of dep source per build.
  serverExternalPackages: [
    'pg',
    'graphile-worker',
    'workflow',
    '@workflow/world-postgres',
    '@workflow/world-local',
    '@workflow/core',
    '@workflow/builders',
    '@workflow/errors',
    '@workflow/utils',
    'drizzle-orm',
    'cbor-x',
    'devalue',
    'yaml',
    'glob',
  ],
  // Pin the NFT root to this project so the tracer never walks above the
  // repo. Without this, Next probes upward for the nearest workspace root
  // and can begin tracing into a sibling project under `~/workspace/`,
  // which is both wrong and slow.
  outputFileTracingRoot: PROJECT_ROOT,
  // Turbopack's persistent filesystem cache for `next build` is OFF by
  // default. We tried enabling `experimental.turbopackFileSystemCacheForBuild`
  // hoping for fast warm rebuilds, but in practice the cache accumulated
  // to 2.4 GB without ever delivering sub-20s incremental builds — most
  // rebuilds still re-compiled from scratch (150-200s) AND paid the
  // additional cache read/write overhead. Disk pressure also caused the
  // build worker to thrash on macOS. Leave the experimental flag off
  // until Turbopack's build cache stabilizes; a 115s clean build is
  // faster than a 180s "warm" build that also fills the disk.
  // Type-checking is slow and we already run it via the dedicated
  // `pnpm type-check` command (and CI), so doing it again inside
  // `next build` doubles up. Skip during build; fix any real errors
  // via the dedicated command.
  typescript: { ignoreBuildErrors: true },
  // `data/` is a runtime artifact directory (logs, prompt artifacts,
  // workflow worker state, pg_dump backups). Without this exclude
  // Turbopack's NFT walks every file under `data/` for every route
  // that touches `getImproveConfig` / `logDir` / workflow imports,
  // producing ~20 MB NFT JSON per route × ~70 routes (1.4 GB total)
  // and a node worker that pegs 485% CPU + 471 GB virtual memory on
  // macOS. `**/*` is the route pattern (every server bundle).
  outputFileTracingExcludes: {
    '**/*': [
      // Runtime artifacts — never wanted in a deploy bundle.
      'data/**',
      '**/data/logs/**',
      '**/data/workflow-data/**',
      '**/data/attachments/**',
      '**/data/dev-servers/**',
      '**/data/*.db',
      '**/data/*.db-shm',
      '**/data/*.db-wal',
      '**/data/*.sql',
      '**/data/*.sql-shm',
      '**/data/*.sql-wal',
      // Project metadata that NFT pulls in once `outputFileTracingRoot`
      // pins to the repo. `.git/objects/` alone was 3,848 files per
      // route — pure dead weight. Same for test/e2e fixtures.
      '**/.git/**',
      '**/.tamtam/**',
      '**/e2e/**',
      '**/__tests__/**',
      // Source-only artifacts that the deploy bundle never needs.
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/coverage/**',
      '**/.next-test/**',
    ],
  },
};

export default withWorkflow(nextConfig);
