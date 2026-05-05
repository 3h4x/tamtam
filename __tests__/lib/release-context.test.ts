import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1_000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('release context helpers', () => {
  let findActiveReleaseJobMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let parsePrContextMeta: typeof import('@/lib/pipeline/release-context').parsePrContextMeta;
  let findReleaseScopedIssueContext: typeof import('@/lib/pipeline/release-context').findReleaseScopedIssueContext;
  let findReleaseScopedPrContext: typeof import('@/lib/pipeline/release-context').findReleaseScopedPrContext;
  let findLatestIssueRunContext: typeof import('@/lib/pipeline/release-context').findLatestIssueRunContext;

  beforeEach(async () => {
    vi.resetModules();
    findActiveReleaseJobMock = vi.fn().mockReturnValue(null);
    getJobMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/jobs/storage', () => ({
      findActiveReleaseJob: findActiveReleaseJobMock,
      getJob: getJobMock,
      listJobs: listJobsMock,
    }));

    ({
      parsePrContextMeta,
      findReleaseScopedIssueContext,
      findReleaseScopedPrContext,
      findLatestIssueRunContext,
    } = await import('@/lib/pipeline/release-context'));
  });

  it('parsePrContextMeta returns parsed PR metadata and rejects malformed input', () => {
    expect(
      parsePrContextMeta(JSON.stringify({ prNumber: 17, prRepo: 'owner/repo', prUrl: 'https://example.test/pr/17' })),
    ).toEqual({
      number: 17,
      repo: 'owner/repo',
      url: 'https://example.test/pr/17',
    });

    expect(parsePrContextMeta('{"prNumber":')).toBeNull();
    expect(parsePrContextMeta(JSON.stringify({ prNumber: 17 }))).toBeNull();
  });

  it('findReleaseScopedIssueContext prefers release-matching repo recovery for the latest issue job', () => {
    const activeRelease = makeJob({
      id: 'release-1',
      kind: 'release',
      startedAt: 5_000,
      releaseId: 'release-1',
    });
    const latestIssueJob = makeJob({
      id: 'fix-1',
      kind: 'fix',
      startedAt: 4_000,
      releaseId: 'release-1',
      ghIssueNumber: 42,
      ghIssueRepo: null,
      ghIssueTitle: 'Fix login bug',
    });
    const sameReleaseRepoSource = makeJob({
      id: 'run-1',
      startedAt: 3_000,
      releaseId: 'release-1',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Earlier issue run',
    });
    const newerOtherReleaseRepo = makeJob({
      id: 'run-2',
      startedAt: 4_500,
      releaseId: 'release-2',
      ghIssueNumber: 42,
      ghIssueRepo: 'wrong/repo',
      ghIssueTitle: 'Wrong release',
    });

    expect(
      findReleaseScopedIssueContext('proj', activeRelease, [
        activeRelease,
        latestIssueJob,
        sameReleaseRepoSource,
        newerOtherReleaseRepo,
      ]),
    ).toEqual({
      number: 42,
      repo: 'owner/repo',
      title: 'Fix login bug',
    });
  });

  it('findReleaseScopedIssueContext walks the release parent chain when scoped jobs do not carry issue data', () => {
    const triggerRun = makeJob({
      id: 'run-issue',
      startedAt: 2_000,
      ghIssueNumber: 77,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Parent-triggered issue',
    });
    const activeRelease = makeJob({
      id: 'release-1',
      kind: 'release',
      startedAt: 3_000,
      parentJobId: 'run-issue',
    });

    expect(
      findReleaseScopedIssueContext('proj', activeRelease, [activeRelease, triggerRun]),
    ).toEqual({
      number: 77,
      repo: 'owner/repo',
      title: 'Parent-triggered issue',
    });
  });

  it('findReleaseScopedPrContext picks the newest valid PR metadata from release-scoped jobs and parent chain', () => {
    const triggerRun = makeJob({
      id: 'run-pr',
      startedAt: 1_000,
      contextMeta: JSON.stringify({ prNumber: 12, prRepo: 'owner/repo', prUrl: 'https://example.test/pr/12' }),
    });
    const activeRelease = makeJob({
      id: 'release-1',
      kind: 'release',
      startedAt: 2_000,
      parentJobId: 'run-pr',
    });
    const invalidScoped = makeJob({
      id: 'review-1',
      kind: 'review',
      startedAt: 2_500,
      releaseId: 'release-1',
      contextMeta: '{"prNumber":',
    });
    const latestScoped = makeJob({
      id: 'fix-1',
      kind: 'fix',
      startedAt: 3_000,
      releaseId: 'release-1',
      contextMeta: JSON.stringify({ prNumber: 19, prRepo: 'owner/repo', prUrl: 'https://example.test/pr/19' }),
    });

    expect(
      findReleaseScopedPrContext('proj', activeRelease, [triggerRun, activeRelease, invalidScoped, latestScoped]),
    ).toEqual({
      number: 19,
      repo: 'owner/repo',
      url: 'https://example.test/pr/19',
    });
  });

  it('findLatestIssueRunContext only considers run jobs and recovers a missing repo from related jobs', () => {
    const olderRunWithRepo = makeJob({
      id: 'run-1',
      kind: 'run',
      startedAt: 1_000,
      ghIssueNumber: 33,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Issue title',
    });
    const newerRunMissingRepo = makeJob({
      id: 'run-2',
      kind: 'run',
      startedAt: 2_000,
      ghIssueNumber: 33,
      ghIssueRepo: null,
      ghIssueTitle: 'Fresh issue title',
    });
    const newestNonRun = makeJob({
      id: 'fix-1',
      kind: 'fix',
      startedAt: 3_000,
      ghIssueNumber: 99,
      ghIssueRepo: 'wrong/repo',
      ghIssueTitle: 'Should be ignored',
    });

    expect(
      findLatestIssueRunContext('proj', [olderRunWithRepo, newerRunMissingRepo, newestNonRun]),
    ).toEqual({
      number: 33,
      repo: 'owner/repo',
      title: 'Fresh issue title',
    });
  });

  it('returns null when no release-scoped issue or PR context is available', () => {
    const activeRelease = makeJob({
      id: 'release-1',
      kind: 'release',
      startedAt: 2_000,
    });

    expect(findReleaseScopedIssueContext('proj', activeRelease, [activeRelease])).toBeNull();
    expect(findReleaseScopedPrContext('proj', activeRelease, [activeRelease])).toBeNull();
  });
});
