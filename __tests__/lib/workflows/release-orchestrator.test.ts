import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const waitForJobCompletionMock = vi.fn();
const getJobMock = vi.fn();
const getVerdictMock = vi.fn();
const dispatchPhaseMock = vi.fn();
const getProjectTestConfigMock = vi.fn();
const resolveProjectPathMock = vi.fn();
const execMock = vi.fn();
const hasLocalCommitsAheadMock = vi.fn();

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: waitForJobCompletionMock,
}));

// Stubs for the convergence-guard deps; tests that exercise the guards
// can override before calling.
const listJobsMock = vi.fn();
const readParsedLogMock = vi.fn();

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: getJobMock,
  getVerdict: getVerdictMock,
  listJobs: listJobsMock,
  readParsedLog: readParsedLogMock,
  updateJob: vi.fn(),
}));

vi.mock('@/lib/jobs/redacted-log-writer', () => ({
  appendRedactedFileSync: vi.fn(),
}));

const finalizeReleaseJobMock = vi.fn();
const finalizeAbortedReleaseMock = vi.fn();
vi.mock('@/lib/jobs/lifecycle', () => ({
  finalizeReleaseJob: finalizeReleaseJobMock,
  finalizeAbortedRelease: finalizeAbortedReleaseMock,
}));

vi.mock('@/lib/workflows/dispatch-phase', () => ({
  dispatchPhase: dispatchPhaseMock,
}));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getProjectTestConfig: getProjectTestConfigMock,
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: resolveProjectPathMock,
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: execMock,
}));

vi.mock('@/lib/pipeline/release-state', () => ({
  hasLocalCommitsAhead: hasLocalCommitsAheadMock,
}));

import { releaseOrchestratorWorkflow } from '@/lib/workflows/release-orchestrator';

describe('releaseOrchestratorWorkflow', () => {
  beforeEach(() => {
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    getVerdictMock.mockReset();
    dispatchPhaseMock.mockReset();
    getProjectTestConfigMock.mockReset().mockResolvedValue({ reviewDisabled: false });
    resolveProjectPathMock.mockReset().mockReturnValue('/repo/project');
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '' });
    hasLocalCommitsAheadMock.mockReset().mockResolvedValue(false);
    listJobsMock.mockReset().mockReturnValue([]);
    readParsedLogMock.mockReset().mockReturnValue('');
    finalizeReleaseJobMock.mockReset();
    finalizeAbortedReleaseMock.mockReset();
  });

  describe('convergence guards (release-linked NEEDS ATTENTION → fix)', () => {
    const SAME_FINDING_LOG = `
Findings:
- Finding ID: alpha
  Severity: high
Verdict: NEEDS ATTENTION
`;

    it('rewrites fix → abort when reviewIsStuck (same findings as prior review)', async () => {
      const reviewJob = {
        id: 'review-2',
        kind: 'review',
        exitCode: 0,
        finishedAt: 200,
        releaseId: 'rel-stuck',
        project: 'p',
        startedAt: 200,
      };
      const priorReview = {
        id: 'review-1',
        kind: 'review',
        exitCode: 0,
        startedAt: 100,
        releaseId: 'rel-stuck',
        project: 'p',
      };
      waitForJobCompletionMock.mockResolvedValue({
        job: reviewJob,
        finished: true,
        reason: 'finished',
      });
      getJobMock.mockReturnValue(reviewJob);
      getVerdictMock.mockReturnValue('NEEDS ATTENTION');
      listJobsMock.mockReturnValue([priorReview, reviewJob]);
      readParsedLogMock.mockReturnValue(SAME_FINDING_LOG);
      dispatchPhaseMock.mockResolvedValue({
        dispatched: false,
        reason: 'terminal',
        phase: 'abort',
      });

      const r = await releaseOrchestratorWorkflow('review-2', {
        projectName: 'p',
        parentJobId: 'rel-stuck',
      });

      expect(r.decision).toMatchObject({
        next: 'abort',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
      });
      expect(r.decision).toHaveProperty('stopReason');
      // Whatever stop-reason text the guard chose must mention the project
      // so a future trace UI can attribute the failure correctly.
      const stopReason = (r.decision as { stopReason?: string }).stopReason;
      expect(stopReason).toContain('p');
      expect(dispatchPhaseMock).toHaveBeenCalledWith(
        expect.objectContaining({ next: 'abort' }),
        expect.any(Object),
      );
    });

    it('rewrites fix → abort when fixContradictsReview (prior fix claimed ID fixed but review still flags)', async () => {
      const reviewJob = {
        id: 'review-2',
        kind: 'review',
        exitCode: 0,
        finishedAt: 200,
        releaseId: 'rel-contradict',
        project: 'p',
        startedAt: 200,
      };
      const priorFix = {
        id: 'fix-1',
        kind: 'fix',
        exitCode: 0,
        startedAt: 150,
        releaseId: 'rel-contradict',
        project: 'p',
      };
      waitForJobCompletionMock.mockResolvedValue({
        job: reviewJob,
        finished: true,
        reason: 'finished',
      });
      getJobMock.mockReturnValue(reviewJob);
      getVerdictMock.mockReturnValue('NEEDS ATTENTION');
      listJobsMock.mockReturnValue([priorFix, reviewJob]);
      readParsedLogMock.mockImplementation((j: { id: string }) => {
        if (j.id === 'fix-1') return 'Fix checklist:\n- Finding ID: alpha\n  Status: fixed\n';
        return 'Findings:\n- Finding ID: alpha\nVerdict: NEEDS ATTENTION\n';
      });
      dispatchPhaseMock.mockResolvedValue({
        dispatched: false,
        reason: 'terminal',
        phase: 'abort',
      });

      const r = await releaseOrchestratorWorkflow('review-2', {
        projectName: 'p',
        parentJobId: 'rel-contradict',
      });

      expect(r.decision).toMatchObject({ next: 'abort', from: 'review' });
      const stopReason = (r.decision as { stopReason?: string }).stopReason;
      expect(stopReason).toContain('alpha');
    });

    it('lets fix proceed when reviews differ + no fix contradiction', async () => {
      const reviewJob = {
        id: 'review-2',
        kind: 'review',
        exitCode: 0,
        finishedAt: 200,
        releaseId: 'rel-progressing',
        project: 'p',
        startedAt: 200,
      };
      const priorReview = {
        id: 'review-1',
        kind: 'review',
        exitCode: 0,
        startedAt: 100,
        releaseId: 'rel-progressing',
        project: 'p',
      };
      waitForJobCompletionMock.mockResolvedValue({
        job: reviewJob,
        finished: true,
        reason: 'finished',
      });
      getJobMock.mockReturnValue(reviewJob);
      getVerdictMock.mockReturnValue('NEEDS ATTENTION');
      listJobsMock.mockReturnValue([priorReview, reviewJob]);
      let calls = 0;
      readParsedLogMock.mockImplementation(() =>
        // Different findings each call → different fingerprints → not stuck.
        calls++ === 0
          ? 'Findings:\n- Finding ID: alpha\nVerdict: NEEDS ATTENTION\n'
          : 'Findings:\n- Finding ID: beta\nVerdict: NEEDS ATTENTION\n',
      );
      dispatchPhaseMock.mockResolvedValue({
        dispatched: true,
        phase: 'fix',
        childRunId: 'wrun_fix_1',
      });

      const r = await releaseOrchestratorWorkflow('review-2', {
        projectName: 'p',
        parentJobId: 'rel-progressing',
      });

      expect(r.decision).toMatchObject({ next: 'fix', from: 'review' });
    });
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

  it('skips review and dispatches commit after a successful test when review is disabled with uncommitted changes', async () => {
    const testJob = {
      id: 'test-1',
      kind: 'test',
      exitCode: 0,
      finishedAt: 100,
      project: 'test-tt',
    };
    waitForJobCompletionMock.mockResolvedValue({
      job: testJob,
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue(testJob);
    getProjectTestConfigMock.mockResolvedValue({ reviewDisabled: true });
    execMock.mockResolvedValue({ exitCode: 0, stdout: ' M file.ts\n' });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'commit',
      childRunId: 'wrun_commit',
    });

    const r = await releaseOrchestratorWorkflow('test-1', {
      projectName: 'test-tt',
      parentJobId: 'release-1',
    });

    expect(execMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/project', 'status', '--porcelain'],
      { timeout: 5000 },
    );
    expect(hasLocalCommitsAheadMock).not.toHaveBeenCalled();
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      { next: 'commit', from: 'test' },
      expect.objectContaining({ projectName: 'test-tt', parentJobId: 'release-1', prevJobId: 'test-1' }),
    );
    expect(r.decision).toEqual({ next: 'commit', from: 'test' });
  });

  it('skips review and dispatches push after a successful test when review is disabled and only unpushed commits remain', async () => {
    const testJob = {
      id: 'test-1',
      kind: 'test',
      exitCode: 0,
      finishedAt: 100,
      project: 'test-tt',
    };
    waitForJobCompletionMock.mockResolvedValue({
      job: testJob,
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue(testJob);
    getProjectTestConfigMock.mockResolvedValue({ reviewDisabled: true });
    execMock.mockResolvedValue({ exitCode: 0, stdout: '' });
    hasLocalCommitsAheadMock.mockResolvedValue(true);
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'push',
      childRunId: 'wrun_push',
    });

    const r = await releaseOrchestratorWorkflow('test-1', {
      projectName: 'test-tt',
      parentJobId: 'release-1',
    });

    expect(hasLocalCommitsAheadMock).toHaveBeenCalledWith('/repo/project');
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      { next: 'push', from: 'test' },
      expect.objectContaining({ projectName: 'test-tt', parentJobId: 'release-1', prevJobId: 'test-1' }),
    );
    expect(r.decision).toEqual({ next: 'push', from: 'test' });
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
    // mark-dod is the terminal step — orchestrator should finalize the
    // release after dispatch returns terminal.
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'mark-dod-1', kind: 'mark-dod', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'mark-dod-1', kind: 'mark-dod', exitCode: 0 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: false,
      reason: 'terminal',
      phase: 'done',
    });
    const r = await releaseOrchestratorWorkflow('mark-dod-1', { projectName: 'test-tt' });
    expect(r.decision).toEqual({ next: 'done', from: 'mark-dod' });
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

  it('finalizes the release as aborted when dispatch_failed and parentJobId is set', async () => {
    // Regression: a downstream `start(phase)` that throws used to leave the
    // release row in `running` forever. The orchestrator must coerce
    // dispatch_failed into an aborted finalize so the release doesn't sit
    // until the wall-clock sweep reaps it.
    const release = {
      id: 'rel-1',
      kind: 'release',
      project: 'test-tt',
      finishedAt: null,
      contextMeta: null,
      logPath: null,
    };
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-1', kind: 'fix', exitCode: -1, finishedAt: 200 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'rel-1'
        ? release
        : id === 'fix-1'
          ? { id: 'fix-1', kind: 'fix', exitCode: -1, parentJobId: 'review-1' }
          : id === 'review-1'
            ? { id: 'review-1', kind: 'review' }
            : null,
    );
    dispatchPhaseMock.mockResolvedValue({
      dispatched: false,
      reason: 'dispatch_failed',
      phase: 'review',
      error: 'queue down',
    });
    await releaseOrchestratorWorkflow('fix-1', {
      projectName: 'test-tt',
      parentJobId: 'rel-1',
    });
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(release);
    expect(release.contextMeta).toContain('failed to dispatch review phase: queue down');
  });

  it('finalizes the release as aborted on missing_context dispatch outcome', async () => {
    const release = {
      id: 'rel-2',
      kind: 'release',
      project: 'test-tt',
      finishedAt: null,
      contextMeta: null,
      logPath: null,
    };
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-2', kind: 'fix', exitCode: 0, finishedAt: 300 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'rel-2'
        ? release
        : id === 'fix-2'
          ? { id: 'fix-2', kind: 'fix', exitCode: 0, parentJobId: 'push-2' }
          : id === 'push-2'
            ? { id: 'push-2', kind: 'push' }
            : null,
    );
    dispatchPhaseMock.mockResolvedValue({
      dispatched: false,
      reason: 'missing_context',
      phase: 'push',
      missing: ['prevJobId'],
    });
    await releaseOrchestratorWorkflow('fix-2', {
      projectName: 'test-tt',
      parentJobId: 'rel-2',
    });
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(release);
    expect(release.contextMeta).toContain('missing context for push dispatch: prevJobId');
  });

  it('forwards full DispatchContext (dodOverride, parentJobId, prevJobId)', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'push-1', kind: 'push', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'push-1', kind: 'push', exitCode: 1 });
    dispatchPhaseMock.mockResolvedValue({
      dispatched: true,
      phase: 'fix',
      childRunId: 'wrun',
    });
    await releaseOrchestratorWorkflow('push-1', {
      projectName: 'test-tt',
      parentJobId: 'release-1',
      dodOverride: { issueNumber: 99 },
    });
    expect(dispatchPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ next: 'fix' }),
      expect.objectContaining({
        projectName: 'test-tt',
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
