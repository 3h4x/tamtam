// Decision module: "a run/agent job just finished — should we trigger a
// release pipeline?". Extracted from the inline block in lib/jobs/lifecycle.ts
// so the orchestration choice lives outside the markDone hook chain and can
// be re-driven from a workflow trigger / replay path without duplicating
// the policy (releaseAfterRun gate, pending-release queue, issue-work PR handoff).
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

/** True when the finished agent job left some shippable change behind. We
 *  count from the metadata `finalizeAgentRunReport` already wrote to the
 *  job row — `modifiedFiles` is a JSON array and `linesAdded`/`linesRemoved`
 *  are the attributed LOC delta. No git re-read needed. Either signal is
 *  enough so binary edits and pure renames still count. Low-confidence files
 *  are dirty-baseline context only and must not fire an autonomous release. */
function agentProducedShippableChange(job: JobData): boolean {
  const lines = (job.linesAdded ?? 0) + (job.linesRemoved ?? 0);
  if (lines > 0) return true;
  if (!job.modifiedFiles) return false;
  try {
    const parsed = JSON.parse(job.modifiedFiles) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((file) => {
      if (!file || typeof file !== 'object') return true;
      return (file as { confidence?: unknown }).confidence !== 'low';
    });
  } catch {
    // Malformed JSON: be conservative and treat as "no change" so a bug in
    // the report extractor can't fire empty releases. The agent run row
    // is still preserved; only the release is skipped.
    return false;
  }
}

export interface DispatchReleaseAfterRunOutcome {
  dispatched: boolean;
  reason: string;
}

export async function dispatchReleaseAfterRun(job: JobData): Promise<DispatchReleaseAfterRunOutcome> {
  // Issue work is dispatched the same as regular runs. The release pipeline
  // detects the non-default branch via `decidePrContext` and opens (or
  // reuses) a PR instead of pushing direct to main — so there's no risk of
  // shipping half-done issue work to the default branch. Skipping the
  // dispatch (the historical behavior) left issue-cruncher branches with
  // local commits but no upstream and no PR, requiring manual intervention.
  // The release pipeline now owns the "create PR" step the skill defers to.

  const isRunOrAgent = getJobKind(job.kind) === 'run' || isAgentJobKind(job.kind);
  if (!isRunOrAgent) return { dispatched: false, reason: `kind ${job.kind} not eligible` };
  if (job.exitCode !== 0) return { dispatched: false, reason: `exit ${job.exitCode} ≠ 0` };

  // Don't fire a release when the agent produced no shippable change. The
  // legacy path triggered release-after-run on every successful agent run,
  // so an idle agent that found nothing this cycle still spun up a release
  // — test/review tokens burned, and the release aborted at the review
  // scope check with "No uncommitted changes or unpushed commits to
  // review". Issue-cruncher runs are exempted because they may produce a
  // committed branch with no working-tree delta but still need a release to
  // open/update the PR.
  const issueLinked = job.kind === 'agent:issue-cruncher' || (job.kind === 'run' && job.ghIssueNumber != null);
  if (isAgentJobKind(job.kind) && !issueLinked && !agentProducedShippableChange(job)) {
    return { dispatched: false, reason: 'agent produced no changed files or LOC' };
  }

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
