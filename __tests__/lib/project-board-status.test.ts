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
      status: 'Todo',
      summary: 'release queued',
    });
  });

  it('maps review start to Review', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review' }), 'started').status).toBe('Review');
  });

  it('maps fix start to Fixing', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'fix' }), 'started').status).toBe('Fixing');
  });

  it('maps LGTM review completion to In Progress', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'LGTM' }), 'finished').status).toBe('In Progress');
  });

  it('maps review attention verdicts to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'NEEDS ATTENTION' }), 'finished').status).toBe('Blocked');
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' }), 'finished').status).toBe('Blocked');
  });

  it('maps failed terminal jobs to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'push', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps successful terminal jobs to Done', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'release', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('Done');
  });

  it('keeps manual sync non-terminal for running jobs', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'run', finishedAt: null, exitCode: null }), 'manual')).toEqual({
      status: 'In Progress',
      summary: 'run started',
    });
  });

  it('maps aborted job to Blocked regardless of kind', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'push', exitCode: 1, finishedAt: 2, abortedAt: 1.5 }), 'finished').status).toBe('Blocked');
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: 'LGTM', finishedAt: 2, abortedAt: 1.5 }), 'finished').status).toBe('Blocked');
  });

  it('maps review with non-zero exit code to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps review finished without a matching verdict to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'review', exitCode: 0, verdict: null, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps test job pass to In Progress and fail to Blocked', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'test', exitCode: 0, finishedAt: 2 }), 'finished')).toEqual({
      status: 'In Progress',
      summary: 'tests passed',
    });
    expect(deriveBoardTransition(makeJob({ kind: 'test', exitCode: 1, finishedAt: 2 }), 'finished')).toEqual({
      status: 'Blocked',
      summary: 'tests failed (exit 1)',
    });
  });

  it('maps commit started to In Progress', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'commit' }), 'started').status).toBe('In Progress');
  });

  it('maps commit finished pass/fail correctly', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'commit', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('In Progress');
    expect(deriveBoardTransition(makeJob({ kind: 'commit', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps fix-push and fix-ci started to Fixing', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'fix-push' }), 'started').status).toBe('Fixing');
    expect(deriveBoardTransition(makeJob({ kind: 'fix-ci' }), 'started').status).toBe('Fixing');
  });

  it('maps fix-push and fix-ci finished pass/fail correctly', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'fix-push', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('In Progress');
    expect(deriveBoardTransition(makeJob({ kind: 'fix-ci', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps mark-dod and pr-wait finished pass/fail correctly', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'mark-dod', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('Done');
    expect(deriveBoardTransition(makeJob({ kind: 'pr-wait', exitCode: 1, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('maps unknown kind to generic Done/Blocked fallback', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'agent:cto', exitCode: 0, finishedAt: 2 }), 'finished').status).toBe('Done');
    expect(deriveBoardTransition(makeJob({ kind: 'agent:cto', exitCode: 2, finishedAt: 2 }), 'finished').status).toBe('Blocked');
  });

  it('manual sync uses finishedStatus for completed jobs', () => {
    expect(deriveBoardTransition(makeJob({ kind: 'push', exitCode: 0, finishedAt: 2 }), 'manual').status).toBe('Done');
  });
});
