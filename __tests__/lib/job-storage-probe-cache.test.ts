import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { getSharedHandle, testDb, truncateAll } from './job-storage-probe-fixtures';

describe('markDone – ghIssuesCache invalidation', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;

  function makeJob(project: string, kind = 'run'): JobData {
    return {
      id: `${project}-${kind}-cache-test`,
      project,
      kind,
      prompt: null,
      pid: 0,
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
    };
  }

  async function insertCacheRow(project: string) {
    await testDb.db.insert(schema.ghIssuesCache).values({
      project,
      repo: `owner/${project}`,
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    });
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: getSharedHandle().db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: vi.fn().mockResolvedValue({ ok: false }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.resetModules();
  });

  it('deletes the ghIssuesCache row for the job project on markDone', async () => {
    await insertCacheRow('my-proj');
    const before = await testDb.db.select().from(schema.ghIssuesCache);
    expect(before).toHaveLength(1);

    const job = makeJob('my-proj');
    await markDoneFn(job, 0);

    const after = await testDb.db.select().from(schema.ghIssuesCache);
    expect(after).toHaveLength(0);
  });

  it('does not delete cache rows for other projects', async () => {
    await insertCacheRow('proj-a');
    await insertCacheRow('proj-b');

    const job = makeJob('proj-a');
    await markDoneFn(job, 0);

    const remaining = await testDb.db.select().from(schema.ghIssuesCache);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].project).toBe('proj-b');
  });

  it('succeeds silently when no cache row exists for the project', async () => {
    const job = makeJob('no-cache-proj');
    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('invalidates cache regardless of exit code', async () => {
    await insertCacheRow('failing-proj');
    const job = makeJob('failing-proj');
    await markDoneFn(job, 1);

    const after = await testDb.db.select().from(schema.ghIssuesCache);
    expect(after).toHaveLength(0);
  });
});
