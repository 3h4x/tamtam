import { describe, it, expect, beforeEach, vi } from 'vitest';

// The helper reads/writes the jobs store through the job-storage facade. Mock
// it with an in-memory array so this is a pure unit test of the resolution
// logic — no Postgres pool, no jobs cache singleton.
const store = {
  jobs: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
};

vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: () => store.jobs,
  updateJob: (job: Record<string, unknown>) => {
    store.updated.push(job);
  },
}));

import { resolvePrWaitHitlForMergedPr } from '@/lib/jobs/resolve-pr-wait-hitl';

function prWaitJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    project: 'alpha',
    kind: 'pr-wait',
    finishedAt: 2000,
    exitCode: 1,
    contextMeta: JSON.stringify({ prNumber: 42, prWaitReason: 'risky_diff' }),
    ...overrides,
  };
}

function reasonOf(job: Record<string, unknown>): string | undefined {
  return JSON.parse(job.contextMeta as string).prWaitReason;
}

describe('resolvePrWaitHitlForMergedPr', () => {
  beforeEach(() => {
    store.jobs = [];
    store.updated = [];
  });

  it('stamps a finished non-zero risky_diff pr-wait for the merged PR as merged', () => {
    const job = prWaitJob({});
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(job)).toBe('merged');
    expect(store.updated).toHaveLength(1);
  });

  it('stamps a finished non-zero pr-wait with NO recorded reason (the blank-reason HITL)', () => {
    const job = prWaitJob({ contextMeta: JSON.stringify({ prNumber: 42 }) });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(job)).toBe('merged');
  });

  it('does not touch a pr-wait for a different PR number', () => {
    const job = prWaitJob({ contextMeta: JSON.stringify({ prNumber: 99, prWaitReason: 'risky_diff' }) });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(job)).toBe('risky_diff');
    expect(store.updated).toHaveLength(0);
  });

  it('does not touch a pr-wait in a different project', () => {
    const job = prWaitJob({ project: 'beta' });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(job)).toBe('risky_diff');
    expect(store.updated).toHaveLength(0);
  });

  it('does not touch a clean (exit 0) pr-wait', () => {
    const job = prWaitJob({ exitCode: 0, contextMeta: JSON.stringify({ prNumber: 42, prWaitReason: 'merged' }) });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(store.updated).toHaveLength(0);
  });

  it('does not touch a still-running pr-wait (finishedAt null)', () => {
    const job = prWaitJob({ finishedAt: null, exitCode: null });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(job)).toBe('risky_diff');
    expect(store.updated).toHaveLength(0);
  });

  it('is idempotent — an already-merged pr-wait is not rewritten', () => {
    const job = prWaitJob({ contextMeta: JSON.stringify({ prNumber: 42, prWaitReason: 'merged' }) });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(store.updated).toHaveLength(0);
  });

  it('ignores non-pr-wait jobs', () => {
    const job = prWaitJob({ kind: 'release' });
    store.jobs = [job];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(store.updated).toHaveLength(0);
  });

  it('stamps every outstanding pr-wait attempt for the same merged PR', () => {
    const a = prWaitJob({});
    const b = prWaitJob({ contextMeta: JSON.stringify({ prNumber: 42, prWaitReason: 'conflict' }) });
    store.jobs = [a, b];
    resolvePrWaitHitlForMergedPr('alpha', 42);
    expect(reasonOf(a)).toBe('merged');
    expect(reasonOf(b)).toBe('merged');
    expect(store.updated).toHaveLength(2);
  });
});
