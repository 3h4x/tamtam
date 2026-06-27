import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('GET /api/projects/by-project/{projectName}/release/plan', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/release/plan/route').GET;
  let computeReleasePlanMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    computeReleasePlanMock = vi.fn();
    vi.doMock('@/lib/pipeline/release-plan', () => ({ computeReleasePlan: computeReleasePlanMock }));
    ({ GET } = await import('@/app/api/projects/by-project/[projectName]/release/plan/route'));
  });

  const call = (name = 'proj1') =>
    GET(new Request(`http://localhost/api/projects/by-project/${name}/release/plan`), {
      params: Promise.resolve({ projectName: name }),
    });

  it('returns the computed plan as JSON', async () => {
    const plan = {
      project: 'proj1',
      canRelease: true,
      blockers: [],
      mode: 'direct',
      currentBranch: 'main',
      targetBranch: 'main',
      comparisonRange: 'origin/main..HEAD',
      entryStep: 'test',
      steps: [{ kind: 'test', willRun: true, reason: 'Run tests', sideEffects: [] }],
    };
    computeReleasePlanMock.mockResolvedValue(plan);

    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(plan);
  });

  it('returns 404 when the planner reports a not_found blocker', async () => {
    computeReleasePlanMock.mockResolvedValue({
      project: 'ghost',
      canRelease: false,
      blockers: [{ code: 'not_found', detail: 'project not found' }],
      mode: 'direct',
      currentBranch: '',
      targetBranch: '',
      comparisonRange: null,
      entryStep: null,
      steps: [],
    });

    const res = await call('ghost');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'project not found' });
  });

  it('returns 500 when the planner throws', async () => {
    computeReleasePlanMock.mockRejectedValue(new Error('boom'));
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toMatch(/boom/);
  });
});
