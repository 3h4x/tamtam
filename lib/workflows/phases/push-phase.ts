// Fourth per-phase workflow scaffold: push. Different shape from
// test/review/fix because push runs **inline** in the server process (not
// spawned as a background job) — startProjectPush returns synchronously
// with the commit SHA and optional PR info. So the phase workflow needs
// just one step.
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'push' } from a review-LGTM or fresh-LGTM branch. Not wired
// yet.

import type { PushResult } from '@/lib/pipeline/start-push';

export type PushPhaseResult =
  | {
      ok: true;
      commitSha: string;
      message: string;
      prUrl?: string;
      prNumber?: number;
      prRepo?: string;
    }
  | {
      ok: false;
      reason: 'push_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releasePushPhaseWorkflow(
  projectName: string,
  options: { parentJobId?: string | null } = {},
): Promise<PushPhaseResult> {
  'use workflow';
  const r = await pushStep(projectName, options);
  if (!r.ok) {
    return {
      ok: false,
      reason: 'push_failed',
      status: r.status,
      detail: r.detail,
      ...(r.blockingJobId ? { blockingJobId: r.blockingJobId } : {}),
    };
  }
  return {
    ok: true,
    commitSha: r.commitSha,
    message: r.message,
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    ...(r.prNumber != null ? { prNumber: r.prNumber } : {}),
    ...(r.prRepo ? { prRepo: r.prRepo } : {}),
  };
}

async function pushStep(
  projectName: string,
  options: { parentJobId?: string | null },
): Promise<PushResult> {
  'use step';
  const { startProjectPush } = await import('@/lib/pipeline/start-push');
  return startProjectPush(projectName, options);
}
