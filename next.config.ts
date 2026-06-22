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
// Default the data dir while still preserving explicit overrides (pipeline
// e2e, operators, CI). PM2 can cache env across restarts, so also displace
// the old volatile workflow default when it appears in a saved snapshot.
if (!process.env.WORKFLOW_TARGET_WORLD) {
  process.env.WORKFLOW_TARGET_WORLD = 'local';
}
if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
  const localDataDir = process.env.WORKFLOW_LOCAL_DATA_DIR;
  if (!localDataDir || localDataDir === '.next/workflow-data') {
    process.env.WORKFLOW_LOCAL_DATA_DIR = 'data/workflow-data';
  }
}

const nextConfig: NextConfig = {
  // Isolated build output dir for experimental builds (e.g. a webpack-vs-
  // turbopack A/B) so they never clobber the live `.next` the running server
  // serves from. Set via TAMTAM_DIST_DIR; unset ⇒ Next's standard `.next`.
  ...(process.env.TAMTAM_DIST_DIR ? { distDir: process.env.TAMTAM_DIST_DIR } : {}),
  // `pg` and `graphile-worker` rely on native bindings / dynamic
  // require, so they have to stay external. Tried extending this list
  // to workflow/drizzle/cbor/etc. makes `check-page` and
  // `is-page-static` ~5× slower (sub-second → 4-5s per route) for a
  // net-slower build. Turbopack already tree-shakes these packages well
  // enough that bundling them is cheaper than the external indirection.
  serverExternalPackages: ['pg', 'graphile-worker'],
  // Pin the NFT root to this project so the tracer never walks above the
  // repo. Without this, Next probes upward for the nearest workspace root
  // and can begin tracing into a sibling project under `~/workspace/`,
  // which is both wrong and slow.
  outputFileTracingRoot: PROJECT_ROOT,
  // Force-enable the build worker + parallel server/edge compile. Next
  // auto-disables both when `nextConfig.webpack` is set, and
  // `withWorkflow()` sets a webpack hook for the workflow loader (even
  // though Turbopack handles the actual bundling). Build trace flagged
  // `use-build-worker=false`; forcing it on lets server + edge bundles
  // compile in parallel instead of serial.
  experimental: {
    webpackBuildWorker: true,
    parallelServerCompiles: true,
    parallelServerBuildTraces: true,
  },
  // Turbopack's persistent filesystem cache for `next build` is OFF by
  // default. We tried enabling `experimental.turbopackFileSystemCacheForBuild`
  // hoping for fast warm rebuilds, but in practice the cache accumulated
  // to 2.4 GB without ever delivering sub-20s incremental builds — most
  // rebuilds still re-compiled from scratch (150-200s) AND paid the
  // additional cache read/write overhead. Disk pressure also caused the
  // build worker to thrash on macOS. Leave the experimental flag off
  // until Turbopack's build cache stabilizes; a clean build that fits the
  // available CPU is faster than a "warm" build that also fills the disk.
  // NOTE: observed clean-build wall time is dominated by host CPU
  // contention, not config — `run-turbopack` ranges ~280s at 88% core
  // saturation to ~890s once the 1-min load average exceeds the core
  // count (live server + scheduled agents + overlapping builds). Don't
  // re-tune compile flags off a single slow number; check the per-build
  // `load` block in data/build-metrics.jsonl (captured by
  // scripts/build-with-metrics.mjs) first, and prefer `pnpm rebuild`
  // (which pauses jobs) over a raw `pnpm build` on a busy box.
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
      // Per-route NFTs pulled the entire skills/docs/ markdown
      // library (~80 files), docs/, public/favicons, scripts/, and
      // stray .disabled siblings — none of which the route loads at
      // runtime. Excluding them at NFT-time is the catch-all when
      // Turbopack's static analysis can't follow the dynamic readdir
      // calls even with /*turbopackIgnore: true*/ annotations.
      // Net effect on the heaviest route: 1022 → 848 traced files.
      '**/app/**/*.ts.disabled',
      '**/app/**/*.tsx.disabled',
      '**/skills/**',
      '**/docs/**',
      '**/public/**',
      '**/scripts/**',
    ],
  },
};

export default withWorkflow(nextConfig);
