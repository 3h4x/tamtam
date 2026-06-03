import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

// Mocks for the dynamic imports inside dispatchReleaseAfterRun.
const dispatchRelease = vi.fn();
const worktreeLineDelta = vi.fn();
const redispatch = vi.fn();
const decidePrContext = vi.fn();
let settings: { release_min_lines: number; release_reinforce_max_iterations: number };

vi.mock('@/lib/workflows/dispatch-release', () => ({
  dispatchReleaseWorkflow: (...a: unknown[]) => dispatchRelease(...a),
}));
vi.mock('@/lib/git/worktree-line-delta', () => ({
  worktreeLineDelta: (...a: unknown[]) => worktreeLineDelta(...a),
}));
vi.mock('@/lib/shared/config', () => ({ getSettings: () => settings }));
vi.mock('@/lib/shared/project-data', () => ({ resolveProjectPath: () => '/tmp/proj' }));
vi.mock('@/lib/pipeline/pr-context', () => ({
  decidePrContext: (...a: unknown[]) => decidePrContext(...a),
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getProjectTestConfig: async () => ({ releaseAfterRun: true }),
}));
vi.mock('@/lib/workflows/triggers/reinforce-state', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    redispatchAgentForReinforce: (...a: unknown[]) => redispatch(...a),
    getJobAgentId: async () => 'a1',
  };
});

import { dispatchReleaseAfterRun } from '@/lib/workflows/triggers/release-after-run';
import { clearReinforceState } from '@/lib/workflows/triggers/reinforce-state';

function agentJob(over: Partial<JobData> = {}): JobData {
  return {
    id: 'j1',
    kind: 'agent:coder',
    project: 'proj',
    exitCode: 0,
    linesAdded: 1,
    linesRemoved: 0,
    modifiedFiles: '[{"path":"x","confidence":"high"}]',
    ghIssueNumber: null,
    ...over,
  } as unknown as JobData;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReinforceState('proj');
  settings = { release_min_lines: 20, release_reinforce_max_iterations: 3 };
  dispatchRelease.mockResolvedValue({ ok: true, jobId: 'rel1' });
  redispatch.mockResolvedValue(true);
  decidePrContext.mockResolvedValue({
    shouldOpenPr: false,
    reason: "current branch 'main' matches default 'main'",
    currentBranch: 'main',
    defaultBranch: 'main',
  });
});

describe('dispatchReleaseAfterRun reinforce gate', () => {
  it('releases immediately when release_min_lines is 0', async () => {
    settings.release_min_lines = 0;
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(out.dispatched).toBe(true);
    expect(worktreeLineDelta).not.toHaveBeenCalled();
  });

  it('releases when LOC >= threshold', async () => {
    worktreeLineDelta.mockResolvedValue(25);
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(out.dispatched).toBe(true);
    expect(dispatchRelease).toHaveBeenCalled();
  });

  it('reinforces (no release) when below threshold with progress and under cap', async () => {
    worktreeLineDelta.mockResolvedValue(5);
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(out.dispatched).toBe(false);
    expect(out.reason).toMatch(/reinforc/i);
    expect(decidePrContext).toHaveBeenCalledWith('/tmp/proj');
    expect(redispatch).toHaveBeenCalledOnce();
    expect(dispatchRelease).not.toHaveBeenCalled();
  });

  it('releases non-default branch work instead of reinforcing so PR handling can run', async () => {
    decidePrContext.mockResolvedValue({
      shouldOpenPr: true,
      reason: "current branch 'feature/x' differs from default 'main'",
      currentBranch: 'feature/x',
      defaultBranch: 'main',
    });
    worktreeLineDelta.mockResolvedValue(5);
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(worktreeLineDelta).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(dispatchRelease).toHaveBeenCalledWith('proj', { queueIfBlocked: true, sourceJobId: 'j1' });
    expect(out.dispatched).toBe(true);
  });

  it('releases when below threshold but no progress (loc <= lastSeen)', async () => {
    worktreeLineDelta.mockResolvedValue(5);
    await dispatchReleaseAfterRun(agentJob());
    redispatch.mockClear();
    dispatchRelease.mockClear();
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(redispatch).not.toHaveBeenCalled();
    expect(dispatchRelease).toHaveBeenCalled();
    expect(out.dispatched).toBe(true);
  });

  it('releases when iteration cap reached', async () => {
    settings.release_reinforce_max_iterations = 1;
    worktreeLineDelta.mockResolvedValue(5); // iter 1: reinforce
    await dispatchReleaseAfterRun(agentJob());
    redispatch.mockClear();
    dispatchRelease.mockClear();
    worktreeLineDelta.mockResolvedValue(8); // progress, but cap=1 reached -> release
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(redispatch).not.toHaveBeenCalled();
    expect(dispatchRelease).toHaveBeenCalled();
    expect(out.dispatched).toBe(true);
  });

  it('does not reinforce non-agent run jobs', async () => {
    worktreeLineDelta.mockResolvedValue(5);
    const out = await dispatchReleaseAfterRun(agentJob({ kind: 'run' }));
    expect(redispatch).not.toHaveBeenCalled();
    expect(dispatchRelease).toHaveBeenCalled();
    expect(out.dispatched).toBe(true);
  });

  it('releases (no reinforce) when re-dispatch is not accepted', async () => {
    worktreeLineDelta.mockResolvedValue(5);
    redispatch.mockResolvedValue(false); // queued/failed
    const out = await dispatchReleaseAfterRun(agentJob());
    expect(dispatchRelease).toHaveBeenCalled();
    expect(out.dispatched).toBe(true);
  });
});
