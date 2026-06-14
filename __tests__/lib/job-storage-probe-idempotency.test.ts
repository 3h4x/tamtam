import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { getSharedHandle, testDb, truncateAll } from './job-storage-probe-fixtures';

describe('markDone – DB-level idempotency guard', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  let storageCache: Map<string, JobData>;

  function makeJob(id: string, kind = 'push'): JobData {
    return {
      id,
      project: 'guard-proj',
      kind,
      prompt: null,
      pid: 999,
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
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: false, detail: 'guard' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: false, detail: 'guard' });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.resetModules();
  });

  it('returns early and syncs finishedAt when DB row is already finalized', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-1', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-1');
    // Stale in-memory object: finishedAt is null even though DB says it's done
    expect(job.finishedAt).toBeNull();

    await markDoneFn(job, 0);

    // job.finishedAt must be synced from DB
    expect(job.finishedAt).toBe(alreadyFinishedAt);
    // No completion hooks should fire (no push/review triggered)
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not overwrite the DB finishedAt when returning early from DB guard', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-2', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-2');
    await markDoneFn(job, 99);

    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-2');
    // DB row should still have the original finishedAt, not a new one
    expect(row?.finishedAt).toBe(alreadyFinishedAt);
    expect(row?.exitCode).toBe(0); // not overwritten with 99
  });

  it('proceeds normally when DB row has finishedAt = null', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-3', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-3');
    await markDoneFn(job, 0);

    expect(job.finishedAt).not.toBeNull();
    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-3');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('lets only one concurrent caller claim a null-finished DB row', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-concurrent', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const first = makeJob('db-guard-job-concurrent');
    const second = makeJob('db-guard-job-concurrent');

    await Promise.all([
      markDoneFn(first, 0),
      markDoneFn(second, 99),
    ]);

    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-concurrent');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
    expect(first.finishedAt).toBe(row?.finishedAt);
    expect(second.finishedAt).toBe(row?.finishedAt);
    expect(second.exitCode).toBe(0);
  });

  it('rolls back the DB finish claim when the durable completion event cannot be written', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-event-rollback', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    await testDb.db.execute(sql.raw('DROP TABLE job_completion_events'));
    try {
      const job = makeJob('db-guard-job-event-rollback');
      await expect(markDoneFn(job, 0)).rejects.toThrow();
      expect(job.finishedAt).toBeNull();
      expect(job.exitCode).toBe(0);

      const row = (await testDb.db.select().from(schema.jobs))
        .find(r => r.id === 'db-guard-job-event-rollback');
      expect(row?.finishedAt).toBeNull();
      expect(row?.exitCode).toBeNull();
    } finally {
      await testDb.db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS job_completion_events (
          id serial PRIMARY KEY,
          job_id text NOT NULL UNIQUE,
          kind text NOT NULL,
          exit_code integer,
          project text NOT NULL,
          release_id text,
          gh_issue_number integer,
          emitted_at double precision NOT NULL,
          consumed_by text,
          consumed_at double precision
        )
      `));
    }
  });

  it('proceeds normally when no DB row exists (new job not yet persisted)', async () => {
    // Job exists only in memory (no DB row inserted yet)
    const job = makeJob('db-guard-no-row');
    await markDoneFn(job, 0);

    // Should have finalized as normal
    expect(job.finishedAt).not.toBeNull();
    expect(job.exitCode).toBe(0);
    const events = await testDb.db.select().from(schema.jobCompletionEvents);
    expect(events.find(e => e.jobId === 'db-guard-no-row')).toMatchObject({
      jobId: 'db-guard-no-row',
      exitCode: 0,
    });
  });

  it('in-memory guard still fires before the DB check (finishedAt already set)', async () => {
    const job = makeJob('db-guard-inmem');
    job.finishedAt = Date.now() / 1000 - 5; // already finalized in memory

    const snapshotFinishedAt = job.finishedAt;
    await markDoneFn(job, 99);

    // In-memory guard should have returned before any DB interaction
    expect(job.finishedAt).toBe(snapshotFinishedAt); // unchanged
    expect(job.exitCode).toBeNull(); // not overwritten
  });
});
