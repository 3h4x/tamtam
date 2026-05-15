import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startProjectPushMock = vi.fn();

vi.mock('@/lib/pipeline/start-push', () => ({
  startProjectPush: (...args: unknown[]) => startProjectPushMock(...args),
}));

import { releasePushPhaseWorkflow } from '@/lib/workflows/phases/push-phase';

describe('releasePushPhaseWorkflow', () => {
  beforeEach(() => {
    startProjectPushMock.mockReset();
  });

  it('returns ok with commitSha + message on a clean push (no PR)', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: true,
      commitSha: 'abc1234',
      message: 'Pushed test-tt (abc1234)',
    });
    const r = await releasePushPhaseWorkflow('test-tt');
    expect(startProjectPushMock).toHaveBeenCalledWith('test-tt', {});
    expect(r).toEqual({
      ok: true,
      commitSha: 'abc1234',
      message: 'Pushed test-tt (abc1234)',
    });
  });

  it('surfaces PR metadata when push opens or reuses one', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: true,
      commitSha: 'def5678',
      message: 'Pushed feature branch with PR',
      prUrl: 'https://github.com/3h4x/test-tt/pull/42',
      prNumber: 42,
      prRepo: '3h4x/test-tt',
    });
    const r = await releasePushPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: true,
      commitSha: 'def5678',
      message: 'Pushed feature branch with PR',
      prUrl: 'https://github.com/3h4x/test-tt/pull/42',
      prNumber: 42,
      prRepo: '3h4x/test-tt',
    });
  });

  it('forwards parentJobId option to startProjectPush', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: true,
      commitSha: 'aaa',
      message: 'ok',
    });
    await releasePushPhaseWorkflow('test-tt', { parentJobId: 'release-1' });
    expect(startProjectPushMock).toHaveBeenCalledWith('test-tt', { parentJobId: 'release-1' });
  });

  it('omits PR fields when missing', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: true,
      commitSha: 'aaa',
      message: 'ok',
    });
    const r = await releasePushPhaseWorkflow('test-tt');
    if (r.ok) {
      expect('prUrl' in r).toBe(false);
      expect('prNumber' in r).toBe(false);
      expect('prRepo' in r).toBe(false);
    }
  });

  it('returns ok:false with push_failed when push errors out', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: false,
      status: 500,
      detail: 'git push: rejected (hook)',
    });
    const r = await releasePushPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: false,
      reason: 'push_failed',
      status: 500,
      detail: 'git push: rejected (hook)',
    });
  });

  it('preserves blockingJobId from start failure', async () => {
    startProjectPushMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'block-1',
    });
    const r = await releasePushPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: false,
      reason: 'push_failed',
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'block-1',
    });
  });
});

describe('push-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/push-phase.ts'), 'utf-8');
  it.each([
    'export async function releasePushPhaseWorkflow',
    'async function pushStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
