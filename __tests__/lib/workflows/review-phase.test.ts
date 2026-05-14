import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startProjectReviewMock = vi.fn();
const waitForJobCompletionMock = vi.fn();
const getJobMock = vi.fn();
const getVerdictMock = vi.fn();

vi.mock('@/lib/pipeline/start-review', () => ({
  startProjectReview: (...args: unknown[]) => startProjectReviewMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
  getVerdict: (...args: unknown[]) => getVerdictMock(...args),
}));

import { releaseReviewPhaseWorkflow } from '@/lib/workflows/phases/review-phase';

describe('releaseReviewPhaseWorkflow', () => {
  beforeEach(() => {
    startProjectReviewMock.mockReset();
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    getVerdictMock.mockReset();
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
    });
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
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
