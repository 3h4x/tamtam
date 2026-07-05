import { describe, it, expect, vi, beforeEach } from 'vitest';

// The gate reads one setting row + shells out to `gh`. Mock the DB chain (as
// dispatch-auto-fix-ci.test.ts does), stub the default-branch resolver, and the
// gh call; the CI verdict fold (summarizeDefaultBranchCi) runs for real.
// Hoisted holder so the (hoisted) vi.mock factories can reference it.
const h = vi.hoisted(() => ({ settingValue: 'true' as string | undefined, execMock: vi.fn() }));

vi.mock('@/lib/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (h.settingValue === undefined ? [] : [{ value: h.settingValue }]),
  };
  return { db: chain, schema: { settings: { key: 'key' } } };
});
vi.mock('@/lib/git/git-branch', () => ({ getDefaultBranchSync: () => 'main' }));
vi.mock('@/lib/shared/shell', () => ({ exec: h.execMock }));

import { isDefaultBranchCiRed, isCiDispatchGateEnabled } from '@/lib/jobs/ci-dispatch-gate';

const jsonRuns = (arr: unknown) => JSON.stringify(arr);
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });

describe('isDefaultBranchCiRed', () => {
  beforeEach(() => {
    h.settingValue = 'true';
    h.execMock.mockReset();
  });

  it('returns not-red and never calls gh when the gate is disabled', async () => {
    h.settingValue = 'false';
    const r = await isDefaultBranchCiRed('/p');
    expect(r).toEqual({ red: false, failedUrl: null });
    expect(h.execMock).not.toHaveBeenCalled();
  });

  it('returns not-red when the gate setting is unset (default off)', async () => {
    h.settingValue = undefined;
    const r = await isDefaultBranchCiRed('/p');
    expect(r.red).toBe(false);
    expect(h.execMock).not.toHaveBeenCalled();
  });

  it('is red when ANY default-branch workflow failed (a red Deploy, green tests)', async () => {
    h.execMock.mockResolvedValue(ok(jsonRuns([
      { workflowName: 'Release', status: 'completed', conclusion: 'success', url: 'u1' },
      { workflowName: 'Deploy', status: 'completed', conclusion: 'failure', url: 'u2' },
    ])));
    const r = await isDefaultBranchCiRed('/p');
    expect(r).toEqual({ red: true, failedUrl: 'u2' });
    // queried the DEFAULT branch from the project path
    expect(h.execMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['run', 'list', '--branch', 'main']),
      expect.objectContaining({ cwd: '/p' }),
    );
  });

  it('is not red when every default-branch workflow is green', async () => {
    h.execMock.mockResolvedValue(ok(jsonRuns([
      { workflowName: 'Release', status: 'completed', conclusion: 'success', url: 'u1' },
      { workflowName: 'Deploy', status: 'completed', conclusion: 'success', url: 'u2' },
    ])));
    const r = await isDefaultBranchCiRed('/p');
    expect(r.red).toBe(false);
  });

  it('fails OPEN (not red) when gh exits non-zero', async () => {
    h.execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'gh boom' });
    const r = await isDefaultBranchCiRed('/p');
    expect(r.red).toBe(false);
  });

  it('fails OPEN when gh throws', async () => {
    h.execMock.mockRejectedValue(new Error('spawn ENOENT'));
    const r = await isDefaultBranchCiRed('/p');
    expect(r.red).toBe(false);
  });
});

describe('isCiDispatchGateEnabled', () => {
  it('reflects the setting row value', async () => {
    h.settingValue = 'true';
    expect(await isCiDispatchGateEnabled()).toBe(true);
    h.settingValue = 'false';
    expect(await isCiDispatchGateEnabled()).toBe(false);
    h.settingValue = undefined;
    expect(await isCiDispatchGateEnabled()).toBe(false);
  });
});
