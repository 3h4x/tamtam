import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-source',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: '/path/to/log',
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/jobs/[jobId]/fix', () => {
  let POST: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let readParsedLogMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-fix-test-'));

    getJobMock = vi.fn().mockReturnValue(null);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    readParsedLogMock = vi.fn().mockReturnValue('Error: something failed\nline 2');
    createJobMock = vi.fn().mockImplementation(() =>
      makeJob({ id: 'fix-job-1', kind: 'fix', pid: 0, logPath: null, finishedAt: null, exitCode: null })
    );
    updateJobMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      probeJobStatus: probeJobStatusMock,
      readParsedLog: readParsedLogMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      markDone: vi.fn(),
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: join(tempDir, 'logs'),
      }),
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    // Mock child_process.spawn so we don't actually launch claude
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      const mockProc = {
        pid: 99999,
        stdin: { write: vi.fn(), end: vi.fn() },
        on: vi.fn(),
        unref: vi.fn(),
      };
      return { ...actual, spawn: vi.fn().mockReturnValue(mockProc) };
    });

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/fix/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 for nonexistent job', async () => {
    getJobMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 400 if job is still running', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: null, exitCode: null }));
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('still running');
  });

  it('returns 400 if log output is empty', async () => {
    getJobMock.mockReturnValue(makeJob());
    readParsedLogMock.mockReturnValue('   ');

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No output');
  });

  it('returns 404 if project path not found', async () => {
    getJobMock.mockReturnValue(makeJob());
    resolveProjectPathMock.mockReturnValue(null);

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('starts fix job and returns job info', async () => {
    getJobMock.mockReturnValue(makeJob());

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.pid).toBeDefined();
  });

  it('calls createJob and updateJob', async () => {
    getJobMock.mockReturnValue(makeJob());

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(createJobMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalledOnce();
  });
});
