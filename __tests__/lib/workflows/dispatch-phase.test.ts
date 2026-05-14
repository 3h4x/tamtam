import { describe, it, expect, beforeEach, vi } from 'vitest';

const startMock = vi.fn();

vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => startMock(...args),
}));

// Mock each phase workflow module so we can identify which one start() was
// called with (the function reference is the workflow identifier).
const phaseFns = {
  test: vi.fn(),
  review: vi.fn(),
  fix: vi.fn(),
  push: vi.fn(),
  fixPush: vi.fn(),
  markDod: vi.fn(),
  prWait: vi.fn(),
};
vi.mock('@/lib/workflows/phases/test-phase', () => ({ releaseTestPhaseWorkflow: phaseFns.test }));
vi.mock('@/lib/workflows/phases/review-phase', () => ({ releaseReviewPhaseWorkflow: phaseFns.review }));
vi.mock('@/lib/workflows/phases/fix-phase', () => ({ releaseFixPhaseWorkflow: phaseFns.fix }));
vi.mock('@/lib/workflows/phases/push-phase', () => ({ releasePushPhaseWorkflow: phaseFns.push }));
vi.mock('@/lib/workflows/phases/fix-push-phase', () => ({ releaseFixPushPhaseWorkflow: phaseFns.fixPush }));
vi.mock('@/lib/workflows/phases/mark-dod-phase', () => ({ releaseMarkDodPhaseWorkflow: phaseFns.markDod }));
vi.mock('@/lib/workflows/phases/pr-wait-phase', () => ({ releasePrWaitPhaseWorkflow: phaseFns.prWait }));

import { dispatchPhase } from '@/lib/workflows/dispatch-phase';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';

describe('dispatchPhase', () => {
  beforeEach(() => {
    startMock.mockReset().mockResolvedValue({ runId: 'wrun_child_1' });
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

  it('dispatches releaseReviewPhaseWorkflow for next=review', async () => {
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.review, ['test-tt']);
    expect(r).toEqual({ dispatched: true, phase: 'review', childRunId: 'wrun_child_1' });
  });

  it('dispatches releaseFixPhaseWorkflow for next=fix with prevJobId', async () => {
    const decision: NextPhase = { next: 'fix', from: 'test', testExitCode: 1 };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', prevJobId: 'test-job-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.fix, ['test-job-1']);
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

  it('dispatches releasePushPhaseWorkflow for next=push with parentJobId option', async () => {
    const decision: NextPhase = { next: 'push', from: 'review' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', parentJobId: 'release-1' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.push, ['test-tt', { parentJobId: 'release-1' }]);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releaseFixPushPhaseWorkflow for next=fix-push with hookError', async () => {
    const decision: NextPhase = { next: 'fix-push', from: 'push' };
    const r = await dispatchPhase(decision, {
      projectName: 'test-tt',
      hookError: 'eslint: no-unused-vars at line 5',
    });
    expect(startMock).toHaveBeenCalledWith(phaseFns.fixPush, [
      'test-tt',
      'eslint: no-unused-vars at line 5',
    ]);
    expect(r.dispatched).toBe(true);
  });

  it('reports missing_context for next=fix-push without hookError', async () => {
    const decision: NextPhase = { next: 'fix-push', from: 'push' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      dispatched: false,
      reason: 'missing_context',
      phase: 'fix-push',
      missing: ['hookError'],
    });
  });

  it('dispatches releaseMarkDodPhaseWorkflow with optional override', async () => {
    const decision: NextPhase = { next: 'mark-dod', from: 'push' };
    const override = { issueNumber: 42, repo: 'owner/repo' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt', dodOverride: override });
    expect(startMock).toHaveBeenCalledWith(phaseFns.markDod, ['test-tt', override]);
    expect(r.dispatched).toBe(true);
  });

  it('dispatches releaseMarkDodPhaseWorkflow with no override', async () => {
    const decision: NextPhase = { next: 'mark-dod', from: 'push' };
    const r = await dispatchPhase(decision, { projectName: 'test-tt' });
    expect(startMock).toHaveBeenCalledWith(phaseFns.markDod, ['test-tt', undefined]);
    expect(r.dispatched).toBe(true);
  });

  it('reports missing_context when projectName is empty', async () => {
    const decision: NextPhase = { next: 'review', from: 'test' };
    const r = await dispatchPhase(decision, { projectName: '' });
    expect(startMock).not.toHaveBeenCalled();
    if (!r.dispatched && r.reason === 'missing_context') {
      expect(r.missing).toContain('projectName');
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
});
