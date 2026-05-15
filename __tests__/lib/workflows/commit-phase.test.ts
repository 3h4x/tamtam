import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startProjectCommitMock = vi.fn();

vi.mock('@/lib/pipeline/start-commit', () => ({
  startProjectCommit: (...args: unknown[]) => startProjectCommitMock(...args),
}));

import { releaseCommitPhaseWorkflow } from '@/lib/workflows/phases/commit-phase';

describe('releaseCommitPhaseWorkflow', () => {
  beforeEach(() => {
    startProjectCommitMock.mockReset();
  });

  it('returns ok with commitSha + message', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: true,
      commitSha: 'abc1234',
      message: 'fix: address review findings',
    });
    const r = await releaseCommitPhaseWorkflow('test-tt');
    expect(startProjectCommitMock).toHaveBeenCalledWith('test-tt', {});
    expect(r).toEqual({
      ok: true,
      commitSha: 'abc1234',
      message: 'fix: address review findings',
    });
  });

  it('surfaces optional jobId when present', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: true,
      commitSha: 'def5678',
      message: 'commit message',
      jobId: 'commit-job-1',
    });
    const r = await releaseCommitPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: true,
      commitSha: 'def5678',
      message: 'commit message',
      jobId: 'commit-job-1',
    });
  });

  it('omits jobId when CommitResult does not include one', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: true,
      commitSha: 'aaa',
      message: 'ok',
    });
    const r = await releaseCommitPhaseWorkflow('test-tt');
    if (r.ok) expect('jobId' in r).toBe(false);
  });

  it('forwards parentJobId option to startProjectCommit', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: true,
      commitSha: 'aaa',
      message: 'ok',
    });
    await releaseCommitPhaseWorkflow('test-tt', { parentJobId: 'release-7' });
    expect(startProjectCommitMock).toHaveBeenCalledWith('test-tt', { parentJobId: 'release-7' });
  });

  it('returns ok:false with commit_failed when startProjectCommit errors', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: false,
      status: 500,
      detail: 'git commit refused: empty change set',
    });
    const r = await releaseCommitPhaseWorkflow('test-tt');
    expect(r).toEqual({
      ok: false,
      reason: 'commit_failed',
      status: 500,
      detail: 'git commit refused: empty change set',
    });
  });

  it('preserves blockingJobId from start failure', async () => {
    startProjectCommitMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running for test-tt',
      blockingJobId: 'block-3',
    });
    const r = await releaseCommitPhaseWorkflow('test-tt');
    if (!r.ok) expect(r.blockingJobId).toBe('block-3');
  });
});

describe('commit-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/commit-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseCommitPhaseWorkflow',
    'async function commitStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
