import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'fix-ci-job-id',
    project: 'proj1',
    kind: 'fix-ci',
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

describe('POST /api/projects/by-project/[projectName]/fix-ci', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let dbGetMock: ReturnType<typeof vi.fn>;

  const CI_URL = 'https://github.com/owner/repo/actions/runs/12345';

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(42);
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Build failed\nError: test suite failed', stderr: '' });

    dbGetMock = vi.fn().mockReturnValue({ project: 'proj1', ciFailedUrl: CI_URL });

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
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getPermissionModeFlag: vi.fn().mockReturnValue('') }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ get: dbGetMock }),
          }),
        }),
      },
      schema: { ghStatus: {} },
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/fix-ci/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns 409 when fix-ci already running', async () => {
    const runningJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([runningJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already in progress');
  });

  it('returns 400 when no failed CI URL exists', async () => {
    dbGetMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No failed CI URL');
  });

  it('returns 400 when no failed CI URL (no ciFailedUrl field)', async () => {
    dbGetMock.mockReturnValue({ project: 'proj1', ciFailedUrl: null });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when gh run view fails to fetch logs', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Could not fetch CI failure logs');
  });

  it('starts fix-ci job and returns job info', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.ci_url).toBe(CI_URL);
  });

  it('calls gh with the run ID extracted from the CI URL', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const ghCall = execMock.mock.calls.find((c: any[]) => c[0] === 'gh');
    expect(ghCall).toBeDefined();
    expect(ghCall![1]).toContain('12345');
    expect(ghCall![1]).toContain('--log-failed');
  });

  it('skips running jobs that are not actually running', async () => {
    const staleJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([staleJob]);
    probeJobStatusMock.mockResolvedValue('done');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
  });

  it('persists job failure when startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('pm2 unavailable'));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 unavailable');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });
});
