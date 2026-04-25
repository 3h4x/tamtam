import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/jobs/[jobId]/seen', () => {
  let POST: any;
  let markSeenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    markSeenMock = vi.fn().mockReturnValue(true);

    vi.doMock('@/lib/job-storage', () => ({
      markSeen: markSeenMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns ok when job exists', async () => {
    markSeenMock.mockReturnValue(true);
    const req = new NextRequest('http://localhost/api/jobs/job-123/seen', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('returns 404 when job not found', async () => {
    markSeenMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/jobs/missing-job/seen', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'missing-job' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('missing-job');
  });

  it('calls markSeen with correct jobId', async () => {
    const req = new NextRequest('http://localhost/api/jobs/my-job/seen', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ jobId: 'my-job' }) });
    expect(markSeenMock).toHaveBeenCalledWith('my-job');
    expect(markSeenMock).toHaveBeenCalledTimes(1);
  });
});
