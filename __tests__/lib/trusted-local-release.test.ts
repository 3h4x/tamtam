import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

const store = { value: undefined as string | undefined };
vi.mock('@/lib/jobs/parent-context', () => ({
  parentContext: { getStore: () => store.value },
}));

const jobs: JobData[] = [];
vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (id: string) => jobs.find((j) => j.id === id) ?? null,
}));

import { activeReleaseAllowsTrustedLocalChanges } from '@/lib/pipeline/trusted-local-release';

function makeJob(o: Partial<JobData> & Pick<JobData, 'id' | 'kind'>): JobData {
  return {
    project: 'p', prompt: null, pid: 0, logPath: null,
    startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    ...o,
  } as JobData;
}

describe('activeReleaseAllowsTrustedLocalChanges', () => {
  beforeEach(() => {
    jobs.length = 0;
    store.value = undefined;
  });

  it('returns false when there is no active parent', () => {
    expect(activeReleaseAllowsTrustedLocalChanges()).toBe(false);
  });

  it('returns true when the parent release carries the trusted flag', () => {
    jobs.push(makeJob({ id: 'rel', kind: 'release', contextMeta: JSON.stringify({ trustedLocalChanges: true }) }));
    store.value = 'rel';
    expect(activeReleaseAllowsTrustedLocalChanges()).toBe(true);
  });

  it('returns false when the release lacks the flag', () => {
    jobs.push(makeJob({ id: 'rel', kind: 'release', contextMeta: JSON.stringify({ something: 1 }) }));
    store.value = 'rel';
    expect(activeReleaseAllowsTrustedLocalChanges()).toBe(false);
  });

  it('resolves through a child step to its release row', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', contextMeta: JSON.stringify({ trustedLocalChanges: true }) }),
      makeJob({ id: 'test-1', kind: 'test', releaseId: 'rel' }),
    );
    store.value = 'test-1';
    expect(activeReleaseAllowsTrustedLocalChanges()).toBe(true);
  });

  it('returns false (never throws) on malformed contextMeta', () => {
    jobs.push(makeJob({ id: 'rel', kind: 'release', contextMeta: 'not json' }));
    store.value = 'rel';
    expect(activeReleaseAllowsTrustedLocalChanges()).toBe(false);
  });
});
