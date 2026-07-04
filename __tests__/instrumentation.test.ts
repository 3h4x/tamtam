import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeChainedDb(agents: unknown[]) {
  const all = vi.fn().mockReturnValue(agents);
  // Drizzle's select chain is thenable — `await db.select().from(table)`
  // resolves to the row array. Without the `then`, awaiting returns the chain
  // object and `.filter` blows up downstream.
  const from = vi.fn().mockReturnValue({
    all,
    then(
      onFulfilled: (rows: unknown[]) => unknown,
      onRejected?: (err: unknown) => unknown,
    ) {
      return Promise.resolve(agents).then(onFulfilled, onRejected);
    },
  });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, all };
}

describe('instrumentation', () => {
  let originalRuntime: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    originalRuntime = process.env.NEXT_RUNTIME;
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = originalRuntime;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/pipeline/pr-wait-resume');
    vi.doUnmock('@/lib/shared/enabled-projects');
    vi.doUnmock('@/lib/jobs/stranded-branch-reconcile');
    vi.doUnmock('@/lib/jobs/job-storage');
    vi.doUnmock('@/lib/jobs/storage');
    vi.doUnmock('@/lib/workflows/safe-start-orchestrator');
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('@/lib/jobs/test-timeout-reaper');
    vi.doUnmock('@/lib/jobs/run-cap-reaper');
    vi.doUnmock('@/lib/pipeline/release-abort');
    vi.doUnmock('@/lib/db/reachability');
  });

  function mockDeps(agents: unknown[], options: { abortActiveRelease?: ReturnType<typeof vi.fn> } = {}) {
    const chainedDb = makeChainedDb(agents);
    const dbMock = { db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } };
    const noopExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const abortActiveRelease = options.abortActiveRelease ?? vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });
    vi.doMock('@/lib/db', () => dbMock);
    vi.doMock('@/lib/shared/shell', () => ({ exec: noopExec }));
    vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease }));
    vi.doMock('@/lib/jobs/stranded-branch-reconcile', () => ({
      reconcileStrandedBranches: vi.fn().mockResolvedValue({ triggered: [], skipped: [] }),
    }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((_a, b) => b), and: vi.fn((...args) => args) }));
  }

  // register() in instrumentation.ts is now a 4-line passthrough that
  // delegates to registerNode() when NEXT_RUNTIME==='nodejs'. The behavior
  // worth verifying is exercised through the registerNode() tests below.

  describe('registerNode()', () => {
    function mockRegisterNodeBootDeps(options: {
      jobs?: Array<Record<string, unknown>>;
      drainAllRecoveryWork?: ReturnType<typeof vi.fn>;
      markDone?: ReturnType<typeof vi.fn>;
      getWorldStart?: ReturnType<typeof vi.fn>;
    } = {}) {
      const jobs = options.jobs ?? [];
      const drainAllRecoveryWork = options.drainAllRecoveryWork ?? vi.fn().mockResolvedValue(undefined);
      const markDone = options.markDone ?? vi.fn().mockResolvedValue(undefined);
      const getWorldStart = options.getWorldStart ?? vi.fn().mockResolvedValue(undefined);
      const shellExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
      const dbMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
                  return Promise.resolve([]).then(onFulfilled, onRejected);
                },
              }),
            }),
            then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
              return Promise.resolve([]).then(onFulfilled, onRejected);
            },
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) }),
        }),
      };
      const schemaMock = {
        agents: { schedule: 'schedule', enabled: 'enabled' },
        pipelineLocks: { project: 'project' },
      };
      const jobStorageMock = {
        loadFromDb: vi.fn().mockResolvedValue(undefined),
        listJobs: vi.fn(() => jobs),
        getJob: vi.fn((id: string) => jobs.find((j) => j.id === id) ?? null),
        markDone,
        updateJob: vi.fn(),
        persistVerdict: vi.fn(),
        awaitInFlightSave: vi.fn().mockResolvedValue(undefined),
        probeJobStatus: vi.fn().mockResolvedValue(undefined),
        reconcileStaleRelease: vi.fn().mockResolvedValue(undefined),
        PIPELINE_STEP_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait']),
      };

      vi.doMock('@/lib/db', () => ({ db: dbMock, schema: schemaMock }));
      vi.doMock('@/lib/shared/shell', () => ({ exec: shellExec }));
      vi.doMock('@/lib/jobs/job-storage', () => jobStorageMock);
      vi.doMock('@/lib/jobs/storage', () => jobStorageMock);
      vi.doMock('@/lib/jobs/lifecycle', () => ({
        markDone,
        runCompletionHooks: vi.fn().mockResolvedValue(undefined),
        PIPELINE_STEP_KINDS: jobStorageMock.PIPELINE_STEP_KINDS,
      }));
      vi.doMock('@/lib/shared/enabled-projects', () => ({
        refreshProjectsCacheSync: vi.fn().mockResolvedValue(undefined),
        listEnabledProjects: vi.fn(() => []),
        isProjectArchived: vi.fn(() => false),
        isProjectPaused: vi.fn(() => false),
      }));
      vi.doMock('@/lib/agents/default-agent-skills', () => ({ backfillIssueCruncherPrerequisites: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/jobs/verdict', () => ({ getVerdict: vi.fn(() => null) }));
      vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/jobs/release-reconcile', () => ({ runReleaseReconcileSweep: vi.fn().mockResolvedValue([]) }));
      vi.doMock('@/lib/workflows/triggers/job-completion-router', () => ({ consumeJobCompletionEvents: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/workflows/triggers/pipeline-lock-router', () => ({ consumePipelineLockEvents: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/jobs/resource-sampler', () => ({ sampleRunningJobResources: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/jobs/stranded-branch-reconcile', () => ({
        reconcileStrandedBranches: vi.fn().mockResolvedValue({ triggered: [], skipped: [] }),
      }));
      vi.doMock('@/lib/shared/config', () => ({
        getSettings: vi.fn(() => ({
          retrieval_enabled: false,
          workflow_run_retention_days: 30,
        })),
      }));
      vi.doMock('@/lib/jobs/retention', () => ({ runNightlyCleanup: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/workflows/cron/workflow-retention', () => ({
        pruneOldWorkflowRuns: vi.fn().mockResolvedValue({
          runsDeleted: 0,
          eventsDeleted: 0,
          stepsDeleted: 0,
          status: 'ok',
          errorCount: 0,
        }),
      }));
      vi.doMock('@/lib/workflows/cron/seed-agent-crons', () => ({
        seedAgentCrons: vi.fn().mockResolvedValue({ enqueued: 0 }),
      }));
      vi.doMock('@/lib/workflows/cron/seed-system-cron', () => ({
        seedSystemCron: vi.fn().mockResolvedValue({ enqueued: false, reason: 'test' }),
      }));
      vi.doMock('@/lib/workflows/cron/start-cron-worker', () => ({
        startCronWorker: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/workflows/cron/system-cron-task', () => ({
        SYSTEM_CRON_JOB_KEY: 'system-cron',
      }));
      vi.doMock('@/lib/workflows/cron/project-sweep-task', () => ({
        PROJECT_SWEEP_JOB_KEY: 'project-sweep',
      }));
      vi.doMock('@/lib/workflows/cron/db-backup-task', () => ({
        DB_BACKUP_JOB_KEY: 'db-backup',
      }));
      vi.doMock('graphile-worker', () => ({
        quickAddJob: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/scheduling/internal-scheduler-helpers', () => ({
        listEnabledScheduledAgents: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({ drainAllRecoveryWork }));
      vi.doMock('@/lib/workflows/safe-start-orchestrator', () => ({
        safeStartOrchestrator: vi.fn().mockResolvedValue(false),
      }));
      vi.doMock('workflow/runtime', () => ({ getWorld: () => ({ start: getWorldStart }) }));
      vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((_a, b) => b), and: vi.fn((...args) => args) }));

      return { drainAllRecoveryWork, markDone, getWorldStart, shellExec };
    }

    it('backfills issue-cruncher prerequisites during boot', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const backfillIssueCruncherPrerequisitesMock = vi.fn();

      vi.doMock('@/lib/agents/default-agent-skills', () => ({
        backfillIssueCruncherPrerequisites: backfillIssueCruncherPrerequisitesMock,
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      expect(backfillIssueCruncherPrerequisitesMock).toHaveBeenCalledTimes(1);
    });

    it('does not remove broker containers during boot registration', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const { shellExec } = mockRegisterNodeBootDeps();

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      const brokerRemoveCall = shellExec.mock.calls.find((call: unknown[]) => {
        const [cmd, args] = call;
        return cmd === 'docker'
          && Array.isArray(args)
          && args[0] === 'rm'
          && args.includes('-f')
          && args.some((arg) => typeof arg === 'string' && arg.startsWith('tamtam-playwright-broker-'));
      });
      expect(brokerRemoveCall).toBeUndefined();
    });

    it('waitForWorkflowReady resolves immediately in test mode', async () => {
      // Regression: prior to the fix, reapOrphanReleases was armed via
      // setTimeout(8s) BEFORE world.start ran. Boot now gates reap on the
      // workflow-ready signal; in test mode the signal fires synchronously
      // so the test environment doesn't hang for 60s on the fallback.
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const { registerNode, waitForWorkflowReady } = await import('@/instrumentation-node');
      await registerNode();
      // Should resolve in well under the 60s fallback.
      const timeout = new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('waitForWorkflowReady did not resolve')), 1000);
        timer.unref?.();
      });
      await Promise.race([
        waitForWorkflowReady(),
        timeout,
      ]);
    });

    it('does not run destructive boot recovery when configured workflow startup is still pending after the watchdog', async () => {
      vi.useFakeTimers();
      try {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('VITEST', '');
        vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
        vi.stubEnv('DATABASE_URL', '');
        vi.stubEnv('WORKFLOW_POSTGRES_URL', '');
        const pendingStart = vi.fn(() => new Promise<void>(() => {}));
        const { drainAllRecoveryWork, markDone, getWorldStart } = mockRegisterNodeBootDeps({
          jobs: [{ id: 'release-pending-world', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100 }],
          getWorldStart: pendingStart,
        });

        const { registerNode } = await import('@/instrumentation-node');
        void registerNode();

        await vi.waitFor(() => {
          expect(getWorldStart).toHaveBeenCalledTimes(1);
        }, { timeout: 1000, interval: 1 });

        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();

        expect(markDone).not.toHaveBeenCalled();
        expect(drainAllRecoveryWork).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs destructive boot recovery when configured workflow startup definitively fails', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('WORKFLOW_POSTGRES_URL', '');
      const release = { id: 'release-failed-world', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100 };
      const { drainAllRecoveryWork, markDone } = mockRegisterNodeBootDeps({
        jobs: [release],
        getWorldStart: vi.fn().mockRejectedValue(new Error('world failed')),
      });

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      await vi.waitFor(() => {
        expect(markDone).toHaveBeenCalledWith(release, -1);
        expect(drainAllRecoveryWork).toHaveBeenCalledTimes(1);
      }, { timeout: 2000, interval: 1 });
    });

    it('runs destructive boot recovery immediately when no workflow world is configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('WORKFLOW_TARGET_WORLD', '');
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('WORKFLOW_POSTGRES_URL', '');
      const release = { id: 'release-no-world', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100 };
      const { drainAllRecoveryWork, markDone, getWorldStart } = mockRegisterNodeBootDeps({
        jobs: [release],
      });

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      await vi.waitFor(() => {
        expect(markDone).toHaveBeenCalledWith(release, -1);
        expect(drainAllRecoveryWork).toHaveBeenCalledTimes(1);
      }, { timeout: 2000, interval: 1 });
      expect(getWorldStart).not.toHaveBeenCalled();
    });

    it('resumes abandoned pr-wait inline jobs during boot instead of reaping them', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const listJobsMock = vi.fn().mockReturnValue([
        {
          id: 'pr-wait-1',
          kind: 'pr-wait',
          pid: 0,
          finishedAt: null,
          contextMeta: JSON.stringify({
            prNumber: 1,
            prRepo: 'owner/repo',
            prUrl: 'https://github.com/owner/repo/pull/1',
          }),
          project: 'proj1',
        },
      ]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumeBootPrWaitMock = vi.fn().mockReturnValue({ ok: true });

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        getJob: vi.fn((id: string) => listJobsMock().find((job: { id: string }) => job.id === id) ?? null),
        markDone: markDoneMock,
        updateJob: vi.fn(),
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/pr-wait-resume', () => ({ resumeBootPrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      await vi.waitFor(() => {
        expect(resumeBootPrWaitMock).toHaveBeenCalledWith('pr-wait-1');
      }, { timeout: 2000, interval: 1 });
      expect(markDoneMock).not.toHaveBeenCalled();
    });

    it('reaps abandoned pr-wait inline jobs when boot resume hits a missing project', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const orphanedPrWait = {
        id: 'pr-wait-missing-project',
        kind: 'pr-wait',
        pid: 0,
        finishedAt: null,
        contextMeta: JSON.stringify({
          prNumber: 1,
          prRepo: 'owner/repo',
          prUrl: 'https://github.com/owner/repo/pull/1',
        }),
        project: 'proj1',
      };
      const listJobsMock = vi.fn().mockReturnValue([orphanedPrWait]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumeBootPrWaitMock = vi.fn().mockReturnValue({ ok: false, error: 'project not found' });

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        getJob: vi.fn((id: string) => listJobsMock().find((job: { id: string }) => job.id === id) ?? null),
        markDone: markDoneMock,
        updateJob: vi.fn(),
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/pr-wait-resume', () => ({ resumeBootPrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      expect(resumeBootPrWaitMock).toHaveBeenCalledWith('pr-wait-missing-project');
      expect(markDoneMock).toHaveBeenCalledWith(orphanedPrWait, -1);
    });

    it('reaps abandoned pr-wait inline jobs when boot resume throws', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const orphanedPrWait = {
        id: 'pr-wait-resume-throws',
        kind: 'pr-wait',
        pid: 0,
        finishedAt: null,
        contextMeta: JSON.stringify({
          prNumber: 1,
          prRepo: 'owner/repo',
          prUrl: 'https://github.com/owner/repo/pull/1',
        }),
        project: 'proj1',
      };
      const listJobsMock = vi.fn().mockReturnValue([orphanedPrWait]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumeBootPrWaitMock = vi.fn(() => {
        throw new Error('resume failed');
      });

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        getJob: vi.fn((id: string) => listJobsMock().find((job: { id: string }) => job.id === id) ?? null),
        markDone: markDoneMock,
        updateJob: vi.fn(),
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/pr-wait-resume', () => ({ resumeBootPrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      expect(resumeBootPrWaitMock).toHaveBeenCalledWith('pr-wait-resume-throws');
      expect(markDoneMock).toHaveBeenCalledWith(orphanedPrWait, -1);
    });

    it('reaps abandoned inline jobs when pr-wait contextMeta is malformed', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const orphanedPrWait = { id: 'pr-wait-bad', kind: 'pr-wait', pid: 1234, finishedAt: null, contextMeta: '{', project: 'proj1' };
      const orphanedMarkDod = { id: 'mark-dod-1', kind: 'mark-dod', pid: 0, finishedAt: null, contextMeta: null, project: 'proj1' };
      const listJobsMock = vi.fn().mockReturnValue([orphanedPrWait, orphanedMarkDod]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumeBootPrWaitMock = vi.fn();

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        getJob: vi.fn((id: string) => listJobsMock().find((job: { id: string }) => job.id === id) ?? null),
        markDone: markDoneMock,
        updateJob: vi.fn(),
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/pr-wait-resume', () => ({ resumeBootPrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumeBootPrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      // registerNode() awaits the inline-reap promise under NODE_ENV==='test',
      // so the reap has already run by the time it resolves — assert directly
      // (like the sibling pr-wait reap tests above) instead of polling, which
      // flakes under heavy parallel CI contention.
      expect(resumeBootPrWaitMock).not.toHaveBeenCalled();
      expect(markDoneMock).toHaveBeenCalledWith(orphanedPrWait, -1);
      expect(markDoneMock).toHaveBeenCalledWith(orphanedMarkDod, -1);
    });
  });

  describe('reapOrphanReleases()', () => {
    let currentOrphanStorageMock: Record<string, unknown>;
    let currentOrphanDbMock: Record<string, unknown>;
    let currentOrphanShellMock: Record<string, unknown>;
    let currentOrphanWorkflowMock: Record<string, unknown>;
    let currentOrphanDrizzleMock: Record<string, unknown>;

    beforeEach(() => {
      currentOrphanStorageMock = {
        listJobs: vi.fn(() => []),
        getJob: vi.fn(() => null),
        markDone: vi.fn().mockResolvedValue(undefined),
        updateJob: vi.fn(),
        reconcileStaleRelease: vi.fn().mockResolvedValue(undefined),
      };
      currentOrphanDbMock = {
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
                    return Promise.resolve([]).then(onFulfilled, onRejected);
                  },
                }),
              }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) }),
          }),
        },
        schema: { pipelineLocks: { project: 'project' } },
      };
      currentOrphanShellMock = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      };
      currentOrphanWorkflowMock = {
        safeStartOrchestrator: vi.fn().mockResolvedValue(true),
      };
      currentOrphanDrizzleMock = { eq: vi.fn((_a, b) => b) };

      // Register one durable factory per dependency for this describe block.
      // The factory reads the current holder at import time, so resetModules()
      // cannot resurrect a stale mock or fall through to the real pg-backed DB
      // when the slow Vitest fork pool is under CPU pressure.
      vi.doMock('@/lib/jobs/job-storage', () => currentOrphanStorageMock);
      vi.doMock('@/lib/jobs/storage', () => currentOrphanStorageMock);
      vi.doMock('@/lib/db', () => currentOrphanDbMock);
      vi.doMock('@/lib/shared/shell', () => currentOrphanShellMock);
      vi.doMock('@/lib/workflows/safe-start-orchestrator', () => currentOrphanWorkflowMock);
      vi.doMock('drizzle-orm', () => currentOrphanDrizzleMock);
    });

    function mockOrphanReleaseDeps({
      jobs,
      lockRow = null,
      execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      markDoneMock = vi.fn().mockResolvedValue(undefined),
      reconcileStaleReleaseMock = vi.fn().mockResolvedValue(undefined),
    }: {
      jobs: Array<Record<string, unknown>>;
      lockRow?: { lockedByJobId: string } | null;
      execMock?: ReturnType<typeof vi.fn>;
      markDoneMock?: ReturnType<typeof vi.fn>;
      reconcileStaleReleaseMock?: ReturnType<typeof vi.fn>;
    }) {
      const byId = new Map(jobs.map((job) => [job.id as string, job]));
      // Production now uses `await db.select().from(t).where(...).limit(1)` — the
      // chain must be thenable and resolve to the row array. Also expose `.get`
      // and `.all` for any legacy call sites that still use the sync getter API.
      const lockRows = lockRow ? [lockRow] : [];
      const lockLimit = vi.fn().mockReturnValue({
        then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
          return Promise.resolve(lockRows).then(onFulfilled, onRejected);
        },
      });
      const lockGet = vi.fn().mockReturnValue(lockRow);
      const lockAll = vi.fn().mockReturnValue(lockRows);
      const lockWhere = vi.fn().mockReturnValue({ get: lockGet, all: lockAll, limit: lockLimit });
      const deleteRun = vi.fn();
      const deleteWhere = vi.fn().mockReturnValue({
        run: deleteRun,
        execute: vi.fn().mockResolvedValue(undefined),
      });
      const dbMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: lockWhere,
            // safety valve: prevents TypeError if lib/jobs/storage.ts is accidentally
            // evaluated with this dbMock (it calls db.select().from(jobs).all())
            all: vi.fn().mockReturnValue([]),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: deleteWhere,
        }),
      };

      // Don't merge into the cached object — production `updateJob` only
      // saves the passed object, it doesn't refresh the cache. The boot
      // recovery code must mutate the cached object itself; this mock
      // catches regressions to that contract.
      const updateJobMock = vi.fn();
      const safeStartOrchestratorMock = vi.fn().mockResolvedValue(true);

      const storageMock = {
        listJobs: vi.fn(() => jobs),
        getJob: vi.fn((id: string) => byId.get(id) ?? null),
        markDone: markDoneMock,
        updateJob: updateJobMock,
        reconcileStaleRelease: reconcileStaleReleaseMock,
      };

      // reapOrphanReleases dynamically imports each dependency at call time.
      // resetModules clears the import cache but preserves the durable
      // doMock factories from this describe block; they read these current
      // holders when instrumentation-node dynamically imports dependencies.
      currentOrphanStorageMock = storageMock;
      currentOrphanDbMock = { db: dbMock, schema: { pipelineLocks: { project: 'project' } } };
      currentOrphanShellMock = { exec: execMock };
      currentOrphanWorkflowMock = { safeStartOrchestrator: safeStartOrchestratorMock };
      currentOrphanDrizzleMock = { eq: vi.fn((_a, b) => b) };
      vi.resetModules();

      return { execMock, markDoneMock, updateJobMock, reconcileStaleReleaseMock, safeStartOrchestratorMock, deleteRun };
    }

    it('resumes a stranded release via safeStartOrchestrator after the handoff grace', async () => {
      // Phase-0 orphan-resume: instead of calling markDone(-1) on a release
      // whose last child finished but whose orchestrator died, we dispatch
      // a fresh orchestrator tick from the latestFinishedChild so the chain
      // continues across the restart.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const release: { id: string; project: string; kind: string; finishedAt: number | null; startedAt: number; contextMeta: string | null } = {
          id: 'release-1', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100, contextMeta: null,
        };
        const push = { id: 'push-1', project: 'proj', kind: 'push', releaseId: 'release-1', finishedAt: 150, startedAt: 140 };
        const { markDoneMock, safeStartOrchestratorMock, updateJobMock } = mockOrphanReleaseDeps({
          jobs: [release, push],
        });

        const { reapOrphanReleases } = await import('@/instrumentation-node');
        await reapOrphanReleases();

        expect(safeStartOrchestratorMock).toHaveBeenCalledWith('push-1', 'proj', 'release-1', 'orphan-resume');
        expect(markDoneMock).not.toHaveBeenCalled();
        // bootRecoveryAttempts persisted via updateJob
        const updateCall = updateJobMock.mock.calls.find((c) => (c[0] as { id: string }).id === 'release-1');
        expect(updateCall).toBeTruthy();
        expect(JSON.parse((updateCall![0] as { contextMeta: string }).contextMeta)).toMatchObject({ bootRecoveryAttempts: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reaps after MAX_BOOT_RESUMES attempts exhausted', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const release = {
          id: 'release-99', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100,
          contextMeta: JSON.stringify({ bootRecoveryAttempts: 3 }),
        } as Record<string, unknown>;
        const push = { id: 'push-99', project: 'proj', kind: 'push', releaseId: 'release-99', finishedAt: 150, startedAt: 140 };
        const { markDoneMock, safeStartOrchestratorMock, updateJobMock } = mockOrphanReleaseDeps({
          jobs: [release, push],
        });

        const { reapOrphanReleases } = await import('@/instrumentation-node');
        await reapOrphanReleases();

        // Assert against THIS release's id — under CI's 4-worker fork pool the
        // mock has been observed receiving a late call from the prior test's
        // microtask settle-out when fakeTimers + resetModules race. Filtering
        // by release-id makes the assertion robust to that timing leak without
        // hiding a real regression on release-99 itself.
        const callsForThisRelease = safeStartOrchestratorMock.mock.calls.filter(
          (c) => c[2] === 'release-99'
        );
        expect(callsForThisRelease).toHaveLength(0);
        expect(markDoneMock).toHaveBeenCalledWith(release, -1);
        // stopReason is recorded on contextMeta before the reap
        const updateCall = updateJobMock.mock.calls.find((c) => (c[0] as { id: string }).id === 'release-99');
        expect(updateCall).toBeTruthy();
        expect(JSON.parse((updateCall![0] as { contextMeta: string }).contextMeta)).toMatchObject({
          stopReason: expect.stringContaining('exceeded boot-recovery attempts'),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reaps when orphan resume dispatch fails', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const release = {
          id: 'release-dispatch-failed', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100, contextMeta: null,
        };
        const push = {
          id: 'push-dispatch-failed',
          project: 'proj',
          kind: 'push',
          releaseId: 'release-dispatch-failed',
          finishedAt: 150,
          startedAt: 140,
        };
        const { markDoneMock, safeStartOrchestratorMock, updateJobMock } = mockOrphanReleaseDeps({
          jobs: [release, push],
        });
        safeStartOrchestratorMock.mockResolvedValueOnce(false);

        const { reapOrphanReleases } = await import('@/instrumentation-node');
        await reapOrphanReleases();

        expect(safeStartOrchestratorMock).toHaveBeenCalledWith(
          'push-dispatch-failed',
          'proj',
          'release-dispatch-failed',
          'orphan-resume',
        );
        expect(markDoneMock).toHaveBeenCalledWith(release, -1);
        const updateCall = updateJobMock.mock.calls.find((c) => (c[0] as { id: string }).id === 'release-dispatch-failed');
        expect(updateCall).toBeTruthy();
        expect(JSON.parse((updateCall![0] as { contextMeta: string }).contextMeta)).toMatchObject({ bootRecoveryAttempts: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips releases that still have a live child step', async () => {
      const release = { id: 'release-2', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100 };
      const review = { id: 'review-2', project: 'proj', kind: 'review', releaseId: 'release-2', finishedAt: null, startedAt: 140 };
      const { execMock, markDoneMock, reconcileStaleReleaseMock } = mockOrphanReleaseDeps({
        jobs: [release, review],
      });

      const { reapOrphanReleases } = await import('@/instrumentation-node');
      await reapOrphanReleases();

      expect(reconcileStaleReleaseMock).not.toHaveBeenCalled();
      expect(markDoneMock).not.toHaveBeenCalled();
      expect(execMock).not.toHaveBeenCalled();
    });

    it('still reaps zero-child orphan releases directly', async () => {
      const release = { id: 'release-3', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100 };
      const { markDoneMock, reconcileStaleReleaseMock } = mockOrphanReleaseDeps({
        jobs: [release],
      });

      const { reapOrphanReleases } = await import('@/instrumentation-node');
      await reapOrphanReleases();

      expect(reconcileStaleReleaseMock).not.toHaveBeenCalled();
      expect(markDoneMock).toHaveBeenCalledWith(release, -1);
    });
  });


  describe('runProbeSweep()', () => {
    // runProbeSweep dynamically imports job-storage. The preceding
    // reapOrphanReleases block registers its own
    // `vi.doMock('@/lib/jobs/job-storage', …)` with a differently-shaped
    // storageMock (no probeJobStatus / PIPELINE_STEP_KINDS). The earlier
    // approach re-registered a *new* doMock factory per test and relied on
    // doUnmock→resetModules→doMock ordering to evict the stale one; under
    // fork-pool CPU starvation that eviction could race, leaving the stale
    // reap-shaped mock active and yielding 0 probe calls.
    //
    // Instead register the doMock factory ONCE per test against a stable,
    // live holder. The factory always returns whatever `currentStorageMock`
    // points at right now, so the value a test installs can never lose a race
    // with a prior test's registration — there is only one factory, and it
    // reads the holder at import time.
    let currentStorageMock: Record<string, unknown>;

    beforeEach(() => {
      currentStorageMock = { listJobs: () => [], probeJobStatus: vi.fn() };
      vi.doMock('@/lib/jobs/job-storage', () => currentStorageMock);
      vi.doMock('@/lib/jobs/storage', () => currentStorageMock);
      // Default the reachability gate to "DB up" so the sweep runs its full body;
      // the outage test below overrides this. Mocking here also keeps the real
      // dedicated-connection probe (a live Postgres connect) out of unit tests.
      vi.doMock('@/lib/db/reachability', () => ({
        ensureDbReachable: async () => true,
        reportDbError: () => false,
        reportDbOk: () => {},
      }));
    });

    function mockJobStorageModule(factory: () => Record<string, unknown>) {
      currentStorageMock = factory();
      // Force a fresh module registry so the next dynamic import of
      // job-storage re-evaluates the (surviving) doMock factory and reads the
      // holder we just set. Without this, a stale registry entry imported by a
      // prior test under fork-pool CPU contention could shadow this mock,
      // leaving runProbeSweep with the default empty-listJobs mock (0 probes).
      // resetModules clears the import cache but preserves doMock registrations.
      vi.resetModules();
    }

    function mockJobStorage(
      jobs: unknown[],
      options: {
        probeJobStatus?: ReturnType<typeof vi.fn>;
        reconcileStaleRelease?: ReturnType<typeof vi.fn>;
        pipelineStepKinds?: Set<string>;
      } = {},
    ) {
      const probeJobStatus = options.probeJobStatus ?? vi.fn().mockResolvedValue(undefined);
      const reconcileStaleRelease = options.reconcileStaleRelease ?? vi.fn().mockResolvedValue(undefined);
      const pipelineStepKinds = options.pipelineStepKinds ?? new Set(['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod']);
      const storageMock = { listJobs: () => jobs, probeJobStatus, reconcileStaleRelease, PIPELINE_STEP_KINDS: pipelineStepKinds };
      mockJobStorageModule(() => storageMock);
      return { probeJobStatus, reconcileStaleRelease };
    }

    function makeJob(kind: string, finishedAt: number | null = null) {
      return { id: `job-${kind}`, kind, finishedAt };
    }

    it('probes all running claude-backed jobs', async () => {
      const { probeJobStatus } = mockJobStorage([
        makeJob('run'),
        makeJob('review'),
        makeJob('fix'),
        makeJob('fix-ci'),
        makeJob('agent:my-agent'),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).toHaveBeenCalledTimes(5);
    });

    it('skips already-finished jobs', async () => {
      const { probeJobStatus } = mockJobStorage([
        makeJob('run', 1234567890),
        makeJob('review', null),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).toHaveBeenCalledTimes(1);
    });

    it('also probes pipeline-step kinds (test/commit/push)', async () => {
      // A Next.js restart between a pipeline step's exit and the next sweep
      // tick would otherwise strand these rows: probeJobStatus knows how to
      // reap them, but only if the sweep dispatches them.
      const { probeJobStatus } = mockJobStorage([
        makeJob('test'),
        makeJob('commit'),
        makeJob('push'),
        makeJob('run'),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).toHaveBeenCalledTimes(4);
    });

    it('swallows individual probe errors and continues probing remaining jobs', async () => {
      const probeJobStatus = vi.fn()
        .mockRejectedValueOnce(new Error('probe failed'))
        .mockResolvedValue(undefined);
      mockJobStorage([makeJob('run'), makeJob('review')], { probeJobStatus });
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await expect(runProbeSweep()).resolves.not.toThrow();
      expect(probeJobStatus).toHaveBeenCalledTimes(2);
    });

    it('swallows top-level errors when listJobs throws', async () => {
      mockJobStorageModule(() => ({
        listJobs: () => { throw new Error('db unavailable'); },
        probeJobStatus: vi.fn(),
      }));
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await expect(runProbeSweep()).resolves.not.toThrow();
    });

    it('still probes claude-backed jobs when PIPELINE_STEP_KINDS is unavailable', async () => {
      const probeJobStatus = vi.fn().mockResolvedValue(undefined);
      mockJobStorageModule(() => ({
        listJobs: () => [makeJob('run'), makeJob('review')],
        probeJobStatus,
      }));
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await expect(runProbeSweep()).resolves.not.toThrow();
      expect(probeJobStatus).toHaveBeenCalledTimes(2);
    });

    it('skips malformed jobs without a string kind', async () => {
      const { probeJobStatus } = mockJobStorage([
        { id: 'job-missing-kind', finishedAt: null },
        makeJob('run'),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await expect(runProbeSweep()).resolves.not.toThrow();
      expect(probeJobStatus).toHaveBeenCalledTimes(1);
    });

    it('does nothing when there are no running jobs', async () => {
      const { probeJobStatus } = mockJobStorage([]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).not.toHaveBeenCalled();
    });

    it('aborts expired release jobs by wall-clock deadline', async () => {
      const abortActiveRelease = vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });
      const releaseJob: {
        id: string;
        kind: string;
        finishedAt: number | null;
        project: string;
        startedAt: number;
        releaseDeadlineAt: number;
      } = {
        id: 'job-release',
        kind: 'release',
        finishedAt: null,
        project: 'my-project',
        startedAt: 1000,
        releaseDeadlineAt: Date.now() - 1000,
      };
      mockJobStorage([releaseJob], { pipelineStepKinds: new Set() });
      mockDeps([], { abortActiveRelease });

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(abortActiveRelease).toHaveBeenCalledWith('my-project', {
        reason: 'wall_clock_timeout',
        targetReleaseId: 'job-release',
      });
    });

    it('passes the specific expired release id when multiple releases exist for one project', async () => {
      const abortActiveRelease = vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });
      const activeRelease = {
        id: 'job-release-active',
        kind: 'release',
        finishedAt: null,
        project: 'my-project',
        startedAt: 2000,
        releaseDeadlineAt: Date.now() + 60_000,
      };
      const expiredRelease = {
        id: 'job-release-expired',
        kind: 'release',
        finishedAt: null,
        project: 'my-project',
        startedAt: 1000,
        releaseDeadlineAt: Date.now() - 1000,
      };
      mockJobStorage([activeRelease, expiredRelease], { pipelineStepKinds: new Set() });
      mockDeps([], { abortActiveRelease });

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(abortActiveRelease).toHaveBeenCalledTimes(1);
      expect(abortActiveRelease).toHaveBeenCalledWith('my-project', {
        reason: 'wall_clock_timeout',
        targetReleaseId: 'job-release-expired',
      });
    });

    // Note: the probe sweep used to also reconcile stale release meta-jobs
    // (where every child finished but `finishedAt` was still null). That
    // path was removed when the workflow runtime became the only release
    // owner — the runtime finalizes the release itself.

    it('during a DB outage still runs host-protection reapers but gates DB-only recovery work', async () => {
      // Regression guard: the reachability gate must NOT disable the CPU-core
      // reapers. They kill a runaway process group from in-memory state; only
      // their trailing markDone needs the DB. Skipping them during an outage
      // would let a runaway burn a core for the whole outage.
      const reapTimedOutClaudeJobs = vi.fn().mockResolvedValue([]);
      const reapRunCapExceededJobs = vi.fn().mockResolvedValue([]);
      const abortActiveRelease = vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });

      const expiredRelease = {
        id: 'job-release',
        kind: 'release',
        finishedAt: null,
        project: 'my-project',
        startedAt: 1000,
        releaseDeadlineAt: Date.now() - 1000,
      };
      mockJobStorage([expiredRelease], { pipelineStepKinds: new Set() });
      mockDeps([], { abortActiveRelease });

      // The reachability gate reports the DB as down for this tick.
      vi.doMock('@/lib/db/reachability', () => ({
        ensureDbReachable: async () => false,
        reportDbError: () => false,
        reportDbOk: () => {},
      }));
      vi.doMock('@/lib/jobs/test-timeout-reaper', () => ({ reapTimedOutClaudeJobs, killJobProcessGroup: vi.fn() }));
      vi.doMock('@/lib/jobs/run-cap-reaper', () => ({ reapRunCapExceededJobs }));

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      // Host protection ran despite the outage...
      expect(reapTimedOutClaudeJobs).toHaveBeenCalled();
      expect(reapRunCapExceededJobs).toHaveBeenCalled();
      // ...but the DB-only recovery work (release wall-clock abort) was gated off.
      expect(abortActiveRelease).not.toHaveBeenCalled();
    });
  });

  describe('drainStalePendingReleases()', () => {
    it('drains each unlocked pending project during boot recovery', async () => {
      const drainPendingReleaseMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/pending-release', () => ({
        listPendingReleaseProjects: vi.fn().mockReturnValue(['proj']),
        drainPendingRelease: drainPendingReleaseMock,
      }));
      vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
        getLock: vi.fn().mockReturnValue(null),
      }));
      const { drainStalePendingReleases } = await import('@/instrumentation-node');

      await drainStalePendingReleases();
      expect(drainPendingReleaseMock).toHaveBeenCalledWith('proj');
    });
  });

  // drainStaleQueuedAgentRuns and drainQueuedWorkAfterBudgetRecovery
  // were removed when the workflow runtime became the only release
  // path. Their tests are intentionally gone; the workflow runtime now
  // owns the queued-agent / budget-recovery drain concerns.
  //
  // The legacy `reinstallAgents()` boot pass was removed when graphile-cron
  // took over scheduled agents (lib/workflows/cron/*). Its tests are owned
  // by __tests__/lib/workflows/cron/{seed-agent-crons,agent-cron-task}.test.ts.
});
