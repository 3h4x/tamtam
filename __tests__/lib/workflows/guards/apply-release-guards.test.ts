import { describe, it, expect } from 'vitest';
import { applyReleaseGuards } from '@/lib/workflows/guards/apply-release-guards';
import type { JobData } from '@/lib/jobs/types';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import type { ReviewDoNotShipAction } from '@/lib/shared/config';

function makeReview(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'rev-1',
    project: 'p',
    kind: 'review',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    releaseId: 'r1',
    ...overrides,
  } as JobData;
}

function deps(policy: ReviewDoNotShipAction, jobs: JobData[] = []) {
  return {
    listJobs: () => jobs,
    readParsedLog: () => '',
    fixIterationCap: () => 3,
    pushFixAttemptCap: () => 2,
    reviewDoNotShipAction: () => policy,
  };
}

describe('applyReleaseGuards — DO NOT SHIP policy', () => {
  const abortDecision: NextPhase = {
    next: 'abort',
    from: 'review',
    verdict: 'DO NOT SHIP',
    stopReason: 'review verdict: DO NOT SHIP — release blocked',
  };

  it('rewrites abort to commit + fileIssueForReviewId when policy=pass (default)', () => {
    const job = makeReview();
    const out = applyReleaseGuards({ job, decision: abortDecision, deps: deps('pass') });
    expect(out).toEqual({
      next: 'commit',
      from: 'review',
      fileIssueForReviewId: job.id,
    });
  });

  it('rewrites abort to fix with DO NOT SHIP verdict when policy=fix', () => {
    const job = makeReview();
    const out = applyReleaseGuards({ job, decision: abortDecision, deps: deps('fix') });
    expect(out).toEqual({ next: 'fix', from: 'review', verdict: 'DO NOT SHIP' });
  });

  it('leaves abort unchanged when policy=abort', () => {
    const job = makeReview();
    const out = applyReleaseGuards({ job, decision: abortDecision, deps: deps('abort') });
    expect(out).toBe(abortDecision);
  });

  it('does not touch NEEDS ATTENTION abort (only DO NOT SHIP is policy-driven)', () => {
    const decision: NextPhase = {
      next: 'abort',
      from: 'review',
      verdict: 'NEEDS ATTENTION',
      stopReason: 'review cap reached',
    };
    const out = applyReleaseGuards({ job: makeReview(), decision, deps: deps('pass') });
    expect(out).toBe(decision);
  });

  it('does not touch non-review aborts', () => {
    const decision = { next: 'abort', from: 'review', verdict: 'DO NOT SHIP' } as NextPhase;
    const out = applyReleaseGuards({
      job: makeReview({ kind: 'test' }),
      decision,
      deps: deps('pass'),
    });
    expect(out).toBe(decision);
  });
});
