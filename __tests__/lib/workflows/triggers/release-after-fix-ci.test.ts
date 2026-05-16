import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function baseJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'proj-fix-ci-1',
    project: 'proj',
    kind: 'fix-ci',
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
  dispatchResult,
  shouldKeep = false,
}: {
  dispatchResult?: { ok: boolean; jobId?: string; status?: string; detail?: string };
  shouldKeep?: boolean;
} = {}) {
  const dispatchReleaseWorkflow = vi.fn().mockResolvedValue(dispatchResult ?? { ok: true, jobId: 'release-1' });
  const setPendingRelease = vi.fn();
  const shouldKeepPendingRelease = vi.fn().mockReturnValue(shouldKeep);
  vi.doMock('@/lib/workflows/dispatch-release', () => ({ dispatchReleaseWorkflow }));
  vi.doMock('@/lib/pipeline/pending-release', () => ({ setPendingRelease, shouldKeepPendingRelease }));
  return { dispatchReleaseWorkflow, setPendingRelease };
}

describe('dispatchReleaseAfterFixCi', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('skips non-fix-ci kinds', async () => {
    const { dispatchReleaseWorkflow } = mockDeps();
    const { dispatchReleaseAfterFixCi } = await import('@/lib/workflows/triggers/release-after-fix-ci');
    const out = await dispatchReleaseAfterFixCi(baseJob({ kind: 'run' }));
    expect(out.dispatched).toBe(false);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('skips non-zero exit', async () => {
    const { dispatchReleaseWorkflow } = mockDeps();
    const { dispatchReleaseAfterFixCi } = await import('@/lib/workflows/triggers/release-after-fix-ci');
    const out = await dispatchReleaseAfterFixCi(baseJob({ exitCode: 1 }));
    expect(out.dispatched).toBe(false);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it('dispatches a release on successful fix-ci', async () => {
    const { dispatchReleaseWorkflow } = mockDeps({ dispatchResult: { ok: true, jobId: 'release-77' } });
    const { dispatchReleaseAfterFixCi } = await import('@/lib/workflows/triggers/release-after-fix-ci');
    const out = await dispatchReleaseAfterFixCi(baseJob());
    expect(out.dispatched).toBe(true);
    expect(out.reason).toMatch(/release-77/);
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith('proj', { queueIfBlocked: true, sourceJobId: 'proj-fix-ci-1' });
  });

  it('stamps pending-release when dispatch fails retryably', async () => {
    const { setPendingRelease } = mockDeps({
      dispatchResult: { ok: false, detail: 'lock held' },
      shouldKeep: true,
    });
    const { dispatchReleaseAfterFixCi } = await import('@/lib/workflows/triggers/release-after-fix-ci');
    const out = await dispatchReleaseAfterFixCi(baseJob());
    expect(out.dispatched).toBe(false);
    expect(setPendingRelease).toHaveBeenCalledWith('proj');
  });
});
