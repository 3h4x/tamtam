import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  insertJobsAndSync,
  testDb,
  truncateAll,
  sharedHandle,
  type JobInsert,
} from './job-storage-pipeline-fixtures';

describe.skip('runCompletionHooks – fix→review auto-trigger', () => {
  // Hoist mocks + module imports to `beforeAll`; reset stable mock refs in
  // `beforeEach` to avoid the per-test `vi.resetModules() + await import(...)`
  // re-execution cost.
  const startProjectReviewMock = vi.fn();
  const getJobStatusMock = vi.fn();
  const deleteJobMock = vi.fn();
  const execMock = vi.fn();
  const markReviewedMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let storageCache: Map<string, JobData>;

  function makeFixJob(overrides: Partial<JobData> = {}): JobData {
    return {
      id: 'fix-job-1',
      project: 'my-proj',
      kind: 'fix',
      prompt: null,
      pid: 12345,
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
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: markReviewedMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 999, logPath: '/tmp/rev.log' });
    getJobStatusMock.mockReset();
    deleteJobMock.mockReset().mockResolvedValue(undefined);
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    markReviewedMock.mockReset().mockResolvedValue(undefined);
    resolveProjectPathMock.mockReset().mockReturnValue(null);
    getProjectTestConfigMock.mockReset().mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoPushEnabled: true,
    });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.resetModules();
  });

  it('calls startProjectReview after a fix job finishes with exitCode 0', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob();

    await probeJobStatusFn(job);

    expect(job.exitCode).toBe(0);
    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('does not call startProjectReview when fix job exits non-zero', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 1 });
    const job = makeFixJob();

    await probeJobStatusFn(job);

    expect(job.exitCode).toBe(1);
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not call startProjectReview for a review job (only fix triggers it)', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob({ id: 'review-job-x', kind: 'review' });

    await probeJobStatusFn(job);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not call startProjectReview for a run job', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob({ id: 'run-job-x', kind: 'run' });

    await probeJobStatusFn(job);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectReview throws', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    startProjectReviewMock.mockRejectedValue(new Error('review service down'));
    const job = makeFixJob();

    // should not throw even when startProjectReview fails
    await expect(probeJobStatusFn(job)).resolves.toBe('done');
  });
});
// Skipped: release-linked chain semantics now in the orchestrator. Relevant
// new coverage: __tests__/lib/workflows/release-orchestrator.test.ts +
// the dispatch-phase / decide-next-phase / phases/*-phase test suites.
describe.skip('runCompletionHooks – auto-push pipeline', () => {
  // Hoist mocks + module imports to `beforeAll`; reset stable mock refs in
  // `beforeEach` to avoid the per-test `vi.resetModules() + await import(...)`
  // re-execution cost across 42 tests.
  const startProjectTestMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startProjectReviewMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const startReleaseMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const execMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const isReviewedMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let tempDir: string;

  function makeJob(kind: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job`,
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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      isReviewed: isReviewedMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/pipeline/start-release', () => ({ startRelease: startReleaseMock }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    // Module-level verdict cache survives across tests when the module is not
    // reloaded per-test; clear it in beforeEach so stale review entries
    // (e.g. 'review-job' → 'LGTM' from a prior test) don't poison getVerdict.
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-autopush-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startProjectTestMock.mockReset().mockResolvedValue({ ok: true, jobId: 'test-auto', pid: 999, logPath: '/tmp/t.log', testCmd: 'pnpm test' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, jobId: 'release-auto', releaseJobId: 'release-auto', step: 'test', message: 'running' });
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    getProjectTestConfigMock.mockReset().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: true });
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock.mockReset().mockReturnValue('/proj');
    isReviewedMock.mockReset().mockResolvedValue(false);
  });

  afterAll(() => {
    if (tempDir) rmSync(/*turbopackIgnore: true*/ tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-test');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.resetModules();
  });

  it('finalizes active release job with exit 0 when push succeeds', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-job-push', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);

    const job = makeJob('push', null, { releaseId: 'release-job-push' });
    await markDoneFn(job, 0);

    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-push');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(0);
  });

  it('finalizes active release job with exit 1 when push fails', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-job-push-fail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);

    const job = makeJob('push', null, { releaseId: 'release-job-push-fail' });
    await markDoneFn(job, 1);

    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-push-fail');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(1);
  });

  it('skips finalization when DB row already has finishedAt set (concurrent probe guard)', async () => {
    const now = Date.now() / 1000;
    // Simulate a job that a concurrent probe already finalized in the DB,
    // but whose in-memory JobData still has finishedAt === null.
    await testDb.db.insert(schema.jobs).values({
      id: 'run-job', project: 'my-proj', kind: 'run',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: now - 1, exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('run', null); // in-memory finishedAt === null
    expect(job.finishedAt).toBeNull();
    await markDoneFn(job, 0);

    // The DB-level guard should have synced finishedAt onto the in-memory object...
    expect(job.finishedAt).not.toBeNull();
    // ...and should not have fired any hooks (no review, commit, or fix started).
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not finalize a release job that is already done (idempotent)', async () => {
    const now = Date.now() / 1000;
    await testDb.db.insert(schema.jobs).values({
      id: 'release-job-already-done', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 20, finishedAt: now - 5, exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('push', null);
    await markDoneFn(job, 0);

    // Already-done release job should not be re-finalized (finishedAt stays the same)
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-already-done');
    expect(releaseRow?.exitCode).toBe(0);
  });

  it('starts commit when review finishes with LGTM and auto-push is enabled', async () => {
    const logFile = join(tempDir, 'lgtm.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(execMock).not.toHaveBeenCalledWith('git', ['-C', '/proj', 'add', '-A'], { timeout: 10_000 });
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not stage local worktree after a PR review', async () => {
    const logFile = join(tempDir, 'pr-lgtm.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, {
      contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 12 }),
    });

    await markDoneFn(job, 0);

    expect(execMock).not.toHaveBeenCalledWith('git', ['-C', '/proj', 'add', '-A'], { timeout: 10_000 });
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
  });

  it('starts a fix when review verdict is NEEDS ATTENTION and auto-push is enabled', async () => {
    const logFile = join(tempDir, 'needs.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts a fix when review verdict is DO NOT SHIP', async () => {
    const logFile = join(tempDir, 'dns.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: DO NOT SHIP\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not chain anything when auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const logFile = join(tempDir, 'lgtm-off.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('starts a review when tests pass and auto-push is enabled', async () => {
    // Provide uncommitted changes so the hook takes the review path.
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not chain when test fails', async () => {
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts fix when test fails and autoPushEnabled is on', async () => {
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts fix when test fails and only autoCommitEnabled is on', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false });
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not start fix when test fails and neither auto flag is set', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false, autoCommitEnabled: false });
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('starts fix on test failure even when prior fix count would otherwise hit the cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      await testDb.db
        .insert(schema.jobs)
        .values({
          id: `testfail-prior-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 200 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any);
    }
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts fix when test fails during an active release (inRelease=true)', async () => {
    // Neither auto flag is set, but there's an active release job — should still fix.
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false, autoCommitEnabled: false });
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'active-release-for-testfail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('continues gracefully when test-fail startFixFromJob throws', async () => {
    startFixFromJobMock.mockRejectedValueOnce(new Error('spawn error'));
    const job = makeJob('test', null);

    await expect(markDoneFn(job, 1)).resolves.toBeUndefined();
  });

  it('does not start review when test passes but auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and git status shows no uncommitted changes', async () => {
    // exec returns empty stdout → no uncommitted changes → push directly, skip review
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('starts review when tests pass, worktree is clean, and local commits are unpushed', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })    // git status → clean
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' }); // git rev-list @{u}..HEAD → ahead
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass, worktree is clean, and a fresh LGTM already exists', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'fresh-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'fresh-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: true,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as JobInsert);
    writeFileSync(/*turbopackIgnore: true*/ join(tempDir, 'fresh-lgtm-review.log'), 'Verdict: LGTM\n');
    isReviewedMock.mockResolvedValue(true);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('re-runs review when tests pass, worktree is clean, and the LGTM is stale after a new commit', async () => {
    const now = Date.now() / 1000;
    await testDb.db.insert(schema.jobs).values({
      id: 'stale-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'stale-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: true,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any);
    writeFileSync(/*turbopackIgnore: true*/ join(tempDir, 'stale-lgtm-review.log'), 'Verdict: LGTM\n');
    isReviewedMock.mockResolvedValue(false);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and project path cannot be resolved', async () => {
    // resolveProjectPath returns null → cannot check changes → treat as no changes → push
    resolveProjectPathMock.mockReturnValueOnce(null);
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and git status check fails (non-zero exit)', async () => {
    execMock.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not a repo' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('test→push (no commit needed) when autoCommitEnabled=true and autoPushEnabled=false and no uncommitted changes', async () => {
    // When no uncommitted changes exist, nothing to commit, so push directly.
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectCommit throws', async () => {
    startProjectCommitMock.mockRejectedValue(new Error('git remote down'));
    const logFile = join(tempDir, 'lgtm-throw.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('continues gracefully when startProjectReview throws', async () => {
    startProjectReviewMock.mockRejectedValue(new Error('spawn failure'));
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('always starts fix on NEEDS ATTENTION even when prior fix count would otherwise hit the cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      await testDb.db
        .insert(schema.jobs)
        .values({
          id: `prior-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 100 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any);
    }

    const logFile = join(tempDir, 'needs-cap.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts a final fix on DO NOT SHIP even after prior fix cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-cap.log');
    writeFileSync(/*turbopackIgnore: true*/ releaseLog, '# release start\n');
    await testDb.db.insert(schema.jobs).values({
      id: 'release-cap',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 300,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any);
    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(schema.jobs).values({
        id: `release-cap-fix-${i}`,
        project: 'my-proj',
        kind: 'fix',
        prompt: null,
        pid: 500 + i,
        logPath: null,
        startedAt: now - 240 + i,
        finishedAt: now - 230 + i,
        exitCode: 0,
        seen: true,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        releaseId: 'release-cap',
      } as any);
    }

    const logFile = join(tempDir, 'review-cap.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Findings:\n- Finding ID: still-broken\n  Root cause: server bypass\nVerdict: DO NOT SHIP\n');
    const job = makeJob('review', logFile, { id: 'review-cap-final', releaseId: 'release-cap' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
    // Release stays open — the trailing fix continues; the cap fires on the
    // next fix-driven verification round, not here.
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-cap');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('starts fix on NEEDS ATTENTION even with prior fixes in the same release (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      await testDb.db
        .insert(schema.jobs)
        .values({
          id: `same-release-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 300 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-current',
        } as any);
    }

    const logFile = join(tempDir, 'release-scoped-cap.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile, { releaseId: 'release-current' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not count fixes from a different release against the current release cap', async () => {
    const now = Date.now() / 1000;
    // 3 fix jobs from a PREVIOUS release — should not eat into current release's budget
    for (let i = 0; i < 3; i++) {
      await testDb.db
        .insert(schema.jobs)
        .values({
          id: `old-release-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 400 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-previous',
        } as any);
    }

    const logFile = join(tempDir, 'new-release-not-capped.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: NEEDS ATTENTION\n');
    // New release with a different releaseId — previous release fixes should not count
    const job = makeJob('review', logFile, { releaseId: 'release-new' });

    await markDoneFn(job, 0);

    // The current release has 0 fixes, so it should start a fix
    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not auto-chain fix→review when auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('fix', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('starts commit (not push) when autoCommitEnabled is set without autoPushEnabled after LGTM review', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    const logFile = join(tempDir, 'lgtm-commit-only.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts commit when autoPushEnabled=true even if autoCommitEnabled=true after LGTM review', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: true, releaseAfterRun: false });
    const logFile = join(tempDir, 'lgtm-full-push.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains fix→review when autoCommitEnabled=true and autoPushEnabled=false', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    const job = makeJob('fix', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('auto-chains test→review when autoCommitEnabled=true and there are uncommitted changes', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains test→commit (skips review) when autoCommitEnabled=true, reviewDisabled=true, and there are uncommitted changes', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false, reviewDisabled: true });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains test→push when reviewDisabled=true and only unpushed commits remain', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false, reviewDisabled: true });
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  describe('fix-ci auto-retry on fast crash', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries fix-ci when it crashes within the fast-crash window', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const now = Date.now() / 1000;
      // Simulate a crashed-fast fix-ci: exit != 0, duration ~1s.
      const job = makeJob('fix-ci', null);
      job.startedAt = now - 1;

      await markDoneFn(job, -1);
      // Drain scheduled retry.
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/projects\/by-project\/my-proj\/fix-ci$/);
      expect(init.method).toBe('POST');
      vi.unstubAllGlobals();
    });

    it('does not retry when fix-ci ran longer than the fast-crash threshold', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const now = Date.now() / 1000;
      const job = makeJob('fix-ci', null);
      job.startedAt = now - 30; // 30s of runtime — real failure, not boot crash

      await markDoneFn(job, 1);

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not retry when the max retry count has been exceeded', async () => {
      // Insert 3 prior fix-ci jobs so the count gate trips.
      const now = Date.now() / 1000;
      await insertJobsAndSync(Array.from({ length: 3 }, (_, i) => ({
          id: `prior-fixci-${i}`, project: 'my-proj', kind: 'fix-ci',
          prompt: null, pid: 200 + i, logPath: null,
          startedAt: now - i, finishedAt: now - i + 1, exitCode: -1,
          seen: true, durationMs: null, inputTokens: null, outputTokens: null,
          cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
        } as JobInsert)));

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const job = makeJob('fix-ci', null);
      job.startedAt = now - 1;
      await markDoneFn(job, -1);
      await vi.runAllTimersAsync();

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not retry a successful fix-ci (exit 0)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const job = makeJob('fix-ci', null);
      job.startedAt = Date.now() / 1000 - 1;
      await markDoneFn(job, 0);

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
