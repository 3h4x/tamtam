// Pure helper for "given the just-finished sub-step job, find the next
// sub-step in the same release that the completion-hook chain spawned."
//
// Extracted from releaseObservationWorkflow's dispatchNextObservationStep
// so the matching rules can be tested deterministically (no polling loop,
// no clock dependency) and so completion-hook code can call the same
// function if/when we want consistency checks.
//
// Sibling = same releaseId (or the prev job IS the release meta-job, in
// which case the sibling has releaseId === prev.id), and started at or
// after prev.finishedAt with a small clock-skew slack window.

import type { JobData } from '@/lib/jobs/types';

export interface FindNextSubStepOptions {
  /** Slack window for clock skew in seconds. A sibling whose startedAt is
   *  ≥ prevFinishedAt − slack qualifies. Default 1s. */
  clockSkewSlackSec?: number;
}

export function findNextSubStepJob(
  jobs: JobData[],
  prev: JobData,
  options: FindNextSubStepOptions = {},
): JobData | null {
  if (prev.finishedAt == null) return null;
  const releaseId = prev.releaseId ?? prev.id;
  const slack = options.clockSkewSlackSec ?? 1;
  const cutoff = prev.finishedAt - slack;

  const candidates = jobs.filter((j) => {
    if (j.id === prev.id) return false;
    if (typeof j.startedAt !== 'number' || !Number.isFinite(j.startedAt)) return false;
    if (j.startedAt < cutoff) return false;
    const candidateReleaseId = j.releaseId ?? null;
    // Match if the candidate's releaseId equals the prev's release, OR if
    // the candidate's id equals the release (rare — the meta-job itself
    // isn't normally a "next step", but handle the edge).
    return candidateReleaseId === releaseId || j.id === releaseId;
  });

  if (candidates.length === 0) return null;
  // Most recently started wins — pipeline steps spawn one at a time, so
  // this resolves to the freshest follow-on.
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  return candidates[0];
}
