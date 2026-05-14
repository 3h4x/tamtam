import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const waitForJobCompletionMock = vi.fn();
const getJobMock = vi.fn();
const getVerdictMock = vi.fn();
const dispatchPhaseMock = vi.fn();

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
  getVerdict: (...args: unknown[]) => getVerdictMock(...args),
}));

vi.mock('@/lib/workflows/dispatch-phase', () => ({
  dispatchPhase: (...args: unknown[]) => dispatchPhaseMock(...args),
}));

import { releaseOrchestratorWorkflow } from '@/lib/workflows/release-orchestrator';

describe('releaseOrchestratorWorkflow', () => {
  beforeEach(() => {
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    getVerdictMock.mockReset();
    dispatchPhaseMock.mockReset();
  });

  it('wait → decide → dispatch on a successful test step (next=review)', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-1', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'test-1', kind: 'test', exitCode: 0 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'review',
      childRunId: 'wrun_child_1',
    });
    const r = await releaseOrchestratorWorkflow('test-1', { projectName: 'test-tt' });
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('test-1');
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      { next: 'review', from: 'test' },
      expect.objectContaining({ projectName: 'test-tt', prevJobId: 'test-1' }),
    );
    expect(r).toEqual({
      waited: expect.objectContaining({ finished: true, reason: 'finished' }),
      decision: { next: 'review', from: 'test' },
      dispatch: { dispatched: true, phase: 'review', childRunId: 'wrun_child_1' },
    });
  });

  it('returns null decision + null dispatch when wait times out', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: null,
      finished: false,
      reason: 'timeout',
    });
    const r = await releaseOrchestratorWorkflow('test-1', { projectName: 'test-tt' });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(dispatchPhaseMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      waited: expect.objectContaining({ finished: false, reason: 'timeout' }),
      decision: null,
      dispatch: null,
    });
  });

  it('passes prevJobId in dispatch context for next=fix', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-bad', kind: 'test', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'test-bad', kind: 'test', exitCode: 1 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'fix',
      childRunId: 'wrun_fix',
    });
    const r = await releaseOrchestratorWorkflow('test-bad', { projectName: 'test-tt' });
    expect(r.decision).toEqual({ next: 'fix', from: 'test', testExitCode: 1 });
    // prevJobId must be the just-finished sub-step (so fix-phase has its source)
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ next: 'fix' }),
      expect.objectContaining({ prevJobId: 'test-bad' }),
    );
  });

  it('dispatches review verdict NEEDS ATTENTION → fix', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'review-1', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'review-1', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue('NEEDS ATTENTION');
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'fix',
      childRunId: 'wrun_fix',
    });
    const r = await releaseOrchestratorWorkflow('review-1', { projectName: 'test-tt' });
    expect(r.decision).toEqual({ next: 'fix', from: 'review', verdict: 'NEEDS ATTENTION' });
    expect(r.dispatch).toMatchObject({ dispatched: true, phase: 'fix' });
  });

  it('records terminal dispatch outcome for next=done', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'commit-1', kind: 'commit', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'commit-1', kind: 'commit', exitCode: 0 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: false,
      reason: 'terminal',
      phase: 'done',
    });
    const r = await releaseOrchestratorWorkflow('commit-1', { projectName: 'test-tt' });
    expect(r.decision).toEqual({ next: 'done', from: 'commit' });
    expect(r.dispatch).toEqual({ dispatched: false, reason: 'terminal', phase: 'done' });
  });

  it('records dispatch_failed outcome when start() throws downstream', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-1', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'test-1', kind: 'test', exitCode: 0 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'review',
      error: 'runtime down',
    });
    const r = await releaseOrchestratorWorkflow('test-1', { projectName: 'test-tt' });
    expect(r.dispatch).toEqual({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'review',
      error: 'runtime down',
    });
  });

  it('forwards full DispatchContext (hookError, dodOverride, parentJobId)', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'push-1', kind: 'push', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'push-1', kind: 'push', exitCode: 1 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'fix-push',
      childRunId: 'wrun',
    });
    await releaseOrchestratorWorkflow('push-1', {
      projectName: 'test-tt',
      hookError: 'lint failed at line 42',
      parentJobId: 'release-1',
      dodOverride: { issueNumber: 99 },
    });
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ next: 'fix-push' }),
      expect.objectContaining({
        projectName: 'test-tt',
        hookError: 'lint failed at line 42',
        parentJobId: 'release-1',
        dodOverride: { issueNumber: 99 },
        prevJobId: 'push-1',
      }),
    );
  });
});

describe('release-orchestrator source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/release-orchestrator.ts'), 'utf-8');
  it.each([
    'export async function releaseOrchestratorWorkflow',
    'async function waitStep',
    'async function decideStep',
    'async function dispatchStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
