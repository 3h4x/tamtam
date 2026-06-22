import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import {
  insertJobsAndSync,
  truncateAll,
  sharedHandle,
  type JobInsert,
} from './job-storage-pipeline-fixtures';

describe('runCompletionHooks – abort short-circuit', () => {
  // Hoist mocks + module load to beforeAll; stable refs reset in beforeEach.
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;

  function makeJob(kind: string, id?: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: id ?? `${kind}-job`,
      project: 'abort-proj',
      kind,
      prompt: null,
      pid: 100,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-1' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-1' });
    getProjectTestConfigMock.mockReset().mockReturnValue({ autoPushEnabled: true });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.resetModules();
  });

  it('does not chain to next step when active release has abortedAt set', async () => {
    const now = Date.now() / 1000;
    // Insert an aborted release job — finishedAt is set (as the abort handler does)
    await insertJobsAndSync({
      id: 'release-aborted', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as JobInsert);

    // Step job must carry releaseId so the abort check can find the release
    const reviewJob = makeJob('review', 'review-after-abort', { releaseId: 'release-aborted' });
    await markDoneFn(reviewJob, 0);

    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not chain fix→review when active release is aborted', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-aborted-2', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as JobInsert);

    const fixJob = makeJob('fix', 'fix-after-abort', { releaseId: 'release-aborted-2' });
    await markDoneFn(fixJob, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });
});
