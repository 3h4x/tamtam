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

  it('returns not_found when the release belongs to another project', async () => {
    getJobMock.mockReturnValue(makeJob({
      id: 'release-other-project',
      project: 'other-proj',
      kind: 'release',
      finishedAt: 100,
      exitCode: 0,
    }));

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'release-other-project');

    expect(resumed).toEqual({
      ok: false,
      status: 'not_found',
      detail: 'release not found',
      attempted: false,
    });
    expect(listJobsMock).not.toHaveBeenCalled();
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
  });

  it('returns not_found when the job exists but is not a release', async () => {
    getJobMock.mockReturnValue(makeJob({
      id: 'review-1',
      project: 'proj',
      kind: 'review',
      finishedAt: 100,
      exitCode: 0,
    }));

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'review-1');

    expect(resumed).toEqual({
      ok: false,
      status: 'not_found',
      detail: 'release not found',
      attempted: false,
    });
    expect(listJobsMock).not.toHaveBeenCalled();
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
  });

  it('returns not_stuck when the release has no pipeline steps', async () => {
    getJobMock.mockReturnValue(makeJob({
      id: 'release-no-steps',
      project: 'proj',
      kind: 'release',
      finishedAt: 100,
      exitCode: 0,
    }));
    listJobsMock.mockReturnValue([]);

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'release-no-steps');

    expect(resumed).toEqual({
      ok: false,
      status: 'not_stuck',
      detail: 'release has no pipeline steps to resume from',
      attempted: false,
    });
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
  });

  it('returns not_stuck when the latest step failed', async () => {
    const now = Date.now() / 1000;
    getJobMock.mockReturnValue(makeJob({
      id: 'release-failed-step',
      project: 'proj',
      kind: 'release',
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
    }));
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'review-failed',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-failed-step',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 1,
      }),
    ]);

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'release-failed-step');

    expect(resumed).toEqual({
      ok: false,
      status: 'not_stuck',
      detail: 'last step review (exit 1) is not a stuck non-terminal step — nothing to resume',
      attempted: false,
    });
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
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

  it('returns an error when re-acquiring the pipeline lock throws', async () => {
    const now = Date.now() / 1000;
    const release = makeJob({
      id: 'release-lock-error',
      project: 'proj',
      kind: 'release',
      startedAt: now - 300,
      finishedAt: now - 60,
      exitCode: 0,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'review-1',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-lock-error',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 0,
      }),
    ]);
    acquireLockMock.mockRejectedValue(new Error('lock service offline'));

    const { resumeStuckRelease } = await import('@/lib/pipeline/resume-stuck-release');
    const resumed = await resumeStuckRelease('proj', 'release-lock-error');

    expect(resumed).toEqual({
      ok: false,
      status: 'error',
      detail: 'failed to re-acquire pipeline lock: lock service offline',
      attempted: false,
    });
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

  // ─── autoResumeOrphanedAgentRuns ─────────────────────────────────────────────

  describe('autoResumeOrphanedAgentRuns — attempt counter gating', () => {
    let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
    let startReleaseMock: ReturnType<typeof vi.fn>;

    function makeAgentJob(overrides: Partial<JobData> = {}): JobData {
      const now = Date.now() / 1000;
      return makeJob({
        id: 'agent-job-1',
        kind: 'agent:test',
        project: 'proj',
        exitCode: 0,
        startedAt: now - 120,
        finishedAt: now - 60,
        ...overrides,
      });
    }

    beforeEach(() => {
      getProjectTestConfigMock = vi.fn().mockReturnValue({
        releaseAfterRun: true,
        autoCommitEnabled: false,
        autoPushEnabled: false,
      });
      startReleaseMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'new-release-1' });

      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getProjectTestConfig: getProjectTestConfigMock,
      }));
      vi.doMock('@/lib/pipeline/start-release', () => ({
        startRelease: startReleaseMock,
      }));
    });

    it('finds only the newest qualifying orphan per project and skips projects with newer pipeline activity', async () => {
      const now = Date.now() / 1000;
      listJobsMock.mockReturnValue([
        makeAgentJob({
          id: 'agent-old',
          project: 'proj-a',
          startedAt: now - 300,
          finishedAt: now - 240,
        }),
        makeAgentJob({
          id: 'agent-new',
          project: 'proj-a',
          startedAt: now - 180,
          finishedAt: now - 120,
        }),
        makeAgentJob({
          id: 'agent-blocked',
          project: 'proj-b',
          startedAt: now - 200,
          finishedAt: now - 150,
        }),
        makeJob({
          id: 'push-after-agent',
          kind: 'push',
          project: 'proj-b',
          releaseId: 'release-b',
          startedAt: now - 100,
          finishedAt: now - 90,
          exitCode: 0,
        }),
        makeAgentJob({
          id: 'agent-ok',
          project: 'proj-c',
          startedAt: now - 110,
          finishedAt: now - 100,
        }),
      ]);

      const { findOrphanedAgentRuns } = await import('@/lib/pipeline/resume-stuck-release');

      expect(findOrphanedAgentRuns()).toEqual([
        {
          jobId: 'agent-ok',
          project: 'proj-c',
          finishedAt: now - 100,
        },
        {
          jobId: 'agent-new',
          project: 'proj-a',
          finishedAt: now - 120,
        },
      ]);
    });

    it('does not consume an attempt when wantsAutoShip is false', async () => {
      getProjectTestConfigMock.mockReturnValue({
        releaseAfterRun: false,
        autoCommitEnabled: false,
        autoPushEnabled: false,
      });
      listJobsMock.mockReturnValue([makeAgentJob()]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      // No release attempted
      expect(startReleaseMock).not.toHaveBeenCalled();

      // On the next sweep, attempt count is still 0 so it can run again
      getProjectTestConfigMock.mockReturnValue({
        releaseAfterRun: true,
        autoCommitEnabled: false,
        autoPushEnabled: false,
      });
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(1);
    });

    it('does not consume an attempt when startRelease returns ok:false', async () => {
      startReleaseMock.mockResolvedValue({ ok: false, status: 409, detail: 'pipeline lock held' });
      listJobsMock.mockReturnValue([makeAgentJob()]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(1);

      // Attempt counter was not advanced — second sweep retries
      startReleaseMock.mockResolvedValue({ ok: true, jobId: 'new-release-2' });
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(2);
    });

    it('does not consume an attempt when getProjectTestConfig throws', async () => {
      getProjectTestConfigMock.mockImplementationOnce(() => { throw new Error('db error'); });
      listJobsMock.mockReturnValue([makeAgentJob()]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).not.toHaveBeenCalled();

      // Counter was not incremented — second sweep tries again
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(1);
    });

    it('does not consume an attempt when startRelease throws', async () => {
      startReleaseMock.mockRejectedValueOnce(new Error('network error'));
      listJobsMock.mockReturnValue([makeAgentJob()]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(1);

      // Counter was rolled back on throw — second sweep retries
      startReleaseMock.mockResolvedValue({ ok: true, jobId: 'new-release-3' });
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(2);
    });

    it('advances counter on success and caps at MAX_AUTO_RESUME_ATTEMPTS', async () => {
      listJobsMock.mockReturnValue([makeAgentJob()]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(1);

      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(2);

      // Third sweep: counter is at MAX (2) — job is excluded
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).toHaveBeenCalledTimes(2);
    });

    it('skips orphan when a release is currently in-flight (started before agent finished)', async () => {
      const now = Date.now() / 1000;
      const agentJob = makeAgentJob({ finishedAt: now - 30 });
      // Release started before the agent finished but is still running (finishedAt null)
      const inFlightRelease = makeJob({
        id: 'release-in-flight',
        kind: 'release',
        project: 'proj',
        startedAt: now - 120,
        finishedAt: null,
        exitCode: null,
      });
      listJobsMock.mockReturnValue([agentJob, inFlightRelease]);

      const { autoResumeOrphanedAgentRuns, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');
      _resetAutoResumeAttempts();
      await autoResumeOrphanedAgentRuns();
      expect(startReleaseMock).not.toHaveBeenCalled();
    });
  });

  it('caps auto-resume after two attempted hook restarts', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-max-attempts',
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
        id: 'commit-1',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-max-attempts',
        startedAt: now - 290,
        finishedAt: now - 280,
        exitCode: 0,
      }),
    ]);
    getJobMock.mockImplementation((id: string) => {
      if (id !== 'release-max-attempts') return null;
      return makeJob({
        id: 'release-max-attempts',
        project: 'proj',
        kind: 'release',
        startedAt: now - 300,
        finishedAt: now - 60,
        exitCode: 0,
      });
    });
    runCompletionHooksMock.mockRejectedValue(new Error('hook failed'));

    const { autoResumeStuckReleases, _resetAutoResumeAttempts } = await import('@/lib/pipeline/resume-stuck-release');

    _resetAutoResumeAttempts();
    await autoResumeStuckReleases();
    await autoResumeStuckReleases();
    await autoResumeStuckReleases();

    expect(acquireLockMock).toHaveBeenCalledTimes(2);
    expect(updateJobMock).toHaveBeenCalledTimes(4);
    expect(runCompletionHooksMock).toHaveBeenCalledTimes(2);
    expect(releaseLockMock).toHaveBeenCalledTimes(2);
  });
});
