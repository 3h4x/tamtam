import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startFixFromJobMock = vi.fn();
const waitForJobCompletionMock = vi.fn();

vi.mock('@/lib/pipeline/start-fix', () => ({
  startFixFromJob: (...args: unknown[]) => startFixFromJobMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

import { releaseFixPhaseWorkflow } from '@/lib/workflows/phases/fix-phase';

describe('releaseFixPhaseWorkflow', () => {
  beforeEach(() => {
    startFixFromJobMock.mockReset();
    waitForJobCompletionMock.mockReset();
  });

  it('returns ok with exitCode on a successful fix run', async () => {
    startFixFromJobMock.mockResolvedValue({ ok: true, jobId: 'fix-job-1', pid: 12345 });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-job-1', kind: 'fix', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseFixPhaseWorkflow('review-source-1');
    expect(startFixFromJobMock).toHaveBeenCalledWith('review-source-1');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('fix-job-1');
    expect(r).toEqual({
      ok: true,
      jobId: 'fix-job-1',
      sourceJobId: 'review-source-1',
      finished: true,
      reason: 'finished',
      exitCode: 0,
    });
  });

  it('preserves the sourceJobId in the result for traceability', async () => {
    startFixFromJobMock.mockResolvedValue({ ok: true, jobId: 'fix-x', pid: 99 });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-x', kind: 'fix', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseFixPhaseWorkflow('test-source-7');
    if (r.ok) expect(r.sourceJobId).toBe('test-source-7');
  });

  it('propagates non-zero exit codes', async () => {
    startFixFromJobMock.mockResolvedValue({ ok: true, jobId: 'fix-job-1', pid: 12345 });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-job-1', kind: 'fix', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseFixPhaseWorkflow('review-source-1');
    if (r.ok) expect(r.exitCode).toBe(1);
  });

  it('returns ok:false with start_failed when sourceJob is missing', async () => {
    startFixFromJobMock.mockResolvedValue({
      ok: false,
      status: 404,
      detail: "job 'missing' not found",
    });
    const r = await releaseFixPhaseWorkflow('missing');
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      sourceJobId: 'missing',
      status: 404,
      detail: "job 'missing' not found",
    });
  });

  it('returns ok:false when sourceJob is still running', async () => {
    startFixFromJobMock.mockResolvedValue({
      ok: false,
      status: 400,
      detail: 'Job is still running',
    });
    const r = await releaseFixPhaseWorkflow('still-running-1');
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      sourceJobId: 'still-running-1',
      status: 400,
      detail: 'Job is still running',
    });
  });

  it('preserves blockingJobId from the start failure', async () => {
    startFixFromJobMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-7',
    });
    const r = await releaseFixPhaseWorkflow('src-1');
    if (!r.ok) expect(r.blockingJobId).toBe('block-7');
  });

  it('surfaces wait timeout via reason', async () => {
    startFixFromJobMock.mockResolvedValue({ ok: true, jobId: 'fix-job-1', pid: 12345 });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fix-job-1', kind: 'fix', exitCode: null, finishedAt: null },
      finished: false,
      reason: 'timeout',
    });
    const r = await releaseFixPhaseWorkflow('src-1');
    if (r.ok) {
      expect(r.finished).toBe(false);
      expect(r.reason).toBe('timeout');
      expect(r.exitCode).toBeNull();
    }
  });
});

describe('fix-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/fix-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseFixPhaseWorkflow',
    'async function spawnFixStep',
    'async function awaitFixCompletionStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
