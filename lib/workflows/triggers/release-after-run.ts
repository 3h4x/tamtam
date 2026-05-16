// Decision module: "a run/agent job just finished — should we trigger a
// release pipeline?". Extracted from the inline block in lib/jobs/lifecycle.ts
// so the orchestration choice lives outside the markDone hook chain and can
// be re-driven from a workflow trigger / replay path without duplicating
// the policy (issue-work skip, releaseAfterRun gate, pending-release queue).
//
// The current caller is still the completion hook; future iterations will
// also call this from a workflow that consumes durable
// job_completion_events rows. Either entry point yields the same behavior,
// which is the whole point of extracting it.

import type { JobData } from '@/lib/jobs/types';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';

async function getReleaseAfterRunFlag(projectName: string): Promise<boolean> {
  const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
  return !!(await getProjectTestConfig(projectName))?.releaseAfterRun;
}

export interface DispatchReleaseAfterRunOutcome {
  dispatched: boolean;
  reason: string;
}

export async function dispatchReleaseAfterRun(job: JobData): Promise<DispatchReleaseAfterRunOutcome> {
  // Issue-cruncher (and any chat run linked to a GitHub issue) deliberately
  // works on a feature branch. Auto-releasing that branch would either ship
  // half-done issue work straight to main or run the pipeline against the
  // wrong branch. Issue work ships via the PR path, not auto-release.
  const isIssueWork =
    job.kind === 'agent:issue-cruncher' ||
    (getJobKind(job.kind) === 'run' && job.ghIssueNumber != null) ||
    (isAgentJobKind(job.kind) && job.ghIssueNumber != null);
  if (isIssueWork) {
    return { dispatched: false, reason: `issue-work skip (issue #${job.ghIssueNumber ?? '?'})` };
  }

  const isRunOrAgent = getJobKind(job.kind) === 'run' || isAgentJobKind(job.kind);
  if (!isRunOrAgent) return { dispatched: false, reason: `kind ${job.kind} not eligible` };
  if (job.exitCode !== 0) return { dispatched: false, reason: `exit ${job.exitCode} ≠ 0` };

  const releaseAfterRun = await getReleaseAfterRunFlag(job.project);
  if (!releaseAfterRun) return { dispatched: false, reason: 'releaseAfterRun=false for project' };

  const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
  const r = await dispatchReleaseWorkflow(job.project, { queueIfBlocked: true, sourceJobId: job.id });
  if (r.ok) {
    if ('status' in r && r.status === 'queued') {
      console.log(`[release-after-run] queued release for ${job.project} after run ${job.id}`);
      return { dispatched: false, reason: 'queued (lock held)' };
    }
    console.log(`[release-after-run] triggered release ${r.jobId} for ${job.project} after run ${job.id}`);
    return { dispatched: true, reason: `release ${r.jobId}` };
  }

  // Only queue a pending-release flag for failures that actually need to
  // wait for something (lock conflict, jobs paused, budget block, explicit
  // retryable). Non-retryable failures like "Nothing to release" or
  // "project not found" must not stamp the flag — there is no future
  // event that will drain them, so the banner sticks.
  const { shouldKeepPendingRelease, setPendingRelease } = await import('@/lib/pipeline/pending-release');
  if (shouldKeepPendingRelease(r)) {
    setPendingRelease(job.project);
    console.log(`[release-after-run] queued for ${job.project} (will drain when pipeline lock releases): ${r.detail}`);
    return { dispatched: false, reason: `pending: ${r.detail}` };
  }
  console.log(`[release-after-run] no release for ${job.project}: ${r.detail}`);
  return { dispatched: false, reason: r.detail };
}
