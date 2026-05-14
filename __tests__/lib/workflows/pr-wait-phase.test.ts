import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const launchPrWaitMock = vi.fn();
const waitForJobCompletionMock = vi.fn();

vi.mock('@/lib/pipeline/start-pr-wait', () => ({
  launchPrWait: (...args: unknown[]) => launchPrWaitMock(...args),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...args: unknown[]) => waitForJobCompletionMock(...args),
}));

import { releasePrWaitPhaseWorkflow } from '@/lib/workflows/phases/pr-wait-phase';

const PR = {
  number: 42,
  repo: '3h4x/test-tt',
  url: 'https://github.com/3h4x/test-tt/pull/42',
};

describe('releasePrWaitPhaseWorkflow', () => {
  beforeEach(() => {
    launchPrWaitMock.mockReset();
    waitForJobCompletionMock.mockReset();
  });

  it('reports merged:true when wait finishes with exitCode 0', async () => {
    launchPrWaitMock.mockResolvedValue({ jobId: 'prw-1' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'prw-1', kind: 'pr-wait', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releasePrWaitPhaseWorkflow('test-tt', PR.number, PR.repo, PR.url);
    expect(launchPrWaitMock).toHaveBeenCalledWith('test-tt', 42, PR.repo, PR.url);
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('prw-1', expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(r).toEqual({
      ok: true,
      jobId: 'prw-1',
      finished: true,
      merged: true,
      reason: 'finished',
      exitCode: 0,
    });
  });

  it('reports merged:false when wait finishes with non-zero exit code', async () => {
    launchPrWaitMock.mockResolvedValue({ jobId: 'prw-2' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'prw-2', kind: 'pr-wait', exitCode: 1, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    const r = await releasePrWaitPhaseWorkflow('test-tt', PR.number, PR.repo, PR.url);
    if (r.ok) {
      expect(r.merged).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.finished).toBe(true);
    }
  });

  it('reports merged:false when wait did not finish (timeout)', async () => {
    launchPrWaitMock.mockResolvedValue({ jobId: 'prw-3' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'prw-3', kind: 'pr-wait', exitCode: null, finishedAt: null },
      finished: false,
      reason: 'timeout',
    });
    const r = await releasePrWaitPhaseWorkflow('test-tt', PR.number, PR.repo, PR.url);
    if (r.ok) {
      expect(r.merged).toBe(false);
      expect(r.finished).toBe(false);
      expect(r.reason).toBe('timeout');
    }
  });

  it('returns launch_failed when launchPrWait errors (no jobId)', async () => {
    launchPrWaitMock.mockResolvedValue({ error: 'project not found' });
    const r = await releasePrWaitPhaseWorkflow('missing', PR.number, PR.repo, PR.url);
    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      reason: 'launch_failed',
      error: 'project not found',
    });
  });

  it('passes a 60-minute wait ceiling to waitForJobCompletion (pr-wait runs up to 30m)', async () => {
    launchPrWaitMock.mockResolvedValue({ jobId: 'prw-4' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'prw-4', kind: 'pr-wait', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    await releasePrWaitPhaseWorkflow('test-tt', PR.number, PR.repo, PR.url);
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('prw-4', { timeoutMs: 60 * 60 * 1000 });
  });

  it('forwards all PR identity args (number/repo/url) to launchPrWait verbatim', async () => {
    launchPrWaitMock.mockResolvedValue({ jobId: 'prw-5' });
    waitForJobCompletionMock.mockResolvedValue({
      job: { id: 'prw-5', kind: 'pr-wait', exitCode: 0, finishedAt: 100 },
      finished: true,
      reason: 'finished',
    });
    await releasePrWaitPhaseWorkflow('proj-x', 99, 'owner/repo', 'https://example/pr/99');
    expect(launchPrWaitMock).toHaveBeenCalledWith('proj-x', 99, 'owner/repo', 'https://example/pr/99');
  });
});

describe('pr-wait-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/pr-wait-phase.ts'), 'utf-8');
  it.each([
    'export async function releasePrWaitPhaseWorkflow',
    'async function launchPrWaitStep',
    'async function awaitPrWaitCompletionStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
