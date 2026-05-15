import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'review-pr-job-id',
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

describe('POST /api/projects/by-project/{projectName}/review-pr', () => {
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
    execMock = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'diff --git a/f.ts b/f.ts\n+ new line\n',
      stderr: '',
    });

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
      splitCommand: (line: string) => line.split(/\s+/).filter(Boolean),
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobMock,
    }));

    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));

    vi.doMock('@/lib/skills/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/skill.md',
    }));

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/review-pr/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function makeReq(
    projectName: string,
    body: Record<string, unknown> = { prNumber: 42, prTitle: 'Test', headRef: 'feat', baseRef: 'main' },
  ) {
    return new NextRequest(`http://localhost/api/projects/by-project/${projectName}/review-pr`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns 400 when prNumber is missing', async () => {
    const req = makeReq('proj1', { prTitle: 'x', headRef: 'a', baseRef: 'b' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('prNumber');
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = makeReq('unknown');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('not found');
  });

  it('returns 400 when PR diff is empty', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const req = makeReq('proj1');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No diff');
  });

  it('returns 409 when a review is already in progress', async () => {
    const runningJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([runningJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const req = makeReq('proj1');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already in progress');
  });

  it('starts a PR review job and returns job info', async () => {
    const req = makeReq('proj1');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.log_path).toBeTruthy();
    expect(startJobMock).toHaveBeenCalledOnce();
  });

  it('returns 500 when startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('pm2 start failed'));
    const req = makeReq('proj1');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 start failed');
  });

  it('skips finished jobs when checking for running reviews', async () => {
    const finishedJob = makeJob({ finishedAt: Date.now() / 1000, exitCode: 0 });
    listJobsMock.mockReturnValue([finishedJob]);

    const req = makeReq('proj1');
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
  });
});
