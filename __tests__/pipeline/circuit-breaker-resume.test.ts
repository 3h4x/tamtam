import { describe, it, expect } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  isCircuitBreakerPause,
  hasCountableSuccessAfter,
  latestCountableFailureFinishedAt,
  shouldResumeCircuitBreakerPause,
} from '@/lib/pipeline/circuit-breaker-resume';

function job(overrides: Partial<JobData> & { project: string; kind: string }): JobData {
  return {
    id: `job-${Math.floor((overrides.finishedAt ?? 0) * 1000)}-${overrides.kind}`,
    startedAt: (overrides.finishedAt ?? 100) - 50,
    finishedAt: 100,
    exitCode: 0,
    contextMeta: null,
    releaseId: null,
    ...overrides,
  } as JobData;
}

describe('isCircuitBreakerPause', () => {
  it('matches the circuit-breaker reason string', () => {
    expect(isCircuitBreakerPause('Circuit breaker: 3 failed runs in 60min (threshold 3). Fix …')).toBe(true);
  });
  it('does NOT match a soak or push-hook pause reason', () => {
    expect(isCircuitBreakerPause('Post-merge soak failed — CI went red on the default branch after merge.')).toBe(false);
    expect(isCircuitBreakerPause('Pre-push hook rejected the push.')).toBe(false);
  });
  it('is false for empty / missing reasons', () => {
    expect(isCircuitBreakerPause(null)).toBe(false);
    expect(isCircuitBreakerPause(undefined)).toBe(false);
    expect(isCircuitBreakerPause('')).toBe(false);
  });
});

describe('latestCountableFailureFinishedAt', () => {
  it('returns the finish time of the most recent countable failure (the tripping run)', () => {
    const jobs = [
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1000 }),
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1500 }),
      job({ project: 'p', kind: 'run', exitCode: 0, finishedAt: 1800 }), // success ignored
    ];
    expect(latestCountableFailureFinishedAt(jobs, 'p')).toBe(1500);
  });
  it('ignores non-countable sub-steps (fix/review) and other projects', () => {
    const jobs = [
      job({ project: 'p', kind: 'review', exitCode: 1, finishedAt: 2000 }), // sub-step, not countable
      job({ project: 'p', kind: 'fix', exitCode: 1, finishedAt: 2100 }),
      job({ project: 'other', kind: 'release', exitCode: 1, finishedAt: 3000 }),
    ];
    expect(latestCountableFailureFinishedAt(jobs, 'p')).toBeNull();
  });
});

describe('hasCountableSuccessAfter', () => {
  it('true when a run/release/agent job succeeded after the pause moment', () => {
    const jobs = [
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1000 }),
      job({ project: 'p', kind: 'agent:issue-cruncher', exitCode: 0, finishedAt: 1200 }),
    ];
    expect(hasCountableSuccessAfter(jobs, 'p', 1100)).toBe(true);
  });
  it('false when the only successes are BEFORE the pause moment', () => {
    const jobs = [job({ project: 'p', kind: 'run', exitCode: 0, finishedAt: 500 })];
    expect(hasCountableSuccessAfter(jobs, 'p', 1000)).toBe(false);
  });
  it('false when only sub-steps (fix/review) succeed after the pause — not proof the release env recovered', () => {
    const jobs = [
      job({ project: 'p', kind: 'review', exitCode: 0, finishedAt: 1200 }),
      job({ project: 'p', kind: 'fix', exitCode: 0, finishedAt: 1300 }),
    ];
    expect(hasCountableSuccessAfter(jobs, 'p', 1100)).toBe(false);
  });
  it('false when countable runs keep FAILING after the pause', () => {
    const jobs = [job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1500 })];
    expect(hasCountableSuccessAfter(jobs, 'p', 1000)).toBe(false);
  });
  it('ignores unfinished jobs', () => {
    const jobs = [job({ project: 'p', kind: 'release', exitCode: null, finishedAt: null })];
    expect(hasCountableSuccessAfter(jobs, 'p', 1000)).toBe(false);
  });
});

describe('shouldResumeCircuitBreakerPause', () => {
  const base = { project: 'p', nowSec: 5000 };

  it('resumes a circuit-breaker pause once a countable run succeeds after the recorded pausedAt', () => {
    const jobs = [job({ project: 'p', kind: 'release', exitCode: 0, finishedAt: 2000 })];
    expect(
      shouldResumeCircuitBreakerPause({
        ...base,
        reason: 'Circuit breaker: 3 failed runs in 60min',
        pausedAt: 1500,
        jobs,
      }),
    ).toBe(true);
  });

  it('does NOT resume a soak / push-hook pause even if a later run succeeds', () => {
    const jobs = [job({ project: 'p', kind: 'release', exitCode: 0, finishedAt: 2000 })];
    expect(
      shouldResumeCircuitBreakerPause({
        ...base,
        reason: 'Post-merge soak failed — CI went red on the default branch after merge.',
        pausedAt: 1500,
        jobs,
      }),
    ).toBe(false);
  });

  it('does NOT resume when the project is still failing (clawdeco-shaped: red releases + successful sub-steps only)', () => {
    const jobs = [
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1000 }),
      job({ project: 'p', kind: 'review', exitCode: 0, finishedAt: 1800 }),
      job({ project: 'p', kind: 'fix', exitCode: 0, finishedAt: 1900 }),
    ];
    expect(
      shouldResumeCircuitBreakerPause({
        ...base,
        reason: 'Circuit breaker: 4 failed runs in 60min',
        pausedAt: 1200,
        jobs,
      }),
    ).toBe(false);
  });

  it('falls back to the tripping failure time when no explicit pausedAt is recorded (older pauses)', () => {
    // Tripping failure at 1000; a countable success at 1500 afterwards → resume.
    const jobs = [
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1000 }),
      job({ project: 'p', kind: 'run', exitCode: 0, finishedAt: 1500 }),
    ];
    expect(
      shouldResumeCircuitBreakerPause({
        ...base,
        reason: 'Circuit breaker: 3 failed runs in 60min',
        pausedAt: undefined,
        jobs,
      }),
    ).toBe(true);
  });

  it('does NOT resume on a stale success that predates the tripping failure (fallback path)', () => {
    const jobs = [
      job({ project: 'p', kind: 'run', exitCode: 0, finishedAt: 500 }), // success BEFORE the failure
      job({ project: 'p', kind: 'release', exitCode: 1, finishedAt: 1000 }),
    ];
    expect(
      shouldResumeCircuitBreakerPause({
        ...base,
        reason: 'Circuit breaker: 3 failed runs in 60min',
        pausedAt: undefined,
        jobs,
      }),
    ).toBe(false);
  });
});
