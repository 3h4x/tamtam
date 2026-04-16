import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'review-job-id',
    project: 'proj1',
    kind: 'review',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/projects/by-project/{projectName}/review', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(12345);
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'M file.ts\n', stderr: '' });

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

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
        projects: {},
      }),
    }));

    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));

    vi.doMock('@/lib/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/shell', () => ({
      exec: execMock,
    }));

    vi.doMock('@/lib/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/skill.md',
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/review/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('not found');
  });

  it('returns 400 when no uncommitted changes', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No uncommitted changes');
  });

  it('returns 409 when review already in progress', async () => {
    const runningJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([runningJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already in progress');
  });

  it('starts a review job and returns job info', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.log_path).toBeTruthy();
  });

  it('calls startJob once', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
  });

  it('returns 500 when startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('pm2 start failed'));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 start failed');
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('passes auth with correct Bearer token', async () => {
    process.env.Z_API_TOKEN = 'my-token';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
      headers: { Authorization: 'Bearer my-token' },
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
  });

  it('skips finished jobs when checking for running reviews', async () => {
    const finishedJob = makeJob({ finishedAt: Date.now() / 1000, exitCode: 0 });
    listJobsMock.mockReturnValue([finishedJob]);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    // Finished jobs should not block a new review
    expect(res.status).toBe(200);
  });
});
