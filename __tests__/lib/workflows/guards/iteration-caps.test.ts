import { describe, it, expect } from 'vitest';
import {
  checkIterationCap,
  countSiblingSteps,
  countFixFromPushSiblings,
} from '@/lib/workflows/guards/iteration-caps';
import type { JobData } from '@/lib/jobs/types';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';

function makeJob(overrides: Partial<JobData> & Pick<JobData, 'id' | 'kind'>): JobData {
  return {
    project: 'p',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 1000,
    finishedAt: 1010,
    exitCode: 0,
    seen: false,
    ...overrides,
  } as JobData;
}

const baseDeps = (jobs: JobData[]) => ({
  listJobs: () => jobs,
  maxStepIterations: () => 3,
  reviewFixMaxIterations: () => 3,
  pushFixAttemptCap: () => 2,
});

describe('countSiblingSteps', () => {
  it('counts release-scoped jobs of the given kind', () => {
    const jobs = [
      makeJob({ id: 't1', kind: 'test', releaseId: 'r1' }),
      makeJob({ id: 't2', kind: 'test', releaseId: 'r1' }),
      makeJob({ id: 't3', kind: 'test', releaseId: 'r2' }), // other release
      makeJob({ id: 'r1-rev', kind: 'review', releaseId: 'r1' }), // wrong kind
    ];
    expect(countSiblingSteps('p', 'test', 'r1', baseDeps(jobs))).toBe(2);
  });

  it('returns 0 when no matching jobs', () => {
    expect(countSiblingSteps('p', 'test', 'r1', baseDeps([]))).toBe(0);
  });

  it('ignores unfinished jobs', () => {
    const jobs = [
      makeJob({ id: 't1', kind: 'test', releaseId: 'r1' }),
      makeJob({ id: 't2', kind: 'test', releaseId: 'r1', finishedAt: null, exitCode: null }),
    ];
    expect(countSiblingSteps('p', 'test', 'r1', baseDeps(jobs))).toBe(1);
  });
});

describe('countFixFromPushSiblings', () => {
  it('counts fix jobs whose parent is a push in the release', () => {
    const jobs = [
      makeJob({ id: 'p1', kind: 'push', releaseId: 'r1' }),
      makeJob({ id: 'p2', kind: 'push', releaseId: 'r1' }),
      makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', parentJobId: 'p1' }),
      makeJob({ id: 'f2', kind: 'fix', releaseId: 'r1', parentJobId: 'p2' }),
      makeJob({ id: 'f3', kind: 'fix', releaseId: 'r1', parentJobId: 'r1-rev' }), // parent is review, not push
    ];
    expect(countFixFromPushSiblings('p', 'r1', baseDeps(jobs))).toBe(2);
  });

  it('ignores fixes from other releases', () => {
    const jobs = [
      makeJob({ id: 'p1', kind: 'push', releaseId: 'r2' }),
      makeJob({ id: 'f1', kind: 'fix', releaseId: 'r2', parentJobId: 'p1' }),
    ];
    expect(countFixFromPushSiblings('p', 'r1', baseDeps(jobs))).toBe(0);
  });

  it('ignores unfinished fixes even when their parent is a push', () => {
    const jobs = [
      makeJob({ id: 'p1', kind: 'push', releaseId: 'r1' }),
      makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', parentJobId: 'p1' }),
      makeJob({ id: 'f2', kind: 'fix', releaseId: 'r1', parentJobId: 'p1', finishedAt: null, exitCode: null }),
    ];
    expect(countFixFromPushSiblings('p', 'r1', baseDeps(jobs))).toBe(1);
  });
});

describe('checkIterationCap', () => {
  it('passes through when job has no releaseId (standalone)', () => {
    const job = makeJob({ id: 'fix-1', kind: 'fix', releaseId: null });
    const decision: NextPhase = { next: 'review', from: 'fix' };
    expect(checkIterationCap(job, decision, baseDeps([])).rewritten).toBeUndefined();
  });

  it('passes through for non-from-fix decisions (caps only apply to verification re-runs)', () => {
    const job = makeJob({ id: 't1', kind: 'test', releaseId: 'r1', exitCode: 0 });
    const decision: NextPhase = { next: 'review', from: 'test' };
    expect(checkIterationCap(job, decision, baseDeps([])).rewritten).toBeUndefined();
  });

  it('aborts when reviewFixMaxIterations is reached on from=fix → review', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 'rev1', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev2', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev3', kind: 'review', releaseId: 'r1' }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'review', from: 'fix' };
    const r = checkIterationCap(fixJob, decision, baseDeps(jobs));
    expect(r.rewritten).toMatchObject({ next: 'abort', from: 'review' });
    expect(r.rewritten).toHaveProperty('stopReason');
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('review cap reached');
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('3/3');
  });

  it('does not abort review reruns when reviewFixMaxIterations is zero', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 'rev1', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev2', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev3', kind: 'review', releaseId: 'r1' }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'review', from: 'fix' };
    const deps = {
      ...baseDeps(jobs),
      reviewFixMaxIterations: () => 0,
    };

    expect(checkIterationCap(fixJob, decision, deps).rewritten).toBeUndefined();
  });

  it('aborts when maxStepIterations is reached on from=fix → test', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 't1', kind: 'test', releaseId: 'r1' }),
      makeJob({ id: 't2', kind: 'test', releaseId: 'r1' }),
      makeJob({ id: 't3', kind: 'test', releaseId: 'r1' }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'test', from: 'fix' };
    const r = checkIterationCap(fixJob, decision, baseDeps(jobs));
    expect(r.rewritten).toMatchObject({ next: 'abort' });
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('test cap reached');
  });

  it('aborts when maxStepIterations is reached on from=fix → commit', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 'c1', kind: 'commit', releaseId: 'r1' }),
      makeJob({ id: 'c2', kind: 'commit', releaseId: 'r1' }),
      makeJob({ id: 'c3', kind: 'commit', releaseId: 'r1' }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'commit', from: 'fix' };
    const r = checkIterationCap(fixJob, decision, baseDeps(jobs));
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('commit cap reached');
  });

  it('uses pushFixAttemptCap when fix→push and the fix parent is a push', () => {
    const push1 = makeJob({ id: 'p1', kind: 'push', releaseId: 'r1' });
    const fix1 = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', parentJobId: 'p1' });
    const push2 = makeJob({ id: 'p2', kind: 'push', releaseId: 'r1' });
    const fix2 = makeJob({ id: 'f2', kind: 'fix', releaseId: 'r1', parentJobId: 'p2', exitCode: 0 });
    const decision: NextPhase = { next: 'push', from: 'fix' };
    const r = checkIterationCap(fix2, decision, baseDeps([push1, fix1, push2, fix2]));
    expect(r.rewritten).toMatchObject({ next: 'abort' });
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('push fix cap reached');
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('2/2');
  });

  it('keeps push-fix retries finite even when reviewFixMaxIterations is zero', () => {
    const push1 = makeJob({ id: 'p1', kind: 'push', releaseId: 'r1' });
    const fix1 = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', parentJobId: 'p1' });
    const push2 = makeJob({ id: 'p2', kind: 'push', releaseId: 'r1' });
    const fix2 = makeJob({ id: 'f2', kind: 'fix', releaseId: 'r1', parentJobId: 'p2', exitCode: 0 });
    const decision: NextPhase = { next: 'push', from: 'fix' };
    const deps = {
      ...baseDeps([push1, fix1, push2, fix2]),
      reviewFixMaxIterations: () => 0,
    };
    const r = checkIterationCap(fix2, decision, deps);
    expect(r.rewritten).toMatchObject({ next: 'abort' });
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('push fix cap reached');
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('2/2');
  });

  it('uses maxStepIterations when fix→push and fix parent is NOT a push', () => {
    const review1 = makeJob({ id: 'rev1', kind: 'review', releaseId: 'r1' });
    const fix1 = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', parentJobId: 'rev1', exitCode: 0 });
    const jobs = [
      review1,
      fix1,
      makeJob({ id: 'p1', kind: 'push', releaseId: 'r1' }),
      makeJob({ id: 'p2', kind: 'push', releaseId: 'r1' }),
      makeJob({ id: 'p3', kind: 'push', releaseId: 'r1' }),
    ];
    const decision: NextPhase = { next: 'push', from: 'fix' };
    const r = checkIterationCap(fix1, decision, baseDeps(jobs));
    expect((r.rewritten as { stopReason: string }).stopReason).toContain('push cap reached');
  });

  it('passes through when count is below the cap', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 'rev1', kind: 'review', releaseId: 'r1' }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'review', from: 'fix' };
    expect(checkIterationCap(fixJob, decision, baseDeps(jobs)).rewritten).toBeUndefined();
  });

  it('does not trip the review cap on unfinished sibling reviews', () => {
    const fixJob = makeJob({ id: 'f1', kind: 'fix', releaseId: 'r1', exitCode: 0 });
    const jobs = [
      makeJob({ id: 'rev1', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev2', kind: 'review', releaseId: 'r1' }),
      makeJob({ id: 'rev3', kind: 'review', releaseId: 'r1', finishedAt: null, exitCode: null }),
      fixJob,
    ];
    const decision: NextPhase = { next: 'review', from: 'fix' };
    expect(checkIterationCap(fixJob, decision, baseDeps(jobs)).rewritten).toBeUndefined();
  });
});
