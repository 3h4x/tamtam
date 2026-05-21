import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('POST /api/jobs/notifications/mark-seen', () => {
  let POST: typeof import('@/app/api/jobs/notifications/mark-seen/route').POST;
  let markAllUnseenFinishedMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    markAllUnseenFinishedMock = vi.fn();

    vi.doMock('@/lib/jobs/job-storage', () => ({
      markAllUnseenFinished: markAllUnseenFinishedMock,
    }));

    const mod = await import('@/app/api/jobs/notifications/mark-seen/route');
    POST = mod.POST;
  });

  it('returns 200 with the number of jobs flipped', async () => {
    markAllUnseenFinishedMock.mockReturnValue(3);
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'ok', marked: 3 });
  });

  it('reports zero when the backlog is empty', async () => {
    markAllUnseenFinishedMock.mockReturnValue(0);
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.marked).toBe(0);
  });

  it('invokes the bulk primitive exactly once per request (no per-row loop)', async () => {
    // Regression guard: prior implementation called markSeen(id) for every
    // unseen-finished row, which scaled linearly with the backlog. The
    // bulk replacement must NOT re-introduce that loop.
    markAllUnseenFinishedMock.mockReturnValue(50);
    await POST();
    expect(markAllUnseenFinishedMock).toHaveBeenCalledTimes(1);
  });
});
