// Iteration caps for the workflow-driven release pipeline.
//
// Fixes are unbounded — every NEEDS ATTENTION review or failed test/commit/
// push triggers a fix. The cap lives on the *verification* side: a stuck
// fix loop is detected by counting how many test/review/commit/push rounds
// have run in this release, not by counting fixes. This way the trailing
// fix always lands (the user gets the model's last attempt at a solution),
// but the next verification step is skipped and the release fails with a
// clear stop reason.
//
// Two caps are tracked:
//   review / test / commit / push (step verification loops)
//     → `fix_max_iterations` setting via getFixIterationCap() (default 0,
//       falling back to 3 before settings load; `0` ⇒ unlimited until LGTM or release wall-clock
//       timeout). One number governs every step. See
//       `lib/pipeline/recovery-budget.ts`.
//   push-hook rejection retries
//     → MAX_PUSH_FIX_ATTEMPTS (hardcoded 2; checked when fix→push is
//       dispatched). Decoupled from `fix_max_iterations` so a
//       permanently rejecting pre-push hook can't loop forever when the
//       setting is 0.
//
// Lifted out of `lib/jobs/lifecycle.ts` (`recentStepCount` + the per-block
// cap branches at ~line 740 onward). The legacy hook keeps its copies for
// standalone (no-releaseId) chains.

import type { JobData } from '@/lib/jobs/types';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';

export interface IterationCapDeps {
  /** Walk the project's job cache. Same contract as `listJobs` from
   *  `lib/jobs/job-storage`. */
  listJobs: () => JobData[];
  /** getFixIterationCap() from `lib/pipeline/recovery-budget`. Applies
   *  uniformly to review/test/commit/push step verification loops. */
  fixIterationCap: () => number;
  /** getPushFixAttemptCap() from `lib/pipeline/recovery-budget`. */
  pushFixAttemptCap: () => number;
}

/** Count completed jobs of `kind` that belong to the same release as
 *  `currentJob`. Inside a release, only count siblings; outside (no
 *  releaseId), the legacy 30-min window applies — but the orchestrator
 *  only ever calls these guards for release-linked jobs, so the windowed
 *  fallback isn't reachable here. */
export function countSiblingSteps(
  projectName: string,
  kind: string,
  releaseId: string,
  deps: IterationCapDeps,
): number {
  return deps
    .listJobs()
    .filter(
      (j) =>
        j.project === projectName &&
        j.kind === kind &&
        j.releaseId === releaseId &&
        j.finishedAt !== null,
    )
    .length;
}

/** Count how many `fix` jobs in the same release have a parent that is a
 *  `push` job — i.e. the fix-from-push retry budget. Mirrors
 *  `recentFixFromPushCount` in lifecycle.ts but scoped per-release rather
 *  than per-window. */
export function countFixFromPushSiblings(
  projectName: string,
  releaseId: string,
  deps: IterationCapDeps,
): number {
  const jobs = deps.listJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return jobs.filter((j) => {
    if (
      j.project !== projectName ||
      j.kind !== 'fix' ||
      j.releaseId !== releaseId ||
      j.finishedAt === null
    ) {
      return false;
    }
    if (!j.parentJobId) return false;
    const parent = byId.get(j.parentJobId);
    return parent?.kind === 'push';
  }).length;
}

export interface CapCheckResult {
  /** When a cap is hit, the rewritten decision (always `{ next: 'abort' }`).
   *  When no cap is hit, undefined — caller passes the original decision
   *  through unchanged. */
  rewritten?: NextPhase;
}

/** Check whether the next dispatch would exceed an iteration cap. Returns
 *  a rewritten `{ next: 'abort' }` decision with a stop reason when the
 *  cap is hit, or undefined to let the original decision proceed. */
export function checkIterationCap(
  job: JobData,
  decision: NextPhase,
  deps: IterationCapDeps,
): CapCheckResult {
  // Caps only apply inside a release. Standalone re-runs (no releaseId)
  // are handled by the legacy hook's 30-min window logic.
  if (!job.releaseId) return {};

  // The "from: 'fix'" decisions are the verification re-runs the cap is
  // designed to bound. Other transitions don't compound: test→review fires
  // once per cascade and review→push fires once per LGTM.
  if (decision.next === 'review' && decision.from === 'fix') {
    const count = countSiblingSteps(job.project, 'review', job.releaseId, deps);
    const cap = deps.fixIterationCap();
    // cap === 0 → unlimited iterations (opt-in cap). The fix loop keeps
    // running until the reviewer returns LGTM or the wall-clock timeout
    // aborts the release.
    if (cap > 0 && count >= cap) {
      return {
        rewritten: {
          next: 'abort',
          from: 'review',
          verdict: 'NEEDS ATTENTION',
          stopReason: `review cap reached for ${job.project} (${count}/${cap}) — review keeps surfacing new findings, stopping`,
        },
      };
    }
  }

  if (decision.next === 'test' && decision.from === 'fix') {
    // A review-driven fix re-runs the host-side test phase before re-review
    // (review → fix → test → review). Such a fix carries `parentKind: 'review'`,
    // so it must be bounded by the REVIEW loop cap and counted as review cycles
    // — not lumped into the test-failure loop. Detect by the fix's parent kind,
    // mirroring the push branch below. Plain test-failure fixes (parent test)
    // keep the test-loop cap.
    const fixParent = job.parentJobId
      ? deps.listJobs().find((j) => j.id === job.parentJobId) ?? null
      : null;
    const isReviewDriven = fixParent?.kind === 'review';
    const loopKind = isReviewDriven ? 'review' : 'test';
    const count = countSiblingSteps(job.project, loopKind, job.releaseId, deps);
    const cap = deps.fixIterationCap();
    if (cap > 0 && count >= cap) {
      return {
        rewritten: {
          next: 'abort',
          from: 'review',
          verdict: 'NEEDS ATTENTION',
          stopReason: isReviewDriven
            ? `review cap reached for ${job.project} (${count}/${cap}) — review keeps surfacing new findings, stopping`
            : `test cap reached for ${job.project} (${count}/${cap}) — tests still need verification`,
        },
      };
    }
  }

  if (decision.next === 'commit' && decision.from === 'fix') {
    const count = countSiblingSteps(job.project, 'commit', job.releaseId, deps);
    const cap = deps.fixIterationCap();
    if (cap > 0 && count >= cap) {
      return {
        rewritten: {
          next: 'abort',
          from: 'review',
          verdict: 'NEEDS ATTENTION',
          stopReason: `commit cap reached for ${job.project} (${count}/${cap}) — commit keeps failing, stopping`,
        },
      };
    }
  }

  if (decision.next === 'push' && decision.from === 'fix') {
    // After fix-from-push, the push retry uses the dedicated push-fix cap
    // (matches lifecycle.ts MAX_PUSH_FIX_ATTEMPTS); after fix-from-other,
    // the generic step cap applies. Detect by the fix's parent kind.
    const fixParent = job.parentJobId ? deps.listJobs().find((j) => j.id === job.parentJobId) ?? null : null;
    if (fixParent?.kind === 'push') {
      const count = countFixFromPushSiblings(job.project, job.releaseId, deps);
      const cap = deps.pushFixAttemptCap();
      if (count >= cap) {
        return {
          rewritten: {
            next: 'abort',
            from: 'review',
            verdict: 'NEEDS ATTENTION',
            stopReason: `push fix cap reached for ${job.project} (${count}/${cap}) — push hook failures still need recovery`,
          },
        };
      }
    } else {
      const count = countSiblingSteps(job.project, 'push', job.releaseId, deps);
      const cap = deps.fixIterationCap();
      if (cap > 0 && count >= cap) {
        return {
          rewritten: {
            next: 'abort',
            from: 'review',
            verdict: 'NEEDS ATTENTION',
            stopReason: `push cap reached for ${job.project} (${count}/${cap}) — pushes keep cycling, stopping`,
          },
        };
      }
    }
  }

  return {};
}
