import { describe, expect, it } from 'vitest';
import { deriveBoardTransition } from '@/lib/github/project-board-status';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj',
    kind: 'run',
    prompt: null,
    pid: 1,
    logPath: null,
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    seen: false,
    verdict: null,
    ...overrides,
  };
}

describe('deriveBoardTransition', () => {
  it('maps a queued release start to Queued', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'release' }), 'started')).toEqual({
      status: 'Queued',
      summary: 'release queued',
    });
  });

  it('maps review start to Review', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review' }), 'started').status).toBe('Review');
  });

  it('maps fix start to Fixing', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'fix' }), 'started').status).toBe('Fixing');
  });

  it('maps LGTM review completion to Ready to Push', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'LGTM' }), 'finished').status).toBe('Ready to Push');
  });

  it('maps review attention verdicts to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'NEEDS ATTENTION' }), 'finished').status).toBe('Blocked');
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' }), 'finished').status).toBe('Blocked');
  });

  it('maps failed terminal jobs to Failed', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'push', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Failed');
  });

  it('maps successful terminal jobs to Done', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'release', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('Done');
  });

  it('keeps manual sync non-terminal for running jobs', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'run', finishedAt: null, exitCode: null }), 'manual')).toEqual({
      status: 'Running',
      summary: 'run started',
    });
  });
});
