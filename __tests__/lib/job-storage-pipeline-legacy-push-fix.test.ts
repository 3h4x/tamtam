import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  insertJobsAndSync,
  truncateAll,
  sharedHandle,
  type JobInsert,
} from './job-storage-pipeline-fixtures';

describe.skip('runCompletionHooks – push-fix auto-recovery (unified fix)', () => {
  // After fix-push collapsed into the generic fix kind, push hook rejections
  // spawn `startFixFromJob(pushJobId)` (a fix kind with parentJobId pointing
  // at the push). The cap is counted on fix jobs whose parent is a push.
  // The fix→push re-attempt now flows through the parent-aware fix-success
  // branch in lifecycle.ts (re-runs push directly).
  const startFixFromJobMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startProjectReviewMock = vi.fn();
  const isHookRejectionMock = vi.fn();
  const isTestFailureRejectionMock = vi.fn();
  const isRemoteRaceRejectionMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const execMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let tempDir: string;

  function makeJob(kind: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-chain-test`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 12345,
      logPath,
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

  async function insertActiveRelease() {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'active-release-job',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 5,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as JobInsert);
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: isHookRejectionMock,
      isTestFailureRejection: isTestFailureRejectionMock,
      isRemoteRaceRejection: isRemoteRaceRejectionMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-pushfix-chain-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-from-push-1', pid: 999 });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'committed' });
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-1', pid: 888, logPath: '/tmp/rev.log' });
    isHookRejectionMock.mockReset().mockReturnValue(false);
    isTestFailureRejectionMock.mockReset().mockReturnValue(false);
    isRemoteRaceRejectionMock.mockReset().mockReturnValue(false);
    getProjectTestConfigMock.mockReset().mockReturnValue({ autoPushEnabled: false });
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock.mockReset().mockReturnValue('/proj');
  });

  afterAll(() => {
    if (tempDir) rmSync(/*turbopackIgnore: true*/ tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.resetModules();
  });

  it('spawns startFixFromJob(pushId) when push fails with a hook rejection', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-hook-fail.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'husky - pre-commit hook exited with code 1');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isHookRejectionMock).toHaveBeenCalled();
    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not spawn fix when push fails for a non-hook reason', async () => {
    isHookRejectionMock.mockReturnValue(false);
    const logFile = join(tempDir, 'push-network-fail.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'error: failed to push some refs to origin');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when push fails because pre-push tests broke', async () => {
    // Hook rejection is true (husky pre-push failed) but it's a test failure,
    // not a lint nit — we don't want to enter the fix retry loop because
    // Claude can't reliably "fix" flaky integration tests.
    isHookRejectionMock.mockReturnValue(true);
    isTestFailureRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-tests-fail.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'husky - pre-push script failed (code 1)\n FAIL  src/foo.test.ts\n Tests  1 failed | 100 passed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isTestFailureRejectionMock).toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when push succeeds', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const job = makeJob('push', null);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when the push-fix attempt cap (2) has been reached', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    // Two prior failed pushes, each with a fix-from-push child.
    const priorRows: JobInsert[] = [];
    for (let i = 0; i < 2; i++) {
      priorRows.push({
        id: `prior-push-${i}`,
        project: 'my-proj',
        kind: 'push',
        prompt: null,
        pid: 50 + i,
        logPath: null,
        startedAt: now - i * 20 - 10,
        finishedAt: now - i * 20 - 8,
        exitCode: 1,
        seen: true,
      } as JobInsert);
      priorRows.push({
        id: `prior-fix-${i}`,
        project: 'my-proj',
        kind: 'fix',
        parentJobId: `prior-push-${i}`,
        prompt: null,
        pid: 100 + i,
        logPath: null,
        startedAt: now - i * 10,
        finishedAt: now - i * 10 + 5,
        exitCode: 0,
        seen: true,
      } as JobInsert);
    }
    await insertJobsAndSync(priorRows);
    const logFile = join(tempDir, 'push-hook-capped.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('still spawns fix when only 1 prior attempt exists (cap is 2)', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'prior-push-0',
      project: 'my-proj',
      kind: 'push',
      prompt: null,
      pid: 50,
      logPath: null,
      startedAt: now - 30,
      finishedAt: now - 28,
      exitCode: 1,
      seen: true,
    } as JobInsert);
    await insertJobsAndSync({
      id: 'prior-fix-0',
      project: 'my-proj',
      kind: 'fix',
      parentJobId: 'prior-push-0',
      prompt: null,
      pid: 100,
      logPath: null,
      startedAt: now - 10,
      finishedAt: now - 5,
      exitCode: 0,
      seen: true,
    } as JobInsert);
    const logFile = join(tempDir, 'push-hook-one-prior.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledTimes(1);
  });

  it('chains review LGTM → commit when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
    const logFile = join(tempDir, 'lgtm-release.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('chains test pass → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
    // Provide uncommitted changes so the hook routes to review rather than push.
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('chains fix success → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
    const job = makeJob('fix', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('does NOT chain review when neither inRelease nor auto-push', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    const logFile = join(tempDir, 'lgtm-no-release.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).not.toHaveBeenCalled();
  });
});
