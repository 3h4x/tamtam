import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';

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

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
        projects: {},
      }),
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));

    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));

    vi.doMock('@/lib/skills/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/skill.md',
    }));

    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj1', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/review/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
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

  it('returns 409 with blocking_job_id when pipeline is locked', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/project'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp/tamtam-logs', projects: {} }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn().mockImplementation(() => makeJob()),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: vi.fn().mockResolvedValue(12345) }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'M file.ts\n', stderr: '' }),
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/skill.md' }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue({ project: 'proj1', lockedByJobId: 'blocker-job-99', acquiredAt: Date.now() / 1000 }),
      acquireLock: vi.fn().mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocker-job-99' }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/review/route');
    const lockedPOST = mod.POST;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/review', { method: 'POST' });
    const res = await lockedPOST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.blocking_job_id).toBe('blocker-job-99');
  });
});
