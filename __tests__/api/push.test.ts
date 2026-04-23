import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/push', () => {
  let POST: any;
  let launchProjectPushMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    launchProjectPushMock = vi.fn().mockReturnValue({ jobId: 'test-job-id' });
    vi.doMock('@/lib/start-push', () => ({ launchProjectPush: launchProjectPushMock }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/push/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when launchProjectPush returns an error', async () => {
    launchProjectPushMock.mockReturnValue({ error: 'project not found' });
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns started status with job_id when launch succeeds', async () => {
    launchProjectPushMock.mockReturnValue({ jobId: 'abc-123' });
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBe('abc-123');
  });

  it('calls launchProjectPush with the project name from params', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo');
  });
});
