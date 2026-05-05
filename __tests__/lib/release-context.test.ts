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
  let findReleaseScopedIssueJob: typeof import('@/lib/pipeline/release-context').findReleaseScopedIssueJob;
  let findLatestPrContext: typeof import('@/lib/pipeline/release-context').findLatestPrContext;

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
      findReleaseScopedIssueJob,
      findLatestPrContext,
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

  describe('findReleaseScopedIssueJob', () => {
    it('returns null when there is no active release', () => {
      expect(findReleaseScopedIssueJob('proj', null, [])).toBeNull();
    });

    it('returns null when no release-scoped jobs have issue numbers', () => {
      const activeRelease = makeJob({ id: 'release-1', kind: 'release', startedAt: 1_000 });
      const noIssue = makeJob({ id: 'fix-1', kind: 'fix', startedAt: 2_000, releaseId: 'release-1', ghIssueNumber: null });
      expect(findReleaseScopedIssueJob('proj', activeRelease, [activeRelease, noIssue])).toBeNull();
    });

    it('returns the latest release-scoped job with an issue number', () => {
      const activeRelease = makeJob({ id: 'release-1', kind: 'release', startedAt: 1_000 });
      const olderFix = makeJob({ id: 'fix-1', kind: 'fix', startedAt: 2_000, releaseId: 'release-1', ghIssueNumber: 10, ghIssueTitle: 'older' });
      const newerFix = makeJob({ id: 'fix-2', kind: 'fix', startedAt: 3_000, releaseId: 'release-1', ghIssueNumber: 10, ghIssueTitle: 'newer' });
      expect(findReleaseScopedIssueJob('proj', activeRelease, [activeRelease, olderFix, newerFix])?.id).toBe('fix-2');
    });

    it('falls back to parent chain when no release-scoped jobs carry issue numbers', () => {
      const triggerRun = makeJob({ id: 'run-1', startedAt: 1_000, ghIssueNumber: 77, ghIssueTitle: 'from parent' });
      const activeRelease = makeJob({ id: 'release-1', kind: 'release', startedAt: 2_000, parentJobId: 'run-1' });
      expect(findReleaseScopedIssueJob('proj', activeRelease, [triggerRun, activeRelease])?.id).toBe('run-1');
    });

    it('deduplicates jobs that appear in both release-scoped and parent chain', () => {
      const shared = makeJob({ id: 'run-shared', startedAt: 1_000, ghIssueNumber: 5, releaseId: 'release-1' });
      const activeRelease = makeJob({ id: 'release-1', kind: 'release', startedAt: 2_000, parentJobId: 'run-shared' });
      const result = findReleaseScopedIssueJob('proj', activeRelease, [shared, activeRelease]);
      expect(result?.id).toBe('run-shared');
    });

    it('ignores jobs from other projects', () => {
      const activeRelease = makeJob({ id: 'release-1', kind: 'release', startedAt: 1_000 });
      const otherProj = makeJob({ id: 'fix-other', kind: 'fix', startedAt: 2_000, project: 'other', releaseId: 'release-1', ghIssueNumber: 99 });
      expect(findReleaseScopedIssueJob('proj', activeRelease, [activeRelease, otherProj])).toBeNull();
    });
  });

  describe('findLatestPrContext', () => {
    it('returns null when no jobs exist', () => {
      expect(findLatestPrContext('proj', [])).toBeNull();
    });

    it('returns null when no jobs have valid PR metadata', () => {
      const job = makeJob({ id: 'run-1', startedAt: 1_000, contextMeta: null });
      expect(findLatestPrContext('proj', [job])).toBeNull();
    });

    it('returns the PR context from the latest job with valid metadata', () => {
      const older = makeJob({
        id: 'run-1',
        startedAt: 1_000,
        contextMeta: JSON.stringify({ prNumber: 5, prRepo: 'owner/repo', prUrl: 'https://example.test/5' }),
      });
      const newer = makeJob({
        id: 'run-2',
        startedAt: 2_000,
        contextMeta: JSON.stringify({ prNumber: 12, prRepo: 'owner/repo', prUrl: 'https://example.test/12' }),
      });
      expect(findLatestPrContext('proj', [older, newer])).toEqual({
        number: 12,
        repo: 'owner/repo',
        url: 'https://example.test/12',
      });
    });

    it('skips jobs from other projects', () => {
      const job = makeJob({
        id: 'run-other',
        project: 'other',
        startedAt: 3_000,
        contextMeta: JSON.stringify({ prNumber: 99, prRepo: 'wrong/repo' }),
      });
      expect(findLatestPrContext('proj', [job])).toBeNull();
    });

    it('skips jobs with malformed contextMeta and falls back to older valid ones', () => {
      const valid = makeJob({
        id: 'run-1',
        startedAt: 1_000,
        contextMeta: JSON.stringify({ prNumber: 7, prRepo: 'owner/repo' }),
      });
      const malformed = makeJob({ id: 'run-2', startedAt: 2_000, contextMeta: '{bad json' });
      expect(findLatestPrContext('proj', [valid, malformed])).toEqual({
        number: 7,
        repo: 'owner/repo',
        url: undefined,
      });
    });
  });
});
