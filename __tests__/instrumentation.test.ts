import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'My Agent',
    project: 'proj1',
    prompt: 'do stuff',
    schedule: '1h',
    runner: 'pm2',
    enabled: 1,
    ...overrides,
  };
}

function makeChainedDb(agents: unknown[]) {
  const all = vi.fn().mockReturnValue(agents);
  const from = vi.fn().mockReturnValue({ all });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, all };
}

describe('instrumentation', () => {
  let startInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let reconcilePm2SchedulesMock: ReturnType<typeof vi.fn>;
  let originalRuntime: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    startInternalSchedulerMock = vi.fn();
    reconcilePm2SchedulesMock = vi.fn().mockResolvedValue(undefined);
    originalRuntime = process.env.NEXT_RUNTIME;
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = originalRuntime;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function mockDeps(agents: unknown[]) {
    const chainedDb = makeChainedDb(agents);
    const dbMock = { db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } };
    const internalSchedulerMock = {
      startInternalScheduler: startInternalSchedulerMock,
      pauseInternalScheduler: vi.fn(),
      resumeInternalScheduler: vi.fn(),
    };
    const noopExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    vi.doMock('@/lib/db', () => dbMock);
    vi.doMock('./lib/db', () => dbMock);
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerMock);
    vi.doMock('./lib/scheduling/internal-scheduler', () => internalSchedulerMock);
    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      reconcilePm2Schedules: reconcilePm2SchedulesMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: noopExec }));
    vi.doMock('./lib/shared/shell', () => ({ exec: noopExec }));
    vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease: vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 }) }));
    vi.doMock('./lib/pipeline/release-abort', () => ({ abortActiveRelease: vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 }) }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((_a, b) => b), and: vi.fn((...args) => args) }));
  }

  describe('register()', () => {
    it('does nothing when NEXT_RUNTIME is not "nodejs"', async () => {
      process.env.NEXT_RUNTIME = 'edge';
      mockDeps([makeAgent()]);

      const { register } = await import('@/instrumentation');
      await register();
      await new Promise((r) => setImmediate(r));

      expect(startInternalSchedulerMock).not.toHaveBeenCalled();
    });

    it('fires reinstall in the background without blocking', async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      mockDeps([makeAgent({ id: 'agent-1', name: 'A', project: 'proj1', schedule: '2h', prompt: 'a' })]);

      const { register } = await import('@/instrumentation');
      const returned = register();
      await returned;
      // reinstallAgents is fire-and-forget (`void reinstallAgents()`) and chains
      // several dynamic imports — under load (full vitest suite) the 10ms wait
      // we used to use was too short. Poll until the scheduler is armed.
      await vi.waitFor(
        () => expect(startInternalSchedulerMock).toHaveBeenCalledTimes(1),
        { timeout: 2000 }
      );
    });
  });

  describe('registerNode()', () => {
    it('backfills issue-cruncher prerequisites during boot', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const backfillIssueCruncherPrerequisitesMock = vi.fn();

      vi.doMock('@/lib/agents/default-agent-skills', () => ({
        backfillIssueCruncherPrerequisites: backfillIssueCruncherPrerequisitesMock,
      }));
      vi.doMock('./lib/agents/default-agent-skills', () => ({
        backfillIssueCruncherPrerequisites: backfillIssueCruncherPrerequisitesMock,
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      expect(backfillIssueCruncherPrerequisitesMock).toHaveBeenCalledTimes(1);
    });

    it('resumes abandoned pr-wait inline jobs during boot instead of reaping them', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const listJobsMock = vi.fn().mockReturnValue([
        { id: 'pr-wait-1', kind: 'pr-wait', pid: 0, finishedAt: null, contextMeta: '{"prNumber":1}', project: 'proj1' },
      ]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumePrWaitMock = vi.fn().mockReturnValue({ ok: true });

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        markDone: markDoneMock,
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('./lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        markDone: markDoneMock,
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumePrWaitMock }));
      vi.doMock('./lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumePrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('./lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      await vi.waitFor(() => {
        expect(resumePrWaitMock).toHaveBeenCalledWith('pr-wait-1');
      }, { timeout: 2000 });
      expect(markDoneMock).not.toHaveBeenCalled();
    });

    it('reaps abandoned inline jobs when pr-wait resume fails', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDeps([]);
      const orphanedPrWait = { id: 'pr-wait-bad', kind: 'pr-wait', pid: 1234, finishedAt: null, contextMeta: '{', project: 'proj1' };
      const orphanedMarkDod = { id: 'mark-dod-1', kind: 'mark-dod', pid: 0, finishedAt: null, contextMeta: null, project: 'proj1' };
      const listJobsMock = vi.fn().mockReturnValue([orphanedPrWait, orphanedMarkDod]);
      const markDoneMock = vi.fn().mockResolvedValue(undefined);
      const resumePrWaitMock = vi.fn().mockReturnValue({ ok: false, error: 'malformed contextMeta' });

      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        markDone: markDoneMock,
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('./lib/jobs/job-storage', () => ({
        listJobs: listJobsMock,
        markDone: markDoneMock,
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));
      vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumePrWaitMock }));
      vi.doMock('./lib/pipeline/start-pr-wait', () => ({ resumePrWait: resumePrWaitMock }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('./lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork: vi.fn().mockResolvedValue(undefined),
      }));

      const { registerNode } = await import('@/instrumentation-node');
      await registerNode();

      await vi.waitFor(() => {
        expect(resumePrWaitMock).toHaveBeenCalledWith('pr-wait-bad');
        expect(markDoneMock).toHaveBeenCalledWith(orphanedPrWait, -1);
        expect(markDoneMock).toHaveBeenCalledWith(orphanedMarkDod, -1);
      }, { timeout: 2000 });
    });
  });

  describe('reapOrphanReleases()', () => {
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
      const lockGet = vi.fn().mockReturnValue(lockRow);
      const lockWhere = vi.fn().mockReturnValue({ get: lockGet });
      const deleteRun = vi.fn();
      const deleteWhere = vi.fn().mockReturnValue({ run: deleteRun });
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

      const storageMock = {
        listJobs: vi.fn(() => jobs),
        getJob: vi.fn((id: string) => byId.get(id) ?? null),
        markDone: markDoneMock,
        reconcileStaleRelease: reconcileStaleReleaseMock,
      };

      vi.doMock('@/lib/jobs/job-storage', () => storageMock);
      vi.doMock('./lib/jobs/job-storage', () => storageMock);
      // Also mock the non-barrel path so the barrel bypass doesn't fall through to real storage.ts
      vi.doMock('@/lib/jobs/storage', () => storageMock);
      vi.doMock('./lib/jobs/storage', () => storageMock);
      vi.doMock('@/lib/db', () => ({ db: dbMock, schema: { pipelineLocks: { project: 'project' } } }));
      vi.doMock('./lib/db', () => ({ db: dbMock, schema: { pipelineLocks: { project: 'project' } } }));
      vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
      vi.doMock('./lib/shared/shell', () => ({ exec: execMock }));
      vi.doMock('drizzle-orm', () => ({ eq: vi.fn((_a, b) => b) }));

      return { execMock, markDoneMock, reconcileStaleReleaseMock, deleteRun };
    }

    it('reconciles a stranded release from its newest finished child after the handoff grace', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const release: { id: string; project: string; kind: string; finishedAt: number | null; startedAt: number } = {
          id: 'release-1', project: 'proj', kind: 'release', finishedAt: null, startedAt: 100,
        };
        const push = { id: 'push-1', project: 'proj', kind: 'push', releaseId: 'release-1', finishedAt: 150, startedAt: 140 };
        const { markDoneMock, reconcileStaleReleaseMock } = mockOrphanReleaseDeps({
          jobs: [release, push],
          reconcileStaleReleaseMock: vi.fn().mockImplementation(async () => {
            release.finishedAt = 160;
          }),
        });

        const { reapOrphanReleases } = await import('@/instrumentation-node');
        await reapOrphanReleases();

        expect(reconcileStaleReleaseMock).toHaveBeenCalledWith(push);
        expect(markDoneMock).not.toHaveBeenCalled();
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
      const { execMock, markDoneMock, reconcileStaleReleaseMock } = mockOrphanReleaseDeps({
        jobs: [release],
      });

      const { reapOrphanReleases } = await import('@/instrumentation-node');
      await reapOrphanReleases();

      expect(reconcileStaleReleaseMock).not.toHaveBeenCalled();
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(markDoneMock).toHaveBeenCalledWith(release, -1);
    });
  });

  describe('reinstallAgents()', () => {
    it('arms the internal scheduler with all enabled scheduled agents', async () => {
      const agents = [
        makeAgent({ id: 'agent-1', name: 'A', project: 'proj1', schedule: '2h', runner: 'pm2', prompt: 'a' }),
        makeAgent({ id: 'agent-2', name: 'B', project: 'proj2', schedule: '30m', runner: 'launchctl', prompt: 'b' }),
      ];
      mockDeps(agents);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(startInternalSchedulerMock).toHaveBeenCalledTimes(1);
      const passed = startInternalSchedulerMock.mock.calls[0][0];
      expect(passed).toHaveLength(2);
      expect(passed[0]).toMatchObject({ id: 'agent-1', schedule: '2h', enabled: true, prompt: 'a' });
      expect(passed[1]).toMatchObject({ id: 'agent-2', schedule: '30m', enabled: true, prompt: 'b' });
    });

    it('filters out agents with no schedule even if returned by db.all()', async () => {
      mockDeps([makeAgent({ id: 'no-sched', schedule: null })]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(startInternalSchedulerMock).toHaveBeenCalledTimes(1);
      expect(startInternalSchedulerMock.mock.calls[0][0]).toHaveLength(0);
    });

    it('filters out disabled agents', async () => {
      mockDeps([makeAgent({ id: 'agent-off', schedule: '1h', enabled: 0 })]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(startInternalSchedulerMock.mock.calls[0][0]).toHaveLength(0);
    });

    it('sweeps any leftover PM2 cron entries (legacy cleanup)', async () => {
      mockDeps([makeAgent()]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(reconcilePm2SchedulesMock).toHaveBeenCalledOnce();
      // Called with empty array — the new model has zero PM2 cron entries by design.
      expect(reconcilePm2SchedulesMock).toHaveBeenCalledWith([]);
    });

    it('does nothing when no agents exist', async () => {
      mockDeps([]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(startInternalSchedulerMock).toHaveBeenCalledWith([]);
    });

    it('includes enabled scheduled file-based agents from enabled projects', async () => {
      vi.resetModules();
      startInternalSchedulerMock = vi.fn();
      reconcilePm2SchedulesMock = vi.fn().mockResolvedValue(undefined);

      const fileAgent = {
        id: 'file:proj1:daily-check',
        project: 'proj1',
        name: 'daily-check',
        schedule: '24h',
        prompt: 'run checks',
        enabled: true,
        runner: 'pm2',
      };
      const scanFileAgentsMock = vi.fn().mockReturnValue([fileAgent]);

      // Two-table DB: agents returns [], projects returns one enabled project.
      const allFn = vi.fn()
        .mockReturnValueOnce([])           // schema.agents query
        .mockReturnValueOnce([{ name: 'proj1', path: '/w/proj1' }]); // schema.projects query
      const whereFn = vi.fn().mockReturnValue({ all: allFn });
      const fromFn = vi.fn().mockImplementation((table) => {
        if (table === 'agents_table') return { all: allFn };
        return { where: whereFn, all: allFn };
      });
      const selectFn = vi.fn().mockReturnValue({ from: fromFn });
      const db = { select: selectFn };
      const schema = { agents: 'agents_table', projects: { enabled: 1 } };

      vi.doMock('@/lib/db', () => ({ db, schema }));
      vi.doMock('./lib/db', () => ({ db, schema }));
      const internalSchedulerMock = {
        startInternalScheduler: startInternalSchedulerMock,
        pauseInternalScheduler: vi.fn(),
        resumeInternalScheduler: vi.fn(),
      };
      vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('./lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('@/lib/scheduling/agent-scheduler', () => ({ reconcilePm2Schedules: reconcilePm2SchedulesMock }));
      vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('./lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('drizzle-orm', () => ({ eq: vi.fn((_a, b) => b) }));

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(startInternalSchedulerMock).toHaveBeenCalledTimes(1);
      const passed = startInternalSchedulerMock.mock.calls[0][0];
      expect(passed).toHaveLength(1);
      expect(passed[0]).toMatchObject({ id: 'file:proj1:daily-check', schedule: '24h', prompt: 'run checks' });
    });

    it('skips file agents that duplicate a DB agent with the same project+name', async () => {
      vi.resetModules();
      startInternalSchedulerMock = vi.fn();
      reconcilePm2SchedulesMock = vi.fn().mockResolvedValue(undefined);

      const dbAgent = makeAgent({ id: 'agent-db', name: 'shared', project: 'proj1', schedule: '4h', prompt: 'db version' });
      const fileAgent = {
        id: 'file:proj1:shared',
        project: 'proj1',
        name: 'shared',
        schedule: '4h',
        prompt: 'file version',
        enabled: true,
        runner: 'pm2',
      };
      const scanFileAgentsMock = vi.fn().mockReturnValue([fileAgent]);

      const allFn = vi.fn()
        .mockReturnValueOnce([dbAgent])
        .mockReturnValueOnce([{ name: 'proj1', path: '/w/proj1' }]);
      const whereFn = vi.fn().mockReturnValue({ all: allFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn, all: allFn });
      const selectFn = vi.fn().mockReturnValue({ from: fromFn });

      vi.doMock('@/lib/db', () => ({ db: { select: selectFn }, schema: { agents: {}, projects: { enabled: 1 } } }));
      vi.doMock('./lib/db', () => ({ db: { select: selectFn }, schema: { agents: {}, projects: { enabled: 1 } } }));
      const internalSchedulerMock = {
        startInternalScheduler: startInternalSchedulerMock,
        pauseInternalScheduler: vi.fn(),
        resumeInternalScheduler: vi.fn(),
      };
      vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('./lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('@/lib/scheduling/agent-scheduler', () => ({ reconcilePm2Schedules: reconcilePm2SchedulesMock }));
      vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('./lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('drizzle-orm', () => ({ eq: vi.fn((_a, b) => b) }));

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      const passed = startInternalSchedulerMock.mock.calls[0][0];
      // Only the DB agent; file agent is suppressed because project+name collides.
      expect(passed).toHaveLength(1);
      expect(passed[0].id).toBe('agent-db');
    });

    it('skips file agents that have no schedule or are disabled', async () => {
      vi.resetModules();
      startInternalSchedulerMock = vi.fn();
      reconcilePm2SchedulesMock = vi.fn().mockResolvedValue(undefined);

      const noSchedule = { id: 'file:p:a', project: 'p', name: 'a', schedule: null, prompt: '', enabled: true, runner: 'pm2' };
      const disabled = { id: 'file:p:b', project: 'p', name: 'b', schedule: '1h', prompt: '', enabled: false, runner: 'pm2' };
      const scanFileAgentsMock = vi.fn().mockReturnValue([noSchedule, disabled]);

      const allFn = vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ name: 'p', path: '/w/p' }]);
      const whereFn = vi.fn().mockReturnValue({ all: allFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn, all: allFn });
      const selectFn = vi.fn().mockReturnValue({ from: fromFn });

      vi.doMock('@/lib/db', () => ({ db: { select: selectFn }, schema: { agents: {}, projects: { enabled: 1 } } }));
      vi.doMock('./lib/db', () => ({ db: { select: selectFn }, schema: { agents: {}, projects: { enabled: 1 } } }));
      const internalSchedulerMock = {
        startInternalScheduler: startInternalSchedulerMock,
        pauseInternalScheduler: vi.fn(),
        resumeInternalScheduler: vi.fn(),
      };
      vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('./lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('@/lib/scheduling/agent-scheduler', () => ({ reconcilePm2Schedules: reconcilePm2SchedulesMock }));
      vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('./lib/agents/tamtam-file-agents', () => ({ scanFileAgents: scanFileAgentsMock }));
      vi.doMock('drizzle-orm', () => ({ eq: vi.fn((_a, b) => b) }));

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      const passed = startInternalSchedulerMock.mock.calls[0][0];
      expect(passed).toHaveLength(0);
    });
  });

  describe('runProbeSweep()', () => {
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
      const pipelineStepKinds = options.pipelineStepKinds ?? new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']);
      vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: () => jobs, probeJobStatus, reconcileStaleRelease, PIPELINE_STEP_KINDS: pipelineStepKinds }));
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
        makeJob('fix-push'),
        makeJob('agent:my-agent'),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).toHaveBeenCalledTimes(6);
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

    it('also probes pipeline-step kinds (test/commit/push/fix-push)', async () => {
      // A Next.js restart between a pipeline step's exit and the next sweep
      // tick would otherwise strand these rows: probeJobStatus knows how to
      // reap them, but only if the sweep dispatches them.
      const { probeJobStatus } = mockJobStorage([
        makeJob('test'),
        makeJob('commit'),
        makeJob('push'),
        makeJob('fix-push'),
        makeJob('run'),
      ]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(probeJobStatus).toHaveBeenCalledTimes(5);
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
      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: () => { throw new Error('db unavailable'); },
        probeJobStatus: vi.fn(),
      }));
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await expect(runProbeSweep()).resolves.not.toThrow();
    });

    it('still probes claude-backed jobs when PIPELINE_STEP_KINDS is unavailable', async () => {
      const probeJobStatus = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/jobs/job-storage', () => ({
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

    it('reconciles stale release jobs via a finished step job', async () => {
      const releaseJob = { id: 'job-release', kind: 'release', finishedAt: null, project: 'my-project', startedAt: 1000 };
      const stepJob = { id: 'job-review', kind: 'review', finishedAt: 2000, project: 'my-project', startedAt: 1010 };
      const { reconcileStaleRelease } = mockJobStorage([releaseJob, stepJob]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(reconcileStaleRelease).toHaveBeenCalledWith(stepJob);
    });

    it('skips release reconciliation when no finished step jobs exist', async () => {
      const releaseJob = { id: 'job-release', kind: 'release', finishedAt: null, project: 'my-project', startedAt: 1000 };
      const { reconcileStaleRelease } = mockJobStorage([releaseJob]);
      mockDeps([]);

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(reconcileStaleRelease).not.toHaveBeenCalled();
    });

    it('aborts expired release jobs before reconciling stale releases', async () => {
      const abortActiveRelease = vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });
      const reconcileStaleRelease = vi.fn().mockResolvedValue(undefined);
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
      mockJobStorage([releaseJob], { reconcileStaleRelease, pipelineStepKinds: new Set() });
      mockDeps([]);
      vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease }));
      vi.doMock('./lib/pipeline/release-abort', () => ({ abortActiveRelease }));

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(abortActiveRelease).toHaveBeenCalledWith('my-project', {
        reason: 'wall_clock_timeout',
        targetReleaseId: 'job-release',
      });
      expect(reconcileStaleRelease).not.toHaveBeenCalled();
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
      mockDeps([]);
      vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease }));
      vi.doMock('./lib/pipeline/release-abort', () => ({ abortActiveRelease }));

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(abortActiveRelease).toHaveBeenCalledTimes(1);
      expect(abortActiveRelease).toHaveBeenCalledWith('my-project', {
        reason: 'wall_clock_timeout',
        targetReleaseId: 'job-release-expired',
      });
    });

    it('reconciles expired releases with completed child steps before timeout aborting', async () => {
      const abortActiveRelease = vi.fn().mockResolvedValue({ status: 'aborted', httpStatus: 200 });
      const reconcileStaleRelease = vi.fn().mockImplementation(async (step) => {
        releaseJob.finishedAt = 3000;
        expect(step.id).toBe('review-1');
      });
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
      const completedReview = {
        id: 'review-1',
        kind: 'review',
        finishedAt: 2000,
        project: 'my-project',
        startedAt: 1500,
      };
      mockJobStorage([releaseJob, completedReview], {
        reconcileStaleRelease,
        pipelineStepKinds: new Set(['review']),
      });
      mockDeps([]);
      vi.doMock('@/lib/pipeline/release-abort', () => ({ abortActiveRelease }));
      vi.doMock('./lib/pipeline/release-abort', () => ({ abortActiveRelease }));

      const { runProbeSweep } = await import('@/instrumentation-node');
      await runProbeSweep();

      expect(reconcileStaleRelease).toHaveBeenCalledWith(completedReview);
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

  describe('boot recovery guards', () => {
    it('skips legacy workflow migration when settings table is unavailable', async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      const allFn = vi.fn()
        .mockReturnValueOnce([makeAgent()])
        .mockReturnValueOnce([]);
      const whereFn = vi.fn().mockReturnValue({ all: allFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn, all: allFn });
      const selectFn = vi.fn().mockReturnValue({ from: fromFn });
      vi.doMock('@/lib/db', () => ({
        db: { select: selectFn },
        schema: {
          agents: { schedule: 'schedule', enabled: 'enabled' },
          projects: { enabled: 1 },
        },
      }));
      vi.doMock('./lib/db', () => ({
        db: { select: selectFn },
        schema: {
          agents: { schedule: 'schedule', enabled: 'enabled' },
          projects: { enabled: 1 },
        },
      }));
      const internalSchedulerMock = {
        startInternalScheduler: startInternalSchedulerMock,
        pauseInternalScheduler: vi.fn(),
        resumeInternalScheduler: vi.fn(),
      };
      vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('./lib/scheduling/internal-scheduler', () => internalSchedulerMock);
      vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
        reconcilePm2Schedules: reconcilePm2SchedulesMock,
      }));
      vi.doMock('drizzle-orm', () => ({ eq: vi.fn((_a, b) => b) }));
      vi.doMock('@/lib/pipeline/pending-release', () => ({
        listPendingReleaseProjects: vi.fn().mockReturnValue([]),
        drainPendingRelease: vi.fn(),
      }));
      vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
        getLock: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('@/lib/agents/queued-agent-runs', () => ({
        drainQueuedAgentRunsForUnlockedProjects: vi.fn(),
      }));
      vi.doMock('@/lib/jobs/job-storage', () => ({
        listJobs: () => [],
        getJob: vi.fn().mockReturnValue(null),
        markDone: vi.fn().mockResolvedValue(undefined),
        probeJobStatus: vi.fn(),
        reconcileStaleRelease: vi.fn(),
        PIPELINE_STEP_KINDS: new Set(),
      }));

      const { register } = await import('@/instrumentation');
      await expect(register()).resolves.not.toThrow();
      await vi.waitFor(
        () => expect(startInternalSchedulerMock).toHaveBeenCalledTimes(1),
        { timeout: 2000 }
      );
    });

    it('skips queued-agent boot drain when queued-agent schema is unavailable', async () => {
      vi.doMock('@/lib/db', () => ({ db: { select: vi.fn() }, schema: {} }));
      vi.doMock('./lib/db', () => ({ db: { select: vi.fn() }, schema: {} }));
      const drainUnlockedQueuedAgentRuns = vi.fn();
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainUnlockedQueuedAgentRuns,
      }));

      const { drainStaleQueuedAgentRuns } = await import('@/instrumentation-node');
      await expect(drainStaleQueuedAgentRuns()).resolves.not.toThrow();
      expect(drainUnlockedQueuedAgentRuns).not.toHaveBeenCalled();
    });

    it('drains unlocked queued agents through the shared helper when schema exists', async () => {
      vi.doMock('@/lib/db', () => ({
        db: { select: vi.fn() },
        schema: { queuedAgentRuns: { project: 'project' } },
      }));
      vi.doMock('./lib/db', () => ({
        db: { select: vi.fn() },
        schema: { queuedAgentRuns: { project: 'project' } },
      }));
      const drainUnlockedQueuedAgentRuns = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainUnlockedQueuedAgentRuns,
      }));

      const { drainStaleQueuedAgentRuns } = await import('@/instrumentation-node');
      await expect(drainStaleQueuedAgentRuns()).resolves.not.toThrow();
      expect(drainUnlockedQueuedAgentRuns).toHaveBeenCalledWith('[boot][queued-agent-runs]');
    });

    it('drains pending releases and queued agents when budget recovers', async () => {
      const drainAllRecoveryWork = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainAllRecoveryWork,
      }));

      const mod = await import('@/instrumentation-node');
      await expect(mod.drainQueuedWorkAfterBudgetRecovery()).resolves.not.toThrow();
      expect(drainAllRecoveryWork).toHaveBeenCalledWith('[budget-drain]');
    });
  });
});
