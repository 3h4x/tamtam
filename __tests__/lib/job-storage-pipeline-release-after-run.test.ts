import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { sharedHandle } from './job-storage-pipeline-fixtures';

describe('runCompletionHooks – release-after-run', () => {
  // Hoist mocks + module import once. Stable refs let beforeEach mockReset()
  // without paying for a per-test module reload. The 2 outlier tests
  // (`releaseAfterRun: null`, `schedulingModuleThrows: true`) opt into a
  // reload via `loadMarkDone(...)`; everything else uses the fast path.
  const startReleaseMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const execMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let jobSeq = 0;
  // Outlier tests that call `loadMarkDone(...)` swap in a non-default module
  // factory (e.g. scheduling throws on import). Subsequent default tests must
  // reload to get back to a clean import graph; we cheap-track that here.
  let dirty = false;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind.replace(':', '-')}-rar-test-${++jobSeq}`,
      project: 'my-proj',
      kind,
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

  function resetMocksToDefaults(releaseAfterRun: boolean | null = true): void {
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, step: 'review', jobId: 'rel-1', releaseJobId: 'rel-job-1', message: 'Running review' });
    getProjectTestConfigMock.mockReset().mockReturnValue(
      releaseAfterRun === null
        ? null
        : { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun }
    );
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }

  // Slow path: only the 2 tests that exercise a different module-load shape
  // (no scheduling config row, or scheduling module throws on import) need
  // this — they reload the job-storage module with a different mock factory.
  async function loadMarkDone({
    releaseAfterRun = true,
    schedulingModuleThrows = false,
  }: {
    releaseAfterRun?: boolean | null;
    schedulingModuleThrows?: boolean;
  } = {}) {
    // Mark dirty whenever a non-default factory shape is requested so the
    // next default `beforeEach` knows it must reload the module rather than
    // just mockReset()-ing.
    dirty = releaseAfterRun !== true || schedulingModuleThrows;
    vi.resetModules();
    resetMocksToDefaults(releaseAfterRun);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    if (schedulingModuleThrows) {
      vi.doMock('@/lib/scheduling/scheduling', () => {
        throw new Error('failed to load scheduling');
      });
    } else {
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getProjectTestConfig: getProjectTestConfigMock,
      }));
    }
    // The release-after-run hook now goes through the workflow runtime
    // (`dispatchReleaseWorkflow` → `start(releaseWorkflow, ...)`). Mock the
    // workflow dispatch helper to keep these tests pure (no real workflow
    // runtime spin-up). The legacy `start-release` mock stays in place too
    // for any path that still calls it directly.
    vi.doMock('@/lib/workflows/dispatch-release', () => ({
      dispatchReleaseWorkflow: (project: string, opts: unknown) => startReleaseMock(project, opts),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: startReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
  }

  beforeAll(async () => {
    await loadMarkDone();
    dirty = false;
  });

  beforeEach(async () => {
    if (dirty) {
      await loadMarkDone();
      dirty = false;
      return;
    }
    storageCache.clear();
    resetVerdictCache();
    resetMocksToDefaults();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.resetModules();
  });

  it('triggers startRelease after run job finishes with exit 0 when releaseAfterRun=true', async () => {
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: job.id,
    });
  });

  it('skips startRelease after agent:x when finalize left no changed files (idle-cycle)', async () => {
    // markDone runs finalizeAgentRunReport before the release-after-run
    // hook, which reads the worktree via the mocked git exec. With the
    // default empty-stdout mock the agent has produced nothing, and the
    // new shippable-change gate must skip the release dispatch. Without
    // this gate the legacy behavior fired an empty release every cycle.
    const job = makeJob('agent:my-agent');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('skips startRelease after agent:x when finalize only saw dirty-baseline files', async () => {
    // Realistic case: agent did NOT commit (BASE..HEAD empty), the only
    // file in the worktree was the same one already dirty in the baseline.
    // Per-file attribution marks it low confidence; the gate then skips
    // the release-after-run dispatch.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/pre-existing.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/pre-existing.ts\n', stderr: '' });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    expect(job.modifiedFiles).toBe(JSON.stringify([
      { path: 'src/pre-existing.ts', status: 'M', confidence: 'low' },
    ]));
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('skips startRelease after agent:x when dirty-baseline run only sees an unrelated commit', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/unrelated-commit.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '13\t4\tsrc/unrelated-commit.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    expect(job.modifiedFiles).toBe(JSON.stringify([
      { path: 'src/unrelated-commit.ts', status: 'M', confidence: 'low' },
    ]));
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('triggers startRelease after agent:x adds a NEW file even on a dirty baseline', async () => {
    // The autonomy fix: a stale dirty file in the worktree must not prevent
    // the orchestrator from releasing changes the agent legitimately made
    // on top of it. Per-file attribution marks the new file high confidence;
    // the gate accepts it; release dispatches.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/pre-existing.ts\n?? src/new-from-agent.md\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '99\t12\tsrc/pre-existing.ts\n8\t0\tsrc/new-from-agent.md\n',
        stderr: '',
      });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    // The new file lands as high-confidence; pre-existing stays low.
    const files = JSON.parse(job.modifiedFiles ?? '[]') as Array<Record<string, unknown>>;
    expect(files).toContainEqual({ path: 'src/new-from-agent.md', status: '??', confidence: 'high' });
    expect(files).toContainEqual({ path: 'src/pre-existing.ts', status: 'M', confidence: 'low' });
    // Only the new file's LOC counts; pre-existing 99/12 is filtered.
    expect(job.linesAdded).toBe(8);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: job.id,
    });
  });

  it('triggers startRelease after fix-ci job finishes with exit 0', async () => {
    const job = makeJob('fix-ci', { id: 'fix-ci-rar-test' });
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'fix-ci-rar-test',
    });
  });

  it('preserves pending release intent when fix-ci release chaining is temporarily blocked', async () => {
    shouldKeepPendingReleaseMock.mockReturnValue(true);
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Release pipeline already running for my-proj',
    });
    const job = makeJob('fix-ci', { id: 'fix-ci-pending-test' });

    await markDoneFn(job, 0);

    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'fix-ci-pending-test',
    });
    expect(shouldKeepPendingReleaseMock).toHaveBeenCalledWith({
      ok: false,
      status: 409,
      detail: 'Release pipeline already running for my-proj',
    });
    expect(setPendingReleaseMock).toHaveBeenCalledWith('my-proj');
  });

  it('does not trigger startRelease when run job exits non-zero', async () => {
    const job = makeJob('run');
    await markDoneFn(job, 1);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when releaseAfterRun=false', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when the project has no config row', async () => {
    await loadMarkDone({ releaseAfterRun: null });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when the scheduling module import fails', async () => {
    await loadMarkDone({ schedulingModuleThrows: true });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for test kind', async () => {
    const job = makeJob('test');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for review kind', async () => {
    const job = makeJob('review');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for push kind', async () => {
    const job = makeJob('push');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startRelease throws', async () => {
    startReleaseMock.mockRejectedValue(new Error('release service down'));
    const job = makeJob('run');
    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });
});
