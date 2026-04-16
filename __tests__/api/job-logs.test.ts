import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LogFrame } from '@/lib/log-persistence';

describe('GET /api/jobs/{jobId}/logs', () => {
  let GET: any;
  let readJobLogsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    readJobLogsMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/log-persistence', () => ({
      readJobLogs: readJobLogsMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/logs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty logs array when no logs exist', async () => {
    readJobLogsMock.mockReturnValue([]);
    const req = new NextRequest('http://localhost/api/jobs/job-123/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.logs).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('returns log frames with count', async () => {
    const frames: LogFrame[] = [
      { type: 'text', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'text', content: 'World', timestamp: '2024-01-01T00:00:01Z' },
    ];
    readJobLogsMock.mockReturnValue(frames);

    const req = new NextRequest('http://localhost/api/jobs/job-456/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-456' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.logs).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.logs[0].content).toBe('Hello');
    expect(data.logs[1].content).toBe('World');
  });

  it('calls readJobLogs with correct jobId', async () => {
    const req = new NextRequest('http://localhost/api/jobs/my-job/logs');
    await GET(req, { params: Promise.resolve({ jobId: 'my-job' }) });
    expect(readJobLogsMock).toHaveBeenCalledWith('my-job');
  });

  it('returns error when readJobLogs throws', async () => {
    readJobLogsMock.mockImplementation(() => {
      throw new Error('disk error');
    });
    const req = new NextRequest('http://localhost/api/jobs/bad-job/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'bad-job' }) });
    const data = await res.json();
    expect(data.logs).toBeNull();
    expect(data.error).toContain('disk error');
  });
});
