import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-source',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/jobs/{jobId}/rerun', () => {
  let POST: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);
    createJobMock = vi.fn().mockImplementation(() =>
      makeJob({ id: 'job-new', finishedAt: null, exitCode: null })
    );
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(9999);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (request: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/job-storage', () => ({
      getJob: getJobMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
      }),
    }));

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/rerun/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('returns 404 when source job does not exist', async () => {
    getJobMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 404 when project path cannot be resolved', async () => {
    getJobMock.mockReturnValue(makeJob({ project: 'missing-proj' }));
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('missing-proj');
  });

  it('starts a new job and returns status=started', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
  });

  it('calls startJob once', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
  });

  it('calls updateJob after startJob', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(updateJobMock).toHaveBeenCalledOnce();
  });

  it('returns 500 when startJob throws', async () => {
    getJobMock.mockReturnValue(makeJob());
    startJobMock.mockRejectedValue(new Error('pm2 failed'));
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 failed');
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(401);
  });

  it('passes auth with correct Bearer token', async () => {
    process.env.Z_API_TOKEN = 'my-token';
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
      headers: { Authorization: 'Bearer my-token' },
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
  });
});
