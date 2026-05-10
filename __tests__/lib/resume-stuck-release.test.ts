import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/types';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL,
      log_path TEXT,
      started_at REAL NOT NULL,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      session_id TEXT,
      user_prompt TEXT,
      context_meta TEXT,
      parent_job_id TEXT,
      gh_issue_number INTEGER,
      gh_issue_repo TEXT,
      gh_issue_title TEXT,
      log_pruned INTEGER DEFAULT 0,
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJob(overrides: Partial<JobData> = {}): JobData {
  const now = Date.now() / 1000;
  return {
    id: 'job-1',
    project: 'proj',
    kind: 'release',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    verdict: null,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: null,
    provider: null,
    ...overrides,
  };
}

describe('resume-stuck-release helpers', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let runCompletionHooksMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let releaseLockMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    getJobMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);
    updateJobMock = vi.fn();
    runCompletionHooksMock = vi.fn().mockResolvedValue(undefined);
    acquireLockMock = vi.fn().mockResolvedValue({
      acquired: true,
      lock: { project: 'proj', lockedByJobId: 'release-1', acquiredAt: 1000 },
    });
    releaseLockMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      listJobs: listJobsMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      runCompletionHooks: runCompletionHooksMock,
      PIPELINE_STEP_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: acquireLockMock,
      releaseLock: releaseLockMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    testDb.sqlite.close();
  });

  it('scans by release finishedAt, not startedAt', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-old-start',
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: now - (2 * 24 * 60 * 60),
      finishedAt: now - 30,
      exitCode: 0,
      seen: false,
    } as any).run();
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'test-1',
        project: 'proj',
        kind: 'test',
        releaseId: 'release-old-start',
        startedAt: now - (2 * 24 * 60 * 60) + 10,
        finishedAt: now - (2 * 24 * 60 * 60) + 20,
        exitCode: 0,
      }),
    ]);

    const { findStuckFinalizedReleases } = await import('@/lib/pipeline/resume-stuck-release');
    const stuck = findStuckFinalizedReleases();

    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.release.id).toBe('release-old-start');
    expect(stuck[0]?.lastStep.id).toBe('test-1');
  });

  it('does not mark a finished release stuck when a later retry reused the release id after the chain gap', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-gap',
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
      seen: false,
    } as any).run();
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'push-1',
        project: 'proj',
        kind: 'push',
        releaseId: 'release-gap',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 0,
      }),
      makeJob({
        id: 'commit-retry',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-gap',
        startedAt: now - 120,
        finishedAt: now - 110,
        exitCode: 0,
      }),
    ]);

    const { findStuckFinalizedReleases, resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');

    expect(findStuckFinalizedReleases()).toEqual([]);

    getJobMock.mockReturnValue(makeJob({
      id: 'release-gap',
      project: 'proj',
      kind: 'release',
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
    }));
    const resumed = await resumeStuckRelease('proj', 'release-gap');

    expect(resumed).toEqual({
      ok: false,
      status: 'not_stuck',
      detail: 'last step push (exit 0) is not a stuck non-terminal step — nothing to resume',
      attempted: false,
    });
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
  });

  it('does not resume when another pipeline step is already running for the project', async () => {
    const now = Date.now() / 1000;
    const release = makeJob({
      id: 'release-busy',
      project: 'proj',
      kind: 'release',
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'commit-1',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-busy',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 0,
      }),
      makeJob({
        id: 'review-live',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-other',
        startedAt: now - 10,
        finishedAt: null,
        exitCode: null,
      }),
    ]);

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'release-busy');

    expect(resumed).toEqual({
      ok: false,
      status: 'job_busy',
      detail: 'another pipeline step is still running for proj',
      attempted: false,
      blockingJobId: 'review-live',
    });
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
    expect(release.finishedAt).toBe(now - 60);
    expect(release.exitCode).toBe(0);
  });

  it('does not spend the auto-resume budget when lock contention prevents reopening', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-retry',
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
      seen: false,
    } as any).run();
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'test-1',
        project: 'proj',
        kind: 'test',
        releaseId: 'release-retry',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 0,
      }),
    ]);
    getJobMock.mockImplementation((id: string) => {
      if (id !== 'release-retry') return null;
      return makeJob({
        id: 'release-retry',
        project: 'proj',
        kind: 'release',
        startedAt: now - 300,
        finishedAt: now - 60,
        exitCode: 0,
      });
    });
    acquireLockMock
      .mockResolvedValueOnce({
        acquired: false,
        blockingJobId: 'release-live',
        lock: { project: 'proj', lockedByJobId: 'release-live', acquiredAt: now - 5 },
      })
      .mockResolvedValueOnce({
        acquired: true,
        lock: { project: 'proj', lockedByJobId: 'release-retry', acquiredAt: now },
      });

    const { autoResumeStuckReleases, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');

    _resetAutoResumeAttempts();
    await autoResumeStuckReleases();
    await autoResumeStuckReleases();

    expect(acquireLockMock).toHaveBeenCalledTimes(2);
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(runCompletionHooksMock).toHaveBeenCalledTimes(1);
    expect(runCompletionHooksMock.mock.calls[0]?.[0]).toMatchObject({ id: 'test-1', kind: 'test' });
  });
});
