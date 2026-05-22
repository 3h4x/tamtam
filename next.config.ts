import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

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
  serverExternalPackages: ['pg', 'graphile-worker'],
  // Turbopack's persistent filesystem cache is opt-in for `next build`
  // (Next 16 defaults it on only for dev). Enables incremental rebuilds
  // — full first build still pays the ~115s compile, but a follow-up
  // build that only changes a handful of files reuses the prior compile
  // and finishes in ~10-20s.
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
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
    ],
  },
};

export default withWorkflow(nextConfig);
