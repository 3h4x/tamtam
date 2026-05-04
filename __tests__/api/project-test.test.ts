import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'test-job-id',
    project: 'proj1',
    kind: 'test',
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

function makeMockProcess() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe('POST /api/projects/by-project/{projectName}/test', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let tempDir: string;
  let projDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-test-route-'));
    projDir = mkdtempSync(join(tmpdir(), 'tamtam-proj-'));

    // Create a package.json with test script to trigger npm test detection
    writeFileSync(
      join(projDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } })
    );

    resolveProjectPathMock = vi.fn().mockReturnValue(projDir);
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();

    const mockProc = makeMockProcess();
    spawnMock = vi.fn().mockReturnValue(mockProc);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: join(tempDir, 'logs'),
        projects: {},
      }),
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));

    vi.doMock('child_process', async () => {
      const actual = await vi.importActual('child_process');
      return {
        ...actual,
        spawn: spawnMock,
      };
    });

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
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/test/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns 400 when test command cannot be detected', async () => {
    // projDir has no package.json/pyproject.toml/foundry.toml
    const emptyDir = mkdtempSync(join(tmpdir(), 'tamtam-empty-proj-'));
    resolveProjectPathMock.mockReturnValue(emptyDir);

    try {
      const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('detect test command');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when tests already running', async () => {
    const runningJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([runningJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already running');
  });

  it('starts test job and returns job info', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.log_path).toBeTruthy();
    expect(data.test_cmd).toBeTruthy();
  });

  it('detects pnpm test when pnpm-lock.yaml exists', async () => {
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.test_cmd).toBe('pnpm test');
  });

  it('detects npm test when no pnpm-lock.yaml', async () => {
    // projDir has package.json but no pnpm-lock.yaml
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.test_cmd).toBe('npm test');
  });

  it('returns 409 with blocking_job_id when pipeline is locked', async () => {
    vi.resetModules();
    const newProjDir = mkdtempSync(join(tmpdir(), 'tamtam-locked-proj-'));
    writeFileSync(join(newProjDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));

    try {
      const mockProc = makeMockProcess();
      vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(newProjDir) }));
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: join(tempDir, 'logs'), projects: {} }),
      }));
      vi.doMock('@/lib/jobs/job-storage', () => ({
        createJob: vi.fn().mockImplementation(() => makeJob()),
        updateJob: vi.fn(),
        listJobs: vi.fn().mockReturnValue([]),
        probeJobStatus: vi.fn().mockResolvedValue('done'),
      }));
      vi.doMock('child_process', async () => {
        const actual = await vi.importActual('child_process');
        return { ...actual, spawn: vi.fn().mockReturnValue(mockProc) };
      });
      vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
        getLock: vi.fn().mockReturnValue({ project: 'proj1', lockedByJobId: 'blocker-123', acquiredAt: Date.now() / 1000 }),
        acquireLock: vi.fn().mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocker-123' }),
        isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      }));

      const mod = await import('@/app/api/projects/by-project/[projectName]/test/route');
      const lockedPOST = mod.POST;

      const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', { method: 'POST' });
      const res = await lockedPOST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.blocking_job_id).toBe('blocker-123');
    } finally {
      rmSync(newProjDir, { recursive: true, force: true });
    }
  });
});
