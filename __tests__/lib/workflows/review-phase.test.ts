import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startProjectReviewMock = vi.fn();
const waitForJobCompletionMock = vi.fn();
const getJobMock = vi.fn();
const getVerdictMock = vi.fn();
const updateJobMock = vi.fn();
const markDoneMock = vi.fn();
const appendRedactedFileSyncMock = vi.fn();

vi.mock('@/lib/pipeline/start-review', () => ({
  startProjectReview: (...args: unknown[]) => startProjectReviewMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
  getVerdict: (...args: unknown[]) => getVerdictMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args),
  markDone: (...args: unknown[]) => markDoneMock(...args),
}));

vi.mock('@/lib/jobs/redacted-log-writer', () => ({
  appendRedactedFileSync: (...args: unknown[]) => appendRedactedFileSyncMock(...args),
}));

const safeStartOrchestratorMock = vi.fn();
vi.mock('@/lib/workflows/safe-start-orchestrator', () => ({
  safeStartOrchestrator: (...args: unknown[]) => safeStartOrchestratorMock(...args),
}));

import { releaseReviewPhaseWorkflow } from '@/lib/workflows/phases/review-phase';

describe('releaseReviewPhaseWorkflow', () => {
  beforeEach(() => {
    startProjectReviewMock.mockReset();
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    getVerdictMock.mockReset();
    updateJobMock.mockReset();
    markDoneMock.mockReset().mockResolvedValue(undefined);
    appendRedactedFileSyncMock.mockReset();
    safeStartOrchestratorMock.mockReset().mockResolvedValue(undefined);
  });

  function startOk() {
    startProjectReviewMock.mockResolvedValue({
      ok: true,
      jobId: 'review-job-1',
      pid: 12345,
      logPath: '/tmp/review.log',
    });
  }

  function waited(verdict: string | null, exitCode = 0) {
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'review-job-1', kind: 'review', exitCode, finishedAt: 100, verdict },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({ id: 'review-job-1', kind: 'review', exitCode, verdict });
    getVerdictMock.mockReturnValue(verdict);
  }

  it('returns LGTM verdict on a clean review', async () => {
    startOk();
    waited('LGTM');
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(startProjectReviewMock).toHaveBeenCalledWith('test-tt');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('review-job-1');
    expect(r).toEqual({
      ok: true,
      jobId: 'review-job-1',
      finished: true,
      reason: 'finished',
      exitCode: 0,
      verdict: 'LGTM',
      summary: null,
    });
  });

  it('returns a trimmed review work summary when present', async () => {
    startOk();
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'review-job-1', kind: 'review', exitCode: 0, finishedAt: 100, verdict: 'LGTM' },
      finished: true,
      reason: 'finished',
    });
    getJobMock.mockReturnValue({
      id: 'review-job-1',
      kind: 'review',
      exitCode: 0,
      verdict: 'LGTM',
      workSummary: '  Review found no blocking issues.  ',
    });
    getVerdictMock.mockReturnValue('LGTM');

    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary).toBe('Review found no blocking issues.');
  });

  it('returns NEEDS ATTENTION verdict', async () => {
    startOk();
    waited('NEEDS ATTENTION');
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBe('NEEDS ATTENTION');
  });

  it('returns DO NOT SHIP verdict', async () => {
    startOk();
    waited('DO NOT SHIP');
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBe('DO NOT SHIP');
  });

  it('returns null verdict when review did not emit one (treat as NEEDS ATTENTION downstream)', async () => {
    startOk();
    waited(null);
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBeNull();
  });

  it('returns null verdict when unknown verdict string lands (defensive)', async () => {
    // Future: someone adds a new verdict but forgets to update this file.
    // We want to surface it as null rather than crash.
    startOk();
    waited('SHIP IT MAYBE');
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBeNull();
  });

  it('skips verdict read when wait did not finish (timeout)', async () => {
    startOk();
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'review-job-1', kind: 'review', exitCode: null, finishedAt: null },
      finished: false,
      reason: 'timeout',
    });
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(getVerdictMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finished).toBe(false);
      expect(r.verdict).toBeNull();
    }
  });

  it('returns ok:false with start_failed when startProjectReview is blocked', async () => {
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Review already running for test-tt',
      blockingJobId: 'existing-1',
    });
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      status: 409,
      detail: 'Review already running for test-tt',
      blockingJobId: 'existing-1',
    });
  });

  it('finalizes the release when start_failed and releaseJobId is set (prereq strand fix)', async () => {
    // A failed review prereq returns ok:false without any in-flight child job,
    // leaving the release running until the wall-clock timeout. The phase must
    // drive the release to a terminal state immediately.
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 500,
      detail: 'review_prerequisite_command exited 2',
    });
    getJobMock.mockReturnValue({
      id: 'release-1', kind: 'release', finishedAt: null,
      contextMeta: null, logPath: '/tmp/release.log', project: 'p',
    });

    const r = await releaseReviewPhaseWorkflow('test-tt', 'release-1');
    expect(r.ok).toBe(false);
    expect(markDoneMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'release-1' }),
      1,
    );
    // Stop reason persisted onto the release row.
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'release-1',
      contextMeta: expect.stringContaining('releaseStopReason'),
    }));
  });

  it('attaches to an in-progress review of the same project instead of aborting the release', async () => {
    // Boot-recovery re-drive raced an already-running review → 409. The phase
    // must attach to that review and continue, NOT finalize the release.
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Review already in progress for test-tt (PID 68968)',
      blockingJobId: 'inflight-review-1',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'inflight-review-1'
        ? { id: 'inflight-review-1', kind: 'review', project: 'test-tt', exitCode: 0, verdict: 'LGTM' }
        : undefined,
    );
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'inflight-review-1', kind: 'review', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    getVerdictMock.mockReturnValue('LGTM');

    const r = await releaseReviewPhaseWorkflow('test-tt', 'release-1');

    expect(waitForJobCompletionMock).toHaveBeenCalledWith('inflight-review-1');
    expect(markDoneMock).not.toHaveBeenCalled(); // release NOT aborted
    expect(safeStartOrchestratorMock).toHaveBeenCalled(); // chain continues
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('inflight-review-1');
      expect(r.verdict).toBe('LGTM');
    }
  });

  it('does NOT attach when the 409 blocker is not a review of this project (real conflict aborts)', async () => {
    // e.g. a pipeline-lock 409 blocked by some other job kind — genuine
    // conflict, must finalize the release rather than attach.
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'some-release-job',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'some-release-job'
        ? { id: 'some-release-job', kind: 'release', project: 'test-tt', finishedAt: null, contextMeta: null, logPath: '/tmp/r.log' }
        : (id === 'release-1'
            ? { id: 'release-1', kind: 'release', finishedAt: null, contextMeta: null, logPath: '/tmp/release.log', project: 'test-tt' }
            : undefined),
    );

    const r = await releaseReviewPhaseWorkflow('test-tt', 'release-1');
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-1' }), 1);
    expect(r.ok).toBe(false);
  });

  it('does not call markDone when start_failed but no releaseJobId', async () => {
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 400,
      detail: 'no changes to review',
    });
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r.ok).toBe(false);
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it('omits blockingJobId when start_failed has none (e.g. no changes)', async () => {
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 400,
      detail: 'no changes to review',
    });
    const r = await releaseReviewPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      status: 400,
      detail: 'no changes to review',
    });
  });
});

describe('review-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/review-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseReviewPhaseWorkflow',
    'async function spawnReviewStep',
    'async function awaitReviewCompletionStep',
    'async function readReviewVerdictStep',
    'async function readReviewSummaryStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
