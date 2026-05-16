import { describe, it, expect, beforeEach, vi } from 'vitest';

const startMock = vi.fn();
const settingsState = vi.hoisted(() => ({ plainTestPhaseEnabled: false }));

vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => startMock(...args),
}));

// Mock each phase workflow module so we can identify which one start() was
// called with (the function reference is the workflow identifier).
const phaseFns = {
  test: vi.fn(),
  pnpmTest: vi.fn(),
  review: vi.fn(),
  fix: vi.fn(),
  push: vi.fn(),
  markDod: vi.fn(),
  prWait: vi.fn(),
};
vi.mock('@/lib/workflows/phases/test-phase', () => ({ releaseTestPhaseWorkflow: phaseFns.test }));
vi.mock('@/lib/workflows/phases/pnpm-test-phase', () => ({ pnpmTestPhaseWorkflow: phaseFns.pnpmTest }));
vi.mock('@/lib/workflows/phases/review-phase', () => ({ releaseReviewPhaseWorkflow: phaseFns.review }));
vi.mock('@/lib/workflows/phases/fix-phase', () => ({ releaseFixPhaseWorkflow: phaseFns.fix }));
vi.mock('@/lib/workflows/phases/push-phase', () => ({ releasePushPhaseWorkflow: phaseFns.push }));
vi.mock('@/lib/workflows/phases/mark-dod-phase', () => ({ releaseMarkDodPhaseWorkflow: phaseFns.markDod }));
vi.mock('@/lib/workflows/phases/pr-wait-phase', () => ({ releasePrWaitPhaseWorkflow: phaseFns.prWait }));
vi.mock('@/lib/shared/config', () => ({
  getSettings: () => ({
    plain_test_phase_enabled: settingsState.plainTestPhaseEnabled,
    review_fix_backoff_seconds: 0,
  }),
}));

const listJobsMock = vi.fn(() => [] as Array<Record<string, unknown>>);
vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: () => listJobsMock(),
}));

import { dispatchPhase } from '@/lib/workflows/dispatch-phase';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';

describe('dispatchPhase', () => {
  beforeEach(() => {
    startMock.mockReset().mockResolvedValue({ runId: 'wrun_child_1' });
    settingsState.plainTestPhaseEnabled = false;
    listJobsMock.mockReset().mockReturnValue([]);
  });

  it('returns terminal for next=done without dispatching', async () => {
    const r = await dispatchPhase({ next: 'done', from: 'mark-dod' }, { projectName: 'p' });
    expect(r).toEqual({ dispatched: false, reason: 'terminal', phase: 'done' });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns terminal for next=abort without dispatching', async () => {
    const r = await dispatchPhase(
      { next: 'abort', from: 'review', verdict: 'DO NOT SHIP' },
      { projectName: 'p' },
    );
    expect(r).toEqual({ dispatched: false, reason: 'terminal', phase: 'abort' });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns terminal for next=unknown without dispatching', async () => {
    const r = await dispatchPhase(
      { next: 'unknown', from: 'release', reason: 'no rule' },
      { projectName: 'p' },
    );
    expect(r).toEqual({ dispatched: false, reason: 'terminal', phase: 'unknown' });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('dispatches releaseReviewPhaseWorkflow for next=review (with releaseJobId for re-dispatch)', async () => {
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', parentJobId: 'release-meta-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.review, ['test-tt', 'release-meta-1']);
    expect(r).toEqual({ dispatched: true, phase: 'review', childRunId: 'wrun_child_1' });
  });

  it('passes undefined releaseJobId when parentJobId is not set', async () => {
    const decision: NextPhase = { next: 'review', from: 'test' };
    await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.review, ['test-tt', undefined]);
  });

  it('dispatches releaseFixPhaseWorkflow for next=fix with prevJobId (forwards projectName + releaseJobId for re-dispatch)', async () => {
    const decision: NextPhase = { next: 'fix', from: 'test', testExitCode: 1 };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', prevJobId: 'test-job-1', parentJobId: 'release-meta-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.fix, ['test-job-1', 'test-tt', 'release-meta-1']);
    expect(r).toEqual({ dispatched: true, phase: 'fix', childRunId: 'wrun_child_1' });
  });

  it('reports missing_context for next=fix without prevJobId', async () => {
    const decision: NextPhase = { next: 'fix', from: 'test', testExitCode: 1 };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      dispatched: false,
      reason: 'missing_context',
      phase: 'fix',
      missing: ['prevJobId'],
    });
  });

  it('dispatches releasePushPhaseWorkflow for next=push (forwards releaseJobId for re-dispatch)', async () => {
    const decision: NextPhase = { next: 'push', from: 'commit' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', parentJobId: 'release-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.push, ['test-tt', { parentJobId: 'release-1' }, 'release-1']);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releaseFixPhaseWorkflow for next=fix from a push source (unified fix)', async () => {
    const decision: NextPhase = { next: 'fix', from: 'push' };
    const r = await dispatchPhase(decision, {
      projectName: 'test-tt',
      prevJobId: 'push-job-1',
      parentJobId: 'release-1',
    });
    expect(startMock).toHaveBeenCalledWith(phaseFns.fix, ['push-job-1', 'test-tt', 'release-1']);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releaseTestPhaseWorkflow for next=test (re-verify after fix)', async () => {
    const decision: NextPhase = { next: 'test', from: 'fix' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', parentJobId: 'release-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.test, ['test-tt', 'release-1']);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches pnpmTestPhaseWorkflow for next=test when plain test phase is enabled', async () => {
    settingsState.plainTestPhaseEnabled = true;
    const decision: NextPhase = { next: 'test', from: 'fix' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', parentJobId: 'release-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.pnpmTest, ['test-tt', 'release-1']);
    expect(r).toEqual({ dispatched: true, phase: 'test', childRunId: 'wrun_child_1' });
  });

  it('dispatches releaseCommitPhaseWorkflow for next=commit (re-attempt after fix-from-commit)', async () => {
    // commit-phase takes (projectName, options, releaseJobId).
    const phaseFnsCommit = vi.fn();
    vi.doMock('@/lib/workflows/phases/commit-phase', () => ({ releaseCommitPhaseWorkflow: phaseFnsCommit }));
    const { dispatchPhase: dispatchPhaseFresh } = await import('@/lib/workflows/dispatch-phase');
    const decision: NextPhase = { next: 'commit', from: 'fix' };
    const r = await dispatchPhaseFresh(decision, { projectName: 'test-tt', parentJobId: 'release-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFnsCommit, ['test-tt', { parentJobId: 'release-1' }, 'release-1']);
    expect(r.dispatched).toBe(true);
    vi.doUnmock('@/lib/workflows/phases/commit-phase');
  });

  it('dispatches releaseMarkDodPhaseWorkflow with optional override + releaseJobId', async () => {
    const decision: NextPhase = { next: 'mark-dod', from: 'push' };
    const override = { issueNumber: 42, repo: 'owner/repo' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', dodOverride: override, parentJobId: 'release-meta-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.markDod, ['test-tt', override, 'release-meta-1']);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releaseMarkDodPhaseWorkflow with no override', async () => {
    const decision: NextPhase = { next: 'mark-dod', from: 'push' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.markDod, ['test-tt', undefined, undefined]);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releasePrWaitPhaseWorkflow with PR context', async () => {
    const pr = { prNumber: 113, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/113' };
    const decision: NextPhase = { next: 'pr-wait', from: 'mark-dod', pr };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', pr, parentJobId: 'release-meta-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.prWait, ['test-tt', 113, 'owner/repo', 'https://github.com/owner/repo/pull/113', 'release-meta-1']);
    expect(r).toEqual({ dispatched: true, phase: 'pr-wait', childRunId: 'wrun_child_1' });
  });

  it('reports missing_context for pr-wait without PR identity', async () => {
    const pr = { prNumber: 113, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/113' };
    const decision: NextPhase = { next: 'pr-wait', from: 'mark-dod', pr };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).not.toHaveBeenCalled();
    if (!r.dispatched && r.reason === 'missing_context') {
      expect(r.missing).toEqual(expect.arrayContaining(['pr.prNumber', 'pr.prRepo', 'pr.prUrl']));
    } else {
      throw new Error(`expected missing_context, got ${JSON.stringify(r)}`);
    }
  });

  it('reports missing_context when projectName is empty', async () => {
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: '' });
    expect(startMock).not.toHaveBeenCalled();
    if (!r.dispatched && r.reason === 'missing_context') {
      expect(r.missing).toContain('projectName');
    }
  });

  it('retries once on Next.js chunk-load error then succeeds', async () => {
    startMock
      .mockRejectedValueOnce(new Error('Failed to load chunk server/chunks/lib_workflows_xyz._.js from module 71065'))
      .mockResolvedValueOnce({ runId: 'wrun_after_retry' });
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ dispatched: true, phase: 'review', childRunId: 'wrun_after_retry' });
  });

  it('does not retry non-chunk-load errors', async () => {
    startMock.mockRejectedValue(new Error('something else broke'));
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledOnce();
    if (!r.dispatched && r.reason === 'dispatch_failed') {
      expect(r.error).toBe('something else broke');
    } else {
      throw new Error('expected dispatch_failed');
    }
  });

  it('returns dispatch_failed when start() throws', async () => {
    startMock.mockRejectedValue(new Error('workflow runtime down'));
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(r).toEqual({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'review',
      error: 'workflow runtime down',
    });
  });

  it('returns dispatch_failed when start() returns no run handle', async () => {
    startMock.mockResolvedValue(null);
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(r).toMatchObject({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'review',
    });
  });

  it('suppresses duplicate dispatch when an in-flight child of the same kind already exists', async () => {
    // Regression: after a PM2 restart, both the workflow runtime AND the
    // completion-event router called start(...) for the next phase,
    // producing twin push/fix jobs.
    listJobsMock.mockReturnValue([
      { releaseId: 'release-1', kind: 'push', finishedAt: null },
    ]);
    const decision: NextPhase = { next: 'push', from: 'commit' };
    const r = await dispatchPhase(decision, { projectName: 'p', parentJobId: 'release-1' });
    expect(r).toMatchObject({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'push',
      error: expect.stringContaining('duplicate dispatch suppressed'),
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('dispatches normally when no in-flight child of that kind exists', async () => {
    listJobsMock.mockReturnValue([
      { releaseId: 'release-1', kind: 'review', finishedAt: 1 },  // finished, doesn't count
      { releaseId: 'release-2', kind: 'push', finishedAt: null }, // different release
    ]);
    const decision: NextPhase = { next: 'push', from: 'commit' };
    const r = await dispatchPhase(decision, { projectName: 'p', parentJobId: 'release-1' });
    expect(r).toMatchObject({ dispatched: true, phase: 'push' });
    expect(startMock).toHaveBeenCalledOnce();
  });
});
