import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startFixPushMock = vi.fn();
const waitForJobCompletionMock = vi.fn();

vi.mock('@/lib/pipeline/start-fix-push', () => ({
  startFixPush: (...args: unknown[]) => startFixPushMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

import { releaseFixPushPhaseWorkflow } from '@/lib/workflows/phases/fix-push-phase';

describe('releaseFixPushPhaseWorkflow', () => {
  beforeEach(() => {
    startFixPushMock.mockReset();
    waitForJobCompletionMock.mockReset();
  });

  it('forwards both projectName and hookError to startFixPush', async () => {
    startFixPushMock.mockResolvedValue({
      ok: true,
      jobId: 'fp-job-1',
      pid: 12345,
      logPath: '/tmp/fp.log',
    });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fp-job-1', kind: 'fix-push', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const HOOK_ERROR = 'eslint: no-unused-vars at line 42';
    await releaseFixPushPhaseWorkflow('test-tt', HOOK_ERROR);
    expect(startFixPushMock).toHaveBeenCalledWith('test-tt', HOOK_ERROR);
  });

  it('returns ok with exitCode on a successful fix-push', async () => {
    startFixPushMock.mockResolvedValue({
      ok: true,
      jobId: 'fp-job-1',
      pid: 12345,
      logPath: '/tmp/fp.log',
    });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fp-job-1', kind: 'fix-push', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseFixPushPhaseWorkflow('test-tt', 'lint failure');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('fp-job-1');
    expect(r).toEqual({
      ok: true,
      jobId: 'fp-job-1',
      finished: true,
      reason: 'finished',
      exitCode: 0,
    });
  });

  it('propagates non-zero exit codes', async () => {
    startFixPushMock.mockResolvedValue({ ok: true, jobId: 'fp', pid: 1, logPath: '/x' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fp', kind: 'fix-push', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseFixPushPhaseWorkflow('test-tt', 'hook err');
    if (r.ok) expect(r.exitCode).toBe(1);
  });

  it('returns ok:false with start_failed when startFixPush is blocked', async () => {
    startFixPushMock.mockResolvedValue({
      ok: false,
      status: 404,
      detail: 'project not found',
    });
    const r = await releaseFixPushPhaseWorkflow('missing', 'hook err');
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      status: 404,
      detail: 'project not found',
    });
  });

  it('preserves blockingJobId on start failure', async () => {
    startFixPushMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-9',
    });
    const r = await releaseFixPushPhaseWorkflow('test-tt', 'hook err');
    if (!r.ok) expect(r.blockingJobId).toBe('block-9');
  });

  it('surfaces wait timeout via reason', async () => {
    startFixPushMock.mockResolvedValue({ ok: true, jobId: 'fp', pid: 1, logPath: '/x' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'fp', kind: 'fix-push', exitCode: null, finishedAt: null },
      finished: false,
      reason: 'timeout',
    });
    const r = await releaseFixPushPhaseWorkflow('test-tt', 'hook err');
    if (r.ok) {
      expect(r.finished).toBe(false);
      expect(r.reason).toBe('timeout');
      expect(r.exitCode).toBeNull();
    }
  });
});

describe('fix-push-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/fix-push-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseFixPushPhaseWorkflow',
    'async function spawnFixPushStep',
    'async function awaitFixPushCompletionStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
