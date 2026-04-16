import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/job-storage';

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
        logDir: join(tempDir, 'logs'),
        projects: {},
      }),
    }));

    vi.doMock('@/lib/job-storage', () => ({
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

    const mod = await import('@/app/api/projects/by-project/[projectName]/test/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
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

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('passes auth with correct Bearer token', async () => {
    process.env.Z_API_TOKEN = 'my-token';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer my-token' },
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
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
});
