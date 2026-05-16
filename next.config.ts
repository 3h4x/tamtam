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
};

export default withWorkflow(nextConfig);
