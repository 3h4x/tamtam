// Decision module: "a run/agent job just finished — should we trigger a
// release pipeline?". The orchestration choice lives outside the markDone
// hook chain so it can be re-driven from a workflow trigger / replay path
// without duplicating the policy (releaseAfterRun gate, pending-release
// queue, issue-work PR handoff). The completion hook, durable workflow
// trigger, and job_completion_events replay all yield the same behavior.

import type { JobData } from '@/lib/jobs/types';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import { logWorkflowTrigger } from '@/lib/workflows/triggers/logging';

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

/** Reinforce-or-release decision for the auto-release path. Returns a terminal
 *  outcome when it handled the run (reinforced), or null to mean "proceed with
 *  the normal release dispatch below". Only consulted for non-issue agent jobs
 *  when release_min_lines > 0. */
async function reinforceOrReleaseDecision(
  job: JobData,
): Promise<DispatchReleaseAfterRunOutcome | null> {
  const { getSettings } = await import('@/lib/shared/config');
  const { release_min_lines, release_reinforce_max_iterations } = getSettings();
  if (release_min_lines <= 0) return null; // gate disabled -> normal release

  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const projPath = resolveProjectPath(job.project);
  if (!projPath) return null; // can't measure -> don't block release

  const { decidePrContext } = await import('@/lib/pipeline/pr-context');
  const prDecision = await decidePrContext(projPath);
  if (prDecision.shouldOpenPr) {
    return null; // non-default branches need the release pipeline to open/reuse a PR
  }

  const { worktreeLineDelta } = await import('@/lib/git/worktree-line-delta');
  const loc = await worktreeLineDelta(projPath);

  const {
    getReinforceState,
    bumpReinforceState,
    clearReinforceState,
    redispatchAgentForReinforce,
    buildReinforcePrompt,
    getJobAgentId,
  } = await import('@/lib/workflows/triggers/reinforce-state');

  if (loc >= release_min_lines) {
    clearReinforceState(job.project);
    return null; // threshold met -> normal release
  }

  const agentId = await getJobAgentId(job.id);
  if (!agentId) return null; // no agent to re-run -> release whatever exists

  const state = getReinforceState(job.project);
  const madeProgress = loc > state.lastSeenLoc;
  const underCap =
    release_reinforce_max_iterations === 0 ||
    state.iterations < release_reinforce_max_iterations;

  if (madeProgress && underCap) {
    bumpReinforceState(job.project, loc);
    const accepted = await redispatchAgentForReinforce(agentId, job.project, buildReinforcePrompt(loc));
    if (accepted) {
      return {
        dispatched: false,
        reason: `reinforcing (loc ${loc} < ${release_min_lines}, iter ${state.iterations + 1})`,
      };
    }
    // Re-dispatch not accepted (queued/failed) -> fall through to release.
    clearReinforceState(job.project);
    return null;
  }

  // No progress or cap reached -> ship whatever exists.
  clearReinforceState(job.project);
  return null;
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

  // Reinforce-to-threshold: for working-tree-dirty agent runs (not issue/PR
  // work, not plain `run` jobs), keep re-running the agent until the
  // accumulated change is large enough to justify a release. Default-off via
  // release_min_lines=0.
  if (isAgentJobKind(job.kind) && !issueLinked) {
    const reinforced = await reinforceOrReleaseDecision(job);
    if (reinforced) return reinforced;
  }

  const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
  const r = await dispatchReleaseWorkflow(job.project, { queueIfBlocked: true, sourceJobId: job.id });
  if (r.ok) {
    if ('status' in r && r.status === 'queued') {
      logWorkflowTrigger(`[release-after-run] queued release for ${job.project} after run ${job.id}`);
      return { dispatched: false, reason: 'queued (lock held)' };
    }
    if (r.releaseJobId && isAgentJobKind(job.kind)) {
      try {
        const { linkRunningInitiativeToRelease } = await import('@/lib/orchestrator/initiatives-store');
        await linkRunningInitiativeToRelease(job.id, r.releaseJobId);
      } catch (err) {
        console.warn(`[release-after-run] failed to link initiative for ${job.id} → ${r.releaseJobId}:`, err);
      }
    }
    logWorkflowTrigger(`[release-after-run] triggered release ${r.jobId} for ${job.project} after run ${job.id}`);
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
    logWorkflowTrigger(`[release-after-run] queued for ${job.project} (will drain when pipeline lock releases): ${r.detail}`);
    return { dispatched: false, reason: `pending: ${r.detail}` };
  }
  logWorkflowTrigger(`[release-after-run] no release for ${job.project}: ${r.detail}`);
  return { dispatched: false, reason: r.detail };
}
