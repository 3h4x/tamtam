import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function baseJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'proj-run-1',
    project: 'proj',
    kind: 'run',
    prompt: null,
    pid: 1,
    logPath: '/tmp/x.log',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
    seen: false,
    durationMs: 1000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    sessionId: null,
    contextMeta: null,
    userPrompt: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    releaseId: null,
    releaseDeadlineAt: null,
    workSummary: null,
    modifiedFiles: null,
    provider: null,
    ...overrides,
  } as JobData;
}

function mockDeps({
  releaseAfterRun,
  dispatchResult,
  shouldKeep = false,
}: {
  releaseAfterRun: boolean;
  dispatchResult?: { ok: boolean; jobId?: string; status?: string; detail?: string };
  shouldKeep?: boolean;
}) {
  const dispatchReleaseWorkflow = vi.fn().mockResolvedValue(dispatchResult ?? { ok: true, jobId: 'release-1' });
  const setPendingRelease = vi.fn();
  const shouldKeepPendingRelease = vi.fn().mockReturnValue(shouldKeep);

  vi.doMock('@/lib/scheduling/scheduling', () => ({
    getProjectTestConfig: vi.fn().mockResolvedValue({
      autoCommitEnabled: false,
      autoPushEnabled: false,
      releaseAfterRun,
    }),
  }));
  vi.doMock('@/lib/workflows/dispatch-release', () => ({ dispatchReleaseWorkflow }));
  vi.doMock('@/lib/pipeline/pending-release', () => ({ setPendingRelease, shouldKeepPendingRelease }));

  return { dispatchReleaseWorkflow, setPendingRelease, shouldKeepPendingRelease };
}

describe('dispatchReleaseAfterRun', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('skips issue work (agent:issue-cruncher)', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({ releaseAfterRun: true });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob({ kind: 'agent:issue-cruncher', ghIssueNumber: 42 }));
    expect(out.dispatched).toBe(false);
    expect(out.reason).toMatch(/issue-work/);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('skips run jobs linked to a GitHub issue', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({ releaseAfterRun: true });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob({ kind: 'run', ghIssueNumber: 7 }));
    expect(out.dispatched).toBe(false);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('skips when releaseAfterRun project flag is false', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({ releaseAfterRun: false });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob());
    expect(out.dispatched).toBe(false);
    expect(out.reason).toMatch(/releaseAfterRun=false/);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('skips on non-zero exit code', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({ releaseAfterRun: true });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob({ exitCode: 1 }));
    expect(out.dispatched).toBe(false);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('dispatches when run succeeds and flag is on', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({
      releaseAfterRun: true,
      dispatchResult: { ok: true, jobId: 'release-99' },
    });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob());
    expect(out.dispatched).toBe(true);
    expect(out.reason).toMatch(/release-99/);
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith('proj', { queueIfBlocked: true, sourceJobId: 'proj-run-1' });
  });

  it('reports queued status without claiming dispatched', async () => {
    mockDeps({
      releaseAfterRun: true,
      dispatchResult: { ok: true, status: 'queued' },
    });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob());
    expect(out.dispatched).toBe(false);
    expect(out.reason).toMatch(/queued/);
  });

  it('stamps pending-release when dispatch fails but is retryable', async () => {
    const { setPendingRelease } = mockDeps({
      releaseAfterRun: true,
      dispatchResult: { ok: false, detail: 'lock held' },
      shouldKeep: true,
    });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob());
    expect(out.dispatched).toBe(false);
    expect(setPendingRelease).toHaveBeenCalledWith('proj');
    expect(out.reason).toMatch(/pending/);
  });

  it('does not stamp pending-release on non-retryable failures', async () => {
    const { setPendingRelease } = mockDeps({
      releaseAfterRun: true,
      dispatchResult: { ok: false, detail: 'Nothing to release' },
      shouldKeep: false,
    });
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(baseJob());
    expect(out.dispatched).toBe(false);
    expect(setPendingRelease).not.toHaveBeenCalled();
  });
});
