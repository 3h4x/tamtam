import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startProjectTestMock = vi.fn();
const waitForJobCompletionMock = vi.fn();
const getJobMock = vi.fn();
const safeStartOrchestratorMock = vi.fn();

vi.mock('@/lib/pipeline/start-test', () => ({
  startProjectTest: (...args: unknown[]) => startProjectTestMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
}));

vi.mock('@/lib/workflows/safe-start-orchestrator', () => ({
  safeStartOrchestrator: (...args: unknown[]) => safeStartOrchestratorMock(...args),
}));

import { releaseTestPhaseWorkflow } from '@/lib/workflows/phases/test-phase';

describe('releaseTestPhaseWorkflow', () => {
  beforeEach(() => {
    startProjectTestMock.mockReset();
    waitForJobCompletionMock.mockReset();
    getJobMock.mockReset();
    safeStartOrchestratorMock.mockReset().mockResolvedValue(undefined);
  });

  it('attaches to an in-flight test of the same project on a 409 instead of aborting', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Tests already running for test-tt',
      blockingJobId: 'inflight-test-1',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'inflight-test-1'
        ? { id: 'inflight-test-1', kind: 'test', project: 'test-tt', exitCode: 0 }
        : undefined,
    );
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'inflight-test-1', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });

    const r = await releaseTestPhaseWorkflow('test-tt', 'release-1');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('inflight-test-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jobId).toBe('inflight-test-1');
  });

  it('returns ok with exit code on a successful test run', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: true,
      jobId: 'test-job-1',
      pid: 12345,
      logPath: '/tmp/test.log',
      testCmd: 'pnpm test',
    });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-job-1', kind: 'test', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });

    const r = await releaseTestPhaseWorkflow('test-tt');
    expect(startProjectTestMock).toHaveBeenCalledWith('test-tt');
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('test-job-1');
    expect(r).toEqual({
      ok: true,
      jobId: 'test-job-1',
      finished: true,
      reason: 'finished',
      exitCode: 0,
      testCmd: 'pnpm test',
    });
  });

  it('propagates non-zero exit codes through', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: true,
      jobId: 'test-job-1',
      pid: 12345,
      logPath: '/tmp/test.log',
      testCmd: 'pnpm test',
    });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-job-1', kind: 'test', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releaseTestPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exitCode).toBe(1);
  });

  it('returns ok:false with start_failed when startProjectTest is not ok', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'blocking-1',
    });
    const r = await releaseTestPhaseWorkflow('test-tt');
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'blocking-1',
    });
  });

  it('omits blockingJobId when start_failed has no blocker', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: false,
      status: 400,
      detail: 'no test command detected',
    });
    const r = await releaseTestPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: false,
      reason: 'start_failed',
      status: 400,
      detail: 'no test command detected',
    });
  });

  it('surfaces wait timeout via reason', async () => {
    startProjectTestMock.mockResolvedValue({
      ok: true,
      jobId: 'test-job-1',
      pid: 12345,
      logPath: '/tmp/test.log',
      testCmd: 'pnpm test',
    });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'test-job-1', kind: 'test', exitCode: null, finishedAt: null },
      finished: false,
      reason: 'timeout',
    });
    const r = await releaseTestPhaseWorkflow('test-tt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finished).toBe(false);
      expect(r.reason).toBe('timeout');
      expect(r.exitCode).toBeNull();
    }
  });
});

describe('test-phase source guards', () => {
  // Lock in 'use workflow' / 'use step' directives so a refactor can't
  // silently demote the workflow to a plain async function.
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/test-phase.ts'), 'utf-8');

  it("releaseTestPhaseWorkflow has a 'use workflow' directive", () => {
    const fnIndex = SRC.indexOf('export async function releaseTestPhaseWorkflow');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use workflow['"]/);
  });

  it("spawnTestStep has a 'use step' directive", () => {
    const fnIndex = SRC.indexOf('async function spawnTestStep');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use step['"]/);
  });

  it("awaitTestCompletionStep has a 'use step' directive", () => {
    const fnIndex = SRC.indexOf('async function awaitTestCompletionStep');
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    expect(after).toMatch(/['"]use step['"]/);
  });
});
