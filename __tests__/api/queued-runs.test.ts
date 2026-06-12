import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { QueuedTerminalRun } from '@/lib/terminal/pending-terminal-run';

const state = vi.hoisted(() => ({
  fns: {
    getQueuedTerminalRun: vi.fn(),
    cancelQueuedTerminalRun: vi.fn(),
  },
}));

vi.mock('@/lib/terminal/pending-terminal-run', () => ({
  getQueuedTerminalRun: (...args: unknown[]) => state.fns.getQueuedTerminalRun(...args),
  cancelQueuedTerminalRun: (...args: unknown[]) => state.fns.cancelQueuedTerminalRun(...args),
}));

const routeModulePromise = import('@/app/api/projects/by-project/[projectName]/queued-runs/[queueId]/route');

function entry(overrides: Partial<QueuedTerminalRun> = {}): QueuedTerminalRun {
  return {
    id: 'q-1',
    project: 'proj1',
    enqueuedAt: 1,
    payload: { prompt: 'hi' },
    status: 'pending',
    startedJobId: null,
    ...overrides,
  };
}

describe('GET/DELETE /api/projects/by-project/{projectName}/queued-runs/{queueId}', () => {
  let GET: Awaited<typeof routeModulePromise>['GET'];
  let DELETE: Awaited<typeof routeModulePromise>['DELETE'];

  beforeEach(async () => {
    state.fns.getQueuedTerminalRun.mockReset();
    state.fns.cancelQueuedTerminalRun.mockReset().mockResolvedValue(true);
    const mod = await routeModulePromise;
    GET = mod.GET;
    DELETE = mod.DELETE;
  });

  const params = (queueId = 'q-1', projectName = 'proj1') =>
    ({ params: Promise.resolve({ projectName, queueId }) });

  it('reports pending status', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(entry());
    const res = await GET(new NextRequest('http://localhost/x'), params());
    await expect(res.json()).resolves.toEqual({ status: 'pending', jobId: null });
  });

  it('reports started status with the job id', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(entry({ status: 'started', startedJobId: 'job-9' }));
    const res = await GET(new NextRequest('http://localhost/x'), params());
    await expect(res.json()).resolves.toEqual({ status: 'started', jobId: 'job-9' });
  });

  it('reports gone when the queue row no longer exists', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(null);
    const res = await GET(new NextRequest('http://localhost/x'), params());
    await expect(res.json()).resolves.toEqual({ status: 'gone', jobId: null });
  });

  it('reports gone when the queue row belongs to another project', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(entry({ project: 'other' }));
    const res = await GET(new NextRequest('http://localhost/x'), params());
    await expect(res.json()).resolves.toEqual({ status: 'gone', jobId: null });
  });

  it('cancels a pending run', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(entry());
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), params());
    await expect(res.json()).resolves.toEqual({ cancelled: true });
    expect(state.fns.cancelQueuedTerminalRun).toHaveBeenCalledWith('q-1');
  });

  it('refuses to cancel a row from another project', async () => {
    state.fns.getQueuedTerminalRun.mockResolvedValue(entry({ project: 'other' }));
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), params());
    expect(res.status).toBe(404);
    expect(state.fns.cancelQueuedTerminalRun).not.toHaveBeenCalled();
  });
});
