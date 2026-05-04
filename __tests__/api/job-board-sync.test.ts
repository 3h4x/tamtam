import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/jobs/[jobId]/board-sync', () => {
  const getJobMock = vi.fn();
  const syncJobToProjectBoardMock = vi.fn();
  let POST: typeof import('@/app/api/jobs/[jobId]/board-sync/route').POST;

  beforeEach(async () => {
    vi.resetModules();
    getJobMock.mockReset();
    syncJobToProjectBoardMock.mockReset();
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
    }));
    vi.doMock('@/lib/github/project-board', () => ({
      syncJobToProjectBoard: syncJobToProjectBoardMock,
    }));
    POST = (await import('@/app/api/jobs/[jobId]/board-sync/route')).POST;
  });

  it('returns 404 when the job does not exist', async () => {
    getJobMock.mockReturnValue(null);
    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(404);
  });

  it('re-syncs an existing job', async () => {
    const job = { id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 };
    getJobMock.mockReturnValue(job);

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(200);
    expect(syncJobToProjectBoardMock).toHaveBeenCalledWith(job, 'manual', { requireConfigured: true });
  });

  it('rejects running jobs', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: null, exitCode: null });

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ detail: 'Only finished jobs can be synced manually.' });
    expect(syncJobToProjectBoardMock).not.toHaveBeenCalled();
  });

  it('surfaces configuration errors', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 });
    syncJobToProjectBoardMock.mockRejectedValueOnce(new Error('GitHub board sync is disabled.'));

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ detail: 'GitHub board sync is disabled.' });
  });

  it('surfaces downstream sync failures', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 });
    syncJobToProjectBoardMock.mockRejectedValueOnce(new Error('gh project item-edit failed'));

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ detail: 'gh project item-edit failed' });
  });
});
