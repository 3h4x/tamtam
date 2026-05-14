import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startReleaseMock = vi.fn();
const waitForJobCompletionMock = vi.fn();
const workflowStartMock = vi.fn();
const getJobMock = vi.fn();
const getVerdictMock = vi.fn();

vi.mock('@/lib/pipeline/start-release', () => ({
  startRelease: (...args: unknown[]) => startReleaseMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => workflowStartMock(...args),
}));

const listJobsMock = vi.fn();
const updateJobMock = vi.fn();
vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
  getVerdict: (...args: unknown[]) => getVerdictMock(...args),
  listJobs: (...args: unknown[]) => listJobsMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args),
}));

import { releaseWorkflow, releaseObservationWorkflow } from '@/lib/workflows/release';

describe('releaseWorkflow', () => {
  beforeEach(() => {
    startReleaseMock.mockReset();
    workflowStartMock.mockReset().mockResolvedValue({ runId: 'wrun_obs_1' });
  });

  it('delegates to startRelease with the same args', async () => {
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'job-test-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
    const r = await releaseWorkflow('proj-1', { queueIfBlocked: true });
    expect(startReleaseMock).toHaveBeenCalledWith('proj-1', { queueIfBlocked: true });
    expect(r).toEqual({
      ok: true,
      step: 'test',
      jobId: 'job-test-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
  });

  it('propagates a non-ok result without modification', async () => {
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-1',
    });
    const r = await releaseWorkflow('proj-1');
    expect(r).toEqual({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-1',
    });
  });

  it('defaults options to {} when not passed', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'review', message: 'Running review' });
    await releaseWorkflow('proj-1');
    expect(startReleaseMock).toHaveBeenCalledWith('proj-1', {});
  });

  it('dispatches releaseObservationWorkflow with the first sub-step jobId on ok', async () => {
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'job-test-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
    await releaseWorkflow('proj-1');
    expect(workflowStartMock).toHaveBeenCalledOnce();
    const [, args] = workflowStartMock.mock.calls[0];
    expect(args).toEqual(['job-test-1']);
  });

  it('does not dispatch observation when result is not ok', async () => {
    startReleaseMock.mockResolvedValue({ ok: false, status: 400, detail: 'no changes' });
    await releaseWorkflow('proj-1');
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  it('does not dispatch observation when result is queued (no jobId)', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, status: 'queued', message: 'queued' });
    await releaseWorkflow('proj-1');
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  it('swallows dispatch failures so they do not break the release result', async () => {
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'job-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
    workflowStartMock.mockRejectedValueOnce(new Error('runtime hiccup'));
    const r = await releaseWorkflow('proj-1');
    expect(r.ok).toBe(true);
    if (r.ok && 'step' in r) expect(r.step).toBe('test');
  });

  describe('TAMTAM_RELEASE_WORKFLOW_DRIVE drive mode', () => {
    const originalEnv = process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE;
    beforeEach(() => {
      getJobMock.mockReset();
      updateJobMock.mockReset();
    });
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE;
      else process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = originalEnv;
    });

    it('dispatches releaseOrchestratorWorkflow and stamps the workflowDriven flag when env=1', async () => {
      process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = '1';
      const releaseMetaJob = {
        id: 'release-1',
        kind: 'release',
        contextMeta: null,
      };
      getJobMock.mockReturnValue(releaseMetaJob);
      startReleaseMock.mockResolvedValue({
        ok: true,
        step: 'test',
        jobId: 'test-job-1',
        releaseJobId: 'release-1',
        message: 'Running tests',
      });

      await releaseWorkflow('proj-1');

      // contextMeta should now hold workflowDriven flag.
      expect(releaseMetaJob.contextMeta).toBe('{"workflowDriven":true}');
      expect(updateJobMock).toHaveBeenCalledWith(releaseMetaJob);

      // start() should have been called with the orchestrator workflow.
      expect(workflowStartMock).toHaveBeenCalledOnce();
      const [fn, args] = workflowStartMock.mock.calls[0];
      // The fn ref is the orchestrator; we know that by checking args shape.
      expect(args).toEqual([
        'test-job-1',
        expect.objectContaining({ projectName: 'proj-1', parentJobId: 'release-1' }),
      ]);
      // Ensure it wasn't the observation workflow (observation only takes [jobId])
      expect((args as unknown[]).length).toBe(2);
    });

    it('falls back to observation dispatch when env is unset (default behavior)', async () => {
      delete process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE;
      startReleaseMock.mockResolvedValue({
        ok: true,
        step: 'test',
        jobId: 'test-job-1',
        releaseJobId: 'release-1',
        message: 'Running tests',
      });

      await releaseWorkflow('proj-1');

      // No flag stamp.
      expect(updateJobMock).not.toHaveBeenCalled();
      // Observation dispatch — only takes [jobId].
      expect(workflowStartMock).toHaveBeenCalledOnce();
      const [, args] = workflowStartMock.mock.calls[0];
      expect((args as unknown[]).length).toBe(1);
      expect(args).toEqual(['test-job-1']);
    });

    it('does not stamp the flag when env=1 but releaseJobId is missing (queued path)', async () => {
      process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = '1';
      // Queued release: no jobId means no first sub-step.
      startReleaseMock.mockResolvedValue({
        ok: true,
        status: 'queued',
        message: 'queued for retry',
      });
      await releaseWorkflow('proj-1');
      expect(updateJobMock).not.toHaveBeenCalled();
      expect(workflowStartMock).not.toHaveBeenCalled();
    });

    it('swallows stamping failures so the dispatch still proceeds', async () => {
      process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = '1';
      getJobMock.mockImplementation(() => { throw new Error('cache miss'); });
      startReleaseMock.mockResolvedValue({
        ok: true,
        step: 'test',
        jobId: 'test-job-1',
        releaseJobId: 'release-1',
        message: 'Running tests',
      });
      const r = await releaseWorkflow('proj-1');
      // Release result still ok despite stamping failure.
      expect(r.ok).toBe(true);
      // Orchestrator dispatch still attempted.
      expect(workflowStartMock).toHaveBeenCalledOnce();
    });
  });
});

describe('releaseObservationWorkflow', () => {
  beforeEach(() => {
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    getVerdictMock.mockReset();
    listJobsMock.mockReset().mockReturnValue([]);
    workflowStartMock.mockReset().mockResolvedValue({ runId: 'wrun_test' });
  });

  it('delegates to waitForJobCompletion and decides next phase on success', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-1', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-1', kind: 'test', exitCode: 0 });
    const r = await releaseObservationWorkflow('job-1');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('job-1');
    expect(r.waited.finished).toBe(true);
    expect(r.decision).toEqual({ next: 'review', from: 'test' });
  });

  it('returns null decision on timeout (no completed job to decide from)', async () => {
    waitForJobCompletionMock.mockResolvedValue({ job: null, finished: false, reason: 'timeout' });
    const r = await releaseObservationWorkflow('job-x');
    expect(r.waited.reason).toBe('timeout');
    expect(r.decision).toBeNull();
  });

  it('decides fix when test exits non-zero', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-1', kind: 'test', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-1', kind: 'test', exitCode: 1 });
    const r = await releaseObservationWorkflow('job-1');
    expect(r.decision).toEqual({ next: 'fix', from: 'test', testExitCode: 1 });
  });

  it('decides push when review verdict is LGTM', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-r', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-r', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue('LGTM');
    const r = await releaseObservationWorkflow('job-r');
    expect(r.decision).toEqual({ next: 'push', from: 'review' });
  });

  it('decides fix when review verdict is NEEDS ATTENTION', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-r', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-r', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue('NEEDS ATTENTION');
    const r = await releaseObservationWorkflow('job-r');
    expect(r.decision).toEqual({ next: 'fix', from: 'review', verdict: 'NEEDS ATTENTION' });
  });

  it('decides abort when review verdict is DO NOT SHIP', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-r', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-r', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue('DO NOT SHIP');
    const r = await releaseObservationWorkflow('job-r');
    expect(r.decision).toEqual({ next: 'abort', from: 'review', verdict: 'DO NOT SHIP' });
  });

  it('decides fix when review verdict is null (treated as NEEDS ATTENTION)', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-r', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-r', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue(null);
    const r = await releaseObservationWorkflow('job-r');
    expect(r.decision).toEqual({ next: 'fix', from: 'review', verdict: 'NEEDS ATTENTION' });
  });

  it('decides mark-dod when push exits 0', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-p', kind: 'push', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-p', kind: 'push', exitCode: 0 });
    const r = await releaseObservationWorkflow('job-p');
    expect(r.decision).toEqual({ next: 'mark-dod', from: 'push' });
  });

  it('decides fix-push when push exits non-zero', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-p', kind: 'push', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'job-p', kind: 'push', exitCode: 1 });
    const r = await releaseObservationWorkflow('job-p');
    expect(r.decision).toEqual({ next: 'fix-push', from: 'push' });
  });

  it('decides done for terminal kinds (mark-dod, pr-wait, commit, fix, fix-push)', async () => {
    for (const kind of ['mark-dod', 'pr-wait', 'commit', 'fix', 'fix-push'] as const) {
      waitForJobCompletionMock.mockResolvedValue({
        job: { id: 'j', kind, exitCode: 0, finishedAt: 100 },
        finished: true,
        reason: 'finished',
      });
      getJobMock.mockReturnValue({ id: 'j', kind, exitCode: 0 });
      const r = await releaseObservationWorkflow('j');
      expect(r.decision).toEqual({ next: 'done', from: kind });
    }
  });

  it('decides unknown when job kind has no decision rule', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'j', kind: 'release', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'j', kind: 'release', exitCode: 0 });
    const r = await releaseObservationWorkflow('j');
    expect(r.decision).toMatchObject({ next: 'unknown', from: 'release' });
  });

  it('dispatches the next observation child when decision is non-terminal', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'job-test', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    // Two getJob calls happen: decideNextPhaseStep and dispatchNextObservationStep.
    getJobMock
      .mockReturnValueOnce({ id: 'job-test', kind: 'test', exitCode: 0 })
      .mockReturnValue({ id: 'job-test', kind: 'test', exitCode: 0, finishedAt: 100, releaseId: 'release-1' });
    listJobsMock.mockReturnValue([
      { id: 'job-review', kind: 'review', releaseId: 'release-1', startedAt: 101 },
    ]);
    workflowStartMock.mockResolvedValue({ runId: 'wrun_next' });
    const r = await releaseObservationWorkflow('job-test');
    expect(r.decision).toEqual({ next: 'review', from: 'test' });
    // releaseWorkflow's own dispatchObservationStep + the nested
    // dispatchNextObservationStep both call start(), so the recursive
    // observation chain shows up as two workflowStart invocations.
    const allArgs = workflowStartMock.mock.calls.map((c) => c[1]);
    expect(allArgs).toContainEqual(['job-review']);
  });

  it('does NOT dispatch next observation when decision is done (terminal)', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'j', kind: 'commit', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'j', kind: 'commit', exitCode: 0 });
    listJobsMock.mockReturnValue([]);
    await releaseObservationWorkflow('j');
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch next observation when decision is abort', async () => {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'j', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'j', kind: 'review', exitCode: 0 });
    getVerdictMock.mockReturnValue('DO NOT SHIP');
    listJobsMock.mockReturnValue([]);
    await releaseObservationWorkflow('j');
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  // Note: the dispatchNextObservationStep return value (DispatchOutcome) lands
  // in workflow_steps.output at runtime and is what operators see in the
  // detail UI. We assert it indirectly through the dispatch behavior — when
  // the next sibling is found and start() succeeds, the observation chain
  // recurses. The other DispatchOutcome shapes (prev_not_found,
  // prev_not_finished, dispatch_failed, no_sibling_within_window) are
  // exercised by the suite's mock-driven branches plus the dispatch-failure
  // swallow test in the releaseWorkflow group above.
});

describe('releaseWorkflow source', () => {
  // Locks in the workflow directives so a future refactor can't silently
  // demote releaseWorkflow to a plain function. The Vercel Workflow loader
  // detects directives at build time via the same string match.
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/release.ts'), 'utf-8');

  it("releaseWorkflow has a 'use workflow' directive", () => {
    const fnIndex = SRC.indexOf('export async function releaseWorkflow');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use workflow['"]/);
  });

  it("kickoffReleaseStep has a 'use step' directive", () => {
    const fnIndex = SRC.indexOf('async function kickoffReleaseStep');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use step['"]/);
  });

  it("releaseObservationWorkflow has a 'use workflow' directive", () => {
    const fnIndex = SRC.indexOf('export async function releaseObservationWorkflow');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use workflow['"]/);
  });

  it("observeJobCompletionStep has a 'use step' directive", () => {
    const fnIndex = SRC.indexOf('async function observeJobCompletionStep');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use step['"]/);
  });
});
