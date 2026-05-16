// Decision module: "a fix-ci job just succeeded — should we trigger a
// release pipeline?". Extracted from the inline block in
// lib/jobs/lifecycle.ts so the orchestration choice lives outside the
// markDone hook chain and can be re-driven from a workflow trigger / replay
// path without duplicating the dispatch + pending-release policy.
//
// Same shape as `release-after-run`: callers are the legacy completion
// hook (gated on `legacy_completion_hook_release_after_fix_ci_enabled`)
// and the durable job-completion router.

import type { JobData } from '@/lib/jobs/types';

export interface DispatchReleaseAfterFixCiOutcome {
  dispatched: boolean;
  reason: string;
}

export async function dispatchReleaseAfterFixCi(job: JobData): Promise<DispatchReleaseAfterFixCiOutcome> {
  if (job.kind !== 'fix-ci') return { dispatched: false, reason: `kind ${job.kind} not eligible` };
  if (job.exitCode !== 0) return { dispatched: false, reason: `exit ${job.exitCode} ≠ 0` };

  const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
  const r = await dispatchReleaseWorkflow(job.project, { queueIfBlocked: true, sourceJobId: job.id });
  if (r.ok) {
    if ('status' in r && r.status === 'queued') {
      console.log(`[release-after-fix-ci] queued release for ${job.project} after fix-ci ${job.id}`);
      return { dispatched: false, reason: 'queued (lock held)' };
    }
    console.log(`[release-after-fix-ci] triggered release ${r.jobId} for ${job.project} after fix-ci ${job.id}`);
    return { dispatched: true, reason: `release ${r.jobId}` };
  }
  const { shouldKeepPendingRelease, setPendingRelease } = await import('@/lib/pipeline/pending-release');
  if (shouldKeepPendingRelease(r)) {
    setPendingRelease(job.project);
    console.log(`[release-after-fix-ci] queued for ${job.project} (will drain when lock releases): ${r.detail}`);
    return { dispatched: false, reason: `pending: ${r.detail}` };
  }
  console.log(`[release-after-fix-ci] no release for ${job.project}: ${r.detail}`);
  return { dispatched: false, reason: r.detail };
}
