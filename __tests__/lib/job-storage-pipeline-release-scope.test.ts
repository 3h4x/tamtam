import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  insertJobsAndSync,
  testDb,
  truncateAll,
  sharedHandle,
  type JobInsert,
} from './job-storage-pipeline-fixtures';

describe('runCompletionHooks – linked release scoping', () => {
  // Hoist mocks + module load to beforeAll; stable refs reset in beforeEach.
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
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
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-linked-release-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    getProjectTestConfigMock.mockReset().mockReturnValue({
      autoPushEnabled: false,
      autoCommitEnabled: false,
      autoPrMergeEnabled: false,
      prWorkflowEnabled: false,
    });
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
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/shared/notifications');
    vi.resetModules();
  });

  it('does not append or auto-chain a standalone pipeline job just because another release is active', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'active-release.log');
    writeFileSync(/*turbopackIgnore: true*/ releaseLog, '# release start\n');
    await testDb.db.insert(schema.jobs).values({
      id: 'release-live',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 20,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      releaseId: 'release-live',
    } as any);

    const testLog = join(tempDir, 'standalone-test.log');
    writeFileSync(/*turbopackIgnore: true*/ testLog, 'manual test output\n');
    const job = makeJob('test', testLog, { id: 'manual-test-1' });

    await markDoneFn(job, 0);

    expect(readFileSync(/*turbopackIgnore: true*/ releaseLog, 'utf8')).not.toContain('manual test output');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-live');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('appends linked child output into its own active release log', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'linked-release.log');
    writeFileSync(/*turbopackIgnore: true*/ releaseLog, '# release start\n');
    await insertJobsAndSync({
      id: 'release-linked',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 20,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      releaseId: 'release-linked',
    } as JobInsert);

    const childLog = join(tempDir, 'linked-pr-wait.log');
    writeFileSync(/*turbopackIgnore: true*/ childLog, 'merge poll output\n');
    const job = makeJob('pr-wait', childLog, { id: 'linked-pr-wait-1', releaseId: 'release-linked' });

    await markDoneFn(job, 0);

    await vi.waitFor(() => {
      expect(readFileSync(/*turbopackIgnore: true*/ releaseLog, 'utf8')).toContain('merge poll output');
    }, { timeout: 200, interval: 1 });
  });
});
